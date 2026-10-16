import fs from "node:fs";
import nodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDoctorConfigSnapshot } from "../commands/doctor-config-snapshot.test-helpers.js";
import { ConfigWritePostCommitError } from "../config/io.write-errors.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { LegacyStateMigrationStepReceipt } from "../infra/state-migrations.types.js";
import { fetchNpmPackageTargetStatus } from "../infra/update-check-package-target.js";
import { buildUpdateRehearsalPathEnv } from "../infra/update-rehearsal-paths.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { CORE_HEALTH_CHECKS } from "./doctor-core-checks.js";
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import { resolveDoctorContributionHealthChecks } from "./doctor-health-contributions.js";
import {
  createDoctorConfigFixture,
  createDoctorHealthFlowContext,
  createDoctorLintContext,
  createDoctorPrompterFixture,
  createGatewayWriterFixture,
  resolveDoctorHealthContributions,
  runDoctorHealthContributionList,
} from "./doctor-health-contributions.test-support.js";
import { runDoctorLintChecks } from "./doctor-lint-flow.js";
import {
  clearHealthChecksForTest,
  getHealthCheck,
  registerHealthCheck,
} from "./health-check-registry.js";
import type { HealthCheck, HealthFinding } from "./health-checks.js";

const mocks = vi.hoisted(() => ({
  isDefaultInstallIdentity: vi.fn(() => true),
  isContainerEnvironment: vi.fn(() => false),
  maybeRunConfiguredPluginInstallReleaseStep: vi.fn(),
  registerBundledHealthChecks: vi.fn((): HealthFinding[] => []),
  runDoctorHealthRepairs: vi.fn(),
  maybeMigrateAuthProfileJsonStoresToSqlite: vi.fn<() => Promise<unknown>>(async () => ({
    detected: [],
    changes: [],
    migratedProfileIds: new Set<string>(),
    blockedProfileIds: new Set<string>(),
    warnings: [],
  })),
  collectOpenAICodexAuthProfileStoreIdMap: vi.fn(() => new Map<string, string>()),
  maybeRepairOpenAICodexAuthConfig: vi.fn((cfg: unknown) => ({
    config: cfg,
    changes: [],
    warnings: [],
  })),
  maybeMigrateLegacyPluginModelCatalogs: vi.fn<() => Promise<unknown>>(async () => ({
    detected: 0,
    migrated: 0,
    warnings: [],
  })),
  maybeMigrateModelCatalogCredentials: vi.fn(async () => ({
    detected: 0,
    migrated: 0,
    warnings: [],
  })),
  maybeRepairGatewayDaemon: vi.fn<() => Promise<unknown>>(async () => undefined),
  maybeRepairLegacyOAuthProfileIds: vi.fn(async (cfg: unknown) => ({
    config: cfg,
    retiredProfileCleanupPlans: [] as Array<{
      agentDir?: string;
      profileIds: readonly string[];
    }>,
  })),
  removeAuthProfilesAcrossOwnerStores: vi.fn(async () => true),
  collectAuthProfileHealthFindings: vi.fn(async () => []),
  noteAuthProfileHealth: vi.fn<() => Promise<unknown>>(async () => undefined),
  noteCopilotAmbientToken: vi.fn(),
  noteLegacyCodexProviderOverride: vi.fn(),
  noteSharedAuthStoreStatus: vi.fn(),
  noteMemorySearchHealth: vi.fn<() => Promise<unknown>>(async () => undefined),
  collectMemorySearchHealthFindings: vi.fn<() => Promise<readonly HealthFinding[]>>(async () => []),
  noteWebFetchProxyDiagnostic: vi.fn<() => Promise<unknown>>(async () => undefined),
  buildGatewayConnectionDetails: vi.fn(() => ({ message: "gateway details" })),
  callGateway: vi.fn(),
  resolveSecretInputRef: vi.fn((params: { value?: unknown }) => ({
    ref:
      params.value === "exec-token"
        ? { source: "exec", command: "printf token", cache: false }
        : undefined,
  })),
  resolveGatewayAuth: vi.fn<() => { mode: string; token?: string }>(() => ({
    mode: "token",
    token: undefined,
  })),
  resolveGatewayAuthToken: vi.fn<
    () => Promise<{ source: string; token?: string; unresolvedRefReason?: string }>
  >(async () => ({ source: "unavailable", unresolvedRefReason: "exec provider failed" })),
  getSkippedExecRefStaticError: vi.fn(() => undefined),
  maybeRepairGatewayServiceConfig: vi.fn().mockResolvedValue(undefined),
  maybeScanExtraGatewayServices: vi.fn<() => Promise<unknown>>(async () => undefined),
  maybeResolveDuelingSystemdGatewayScopes: vi.fn().mockResolvedValue(undefined),
  noteMacGatewayPlatformWarnings: vi.fn(),
  noteMacDisabledGatewayLaunchAgent: vi.fn(),
  gatewaySecretInputPathCanWin: vi.fn(),
  readGatewaySecretInputValue: vi.fn((..._args: unknown[]) => undefined as string | undefined),
  checkGatewayHealth: vi.fn(async () => ({
    authenticated: true,
    healthOk: true,
    status: { ok: true },
  })),
  probeGatewayMemoryStatus: vi.fn(async () => ({ checked: true, ready: true, skipped: false })),
  noteChromeMcpBrowserReadiness: vi.fn(),
  detectLegacyStateMigrations: vi.fn(),
  runLegacyStateMigrations: vi.fn(),
  repairObsoleteGeneratedExecApprovals: vi.fn(() => 0),
  collectLegacyPluginManifestContractMigrations: vi.fn(() => [] as unknown[]),
  legacyPluginManifestContractMigrationToHealthFinding: vi.fn(
    (migration: { pluginId: string }) => ({
      checkId: "core/doctor/legacy-plugin-manifests",
      severity: "warning" as const,
      message: `Plugin manifest ${migration.pluginId} uses legacy top-level capability keys.`,
      path: "/tmp/openclaw-plugin/openclaw.plugin.json",
      target: migration.pluginId,
      requirement: "contracts-capability-keys",
    }),
  ),
  maybeRepairLegacyPluginManifestContracts: vi.fn<() => Promise<unknown>>(async () => undefined),
  maybeRepairOwnedChromeExtensionNativeHosts: vi.fn().mockResolvedValue({
    changes: [],
    warnings: [],
  }),
  listAgentIds: vi.fn<(_cfg: OpenClawConfig) => string[]>(() => ["default"]),
  listAgentEntries: vi.fn(() => [{ id: "default" }]),
  tryResolveSoleAgentId: vi.fn<(_cfg: OpenClawConfig) => string | undefined>(() => "default"),
  resolveAgentWorkspaceDir: vi.fn<(_cfg: OpenClawConfig, agentId: string) => string>(
    () => "/tmp/openclaw-workspace",
  ),
  tryResolveConfiguredAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  tryResolveSystemAgentWorkspaceDir: vi.fn(() => "/tmp/openclaw-workspace"),
  resolveDefaultAgentId: vi.fn<(_cfg: OpenClawConfig) => string>(() => "default"),
  resolveAgentContextLimits: vi.fn(
    (cfg: { agents?: { defaults?: { contextLimits?: unknown } } }) =>
      cfg.agents?.defaults?.contextLimits ?? {},
  ),
  note: vi.fn(),
  loadModelCatalog: vi.fn(async () => []),
  findModelCatalogEntry: vi.fn(() => ({ contextTokens: 200_000 })),
  getModelRefStatus: vi.fn(() => ({ allowed: true, inCatalog: true, key: "openai/gpt-5.5" })),
  resolveConfiguredModelRef: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  resolveHooksGmailModel: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
  modelKey: vi.fn((provider: string, model: string) => `${provider}/${model}`),
  replaceConfigFile: vi.fn<(params: unknown) => Promise<unknown>>(async () => undefined),
  readConfigFileSnapshot: vi.fn().mockResolvedValue({
    exists: true,
    valid: true,
    config: {},
    issues: [],
  }),
  gatherDaemonStatus: vi.fn(),
  noteWorkspaceStatus: vi.fn(),
  collectWorkspaceStatusHealthFindings: vi.fn<() => Promise<unknown>>(async () => []),
  collectWorkspaceBackupTip: vi.fn<(workspaceDir: string) => string | undefined>(() => undefined),
  shouldSuggestMemorySystem: vi.fn<(workspaceDir: string) => Promise<boolean>>(async () => false),
  collectDiskSpaceHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  collectHeartbeatCadenceMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatCadenceToCron: vi.fn<() => Promise<unknown>>(async () => ({
    changes: [],
    warnings: [],
  })),
  collectHeartbeatScratchMigrationFindings: vi.fn(async () => [] as unknown[]),
  collectToolsMdMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatFilesToScratch: vi.fn<() => Promise<unknown>>(async () => ({
    changes: [],
    warnings: [],
  })),
  maybeMigrateToolsMd: vi.fn<() => Promise<unknown>>(async () => ({ changes: [], warnings: [] })),
  collectHeartbeatTaskMigrationFindings: vi.fn(async () => [] as unknown[]),
  maybeMigrateHeartbeatTasksToCron: vi.fn<() => Promise<unknown>>(async () => ({
    changes: [],
    warnings: [],
  })),
  collectWhatsappResponsivenessHealthFindings: vi.fn((): readonly HealthFinding[] => []),
  noteWhatsappResponsivenessHealth: vi.fn<() => Promise<unknown>>(async () => undefined),
  collectDevicePairingHealthFindings: vi.fn(async () => []),
  collectLegacyCronStoreHealthFindings: vi.fn(async (): Promise<readonly HealthFinding[]> => []),
  collectLegacyWhatsAppCrontabHealthWarning: vi.fn(
    async (): Promise<string | undefined> => undefined,
  ),
  maybeRepairLegacyCronStore: vi.fn<() => Promise<unknown>>(async () => undefined),
  repairCronCodexModelRefsAfterConfigWrite: vi.fn<() => Promise<unknown>>(async () => ({
    changes: [],
    warnings: [],
  })),
  noteLegacyWhatsAppCrontabHealthCheck: vi.fn<() => Promise<unknown>>(async () => undefined),
  scanConfiguredChannelPluginBlockers: vi.fn(
    (): Array<{ channelId: string; pluginId: string; reason: string }> => [],
  ),
  channelPluginBlockerHitToHealthFinding: vi.fn(
    (hit: { channelId: string; pluginId: string; reason: string }) => ({
      checkId: "core/doctor/channel-plugin-blockers",
      severity: "warning" as const,
      message: "channels." + hit.channelId + " blocked",
      path: "channels." + hit.channelId,
      target: hit.pluginId,
      requirement: hit.reason,
    }),
  ),
  collectBundledChannelPackageStateLoadFailures: vi.fn(() => [] as unknown[]),
  collectStalePluginRuntimeSymlinkHealthFindings: vi.fn(async () => [] as unknown[]),
  collectChannelPreviewWarningHealthFindings: vi.fn(
    async (): Promise<readonly HealthFinding[]> => [],
  ),
  applyWizardMetadata: vi.fn((cfg: unknown) => cfg),
  logConfigUpdated: vi.fn(),
  isRecord: vi.fn(
    (value: unknown): value is Record<string, unknown> =>
      typeof value === "object" && value !== null && !Array.isArray(value),
  ),
  shortenHomePath: vi.fn((p: string) => p),
  formatCliCommand: vi.fn((cmd: string) => cmd),
  findInstalledSystemdGatewayScope: vi.fn<
    (typeof import("../daemon/systemd.js"))["findInstalledSystemdGatewayScope"]
  >(async () => ({
    scope: "user",
    unitName: "openclaw-gateway.service",
    unitPath: "/home/alice/.config/systemd/user/openclaw-gateway.service",
  })),
  isSystemdUserServiceAvailable: vi.fn(async () => true),
  readSystemdUserLingerStatus: vi.fn(
    async (_params: {
      env: Record<string, string | undefined>;
      user?: string;
    }): Promise<{ user: string; linger: "yes" | "no" } | null> => ({
      user: "alice",
      linger: "no",
    }),
  ),
  resolveSystemdUserServiceAccount: vi.fn(() => "alice" as string | null),
  gatewayServiceIsLoaded: vi.fn(async () => true),
  resolveGatewayService: vi.fn(),
}));

vi.mock("../config/paths.js", async () => {
  const actual = await vi.importActual<typeof import("../config/paths.js")>("../config/paths.js");
  return { ...actual, isDefaultInstallIdentity: mocks.isDefaultInstallIdentity };
});

function mockExports(...keys: (keyof typeof mocks)[]) {
  return Object.fromEntries(keys.map((key) => [key, mocks[key]]));
}

const DOCTOR_GATEWAY_HEALTH_ID = "doctor:gateway-health";

vi.mock("../commands/doctor/shared/release-configured-plugin-installs.js", () =>
  mockExports("maybeRunConfiguredPluginInstallReleaseStep"),
);

vi.mock("../commands/doctor/shared/plugin-runtime-symlinks.js", () => ({
  collectStalePluginRuntimeSymlinkHealthFindings:
    mocks.collectStalePluginRuntimeSymlinkHealthFindings,
}));

vi.mock("./bundled-health-checks.js", () => mockExports("registerBundledHealthChecks"));

vi.mock("./doctor-repair-flow.js", () => mockExports("runDoctorHealthRepairs"));

vi.mock("../config/types.secrets.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/types.secrets.js")>();
  return { ...actual, resolveSecretInputRef: mocks.resolveSecretInputRef };
});

vi.mock("../gateway/auth.js", () => mockExports("resolveGatewayAuth"));

vi.mock("../gateway/auth-token-resolution.js", () => mockExports("resolveGatewayAuthToken"));

vi.mock("../secrets/exec-resolution-policy.js", () => mockExports("getSkippedExecRefStaticError"));

vi.mock("../commands/doctor-gateway-services.js", () =>
  mockExports(
    "maybeRepairGatewayServiceConfig",
    "maybeScanExtraGatewayServices",
    "maybeResolveDuelingSystemdGatewayScopes",
  ),
);

vi.mock("../commands/doctor-auth-flat-profiles.js", () => ({
  maybeRepairLegacyAuthProfileStores: ({
    profileIdMap,
  }: {
    profileIdMap: Map<string, string>;
  }) => ({ changes: [], warnings: [], profileIdMap }),
  collectOpenAICodexAuthProfileStoreIdMap: mocks.collectOpenAICodexAuthProfileStoreIdMap,
  maybeMigrateAuthProfileJsonStoresToSqlite: mocks.maybeMigrateAuthProfileJsonStoresToSqlite,
  maybeRepairOpenAICodexAuthConfig: mocks.maybeRepairOpenAICodexAuthConfig,
}));

vi.mock("../commands/doctor-plugin-model-catalog.js", () =>
  mockExports("maybeMigrateLegacyPluginModelCatalogs"),
);

vi.mock("../commands/doctor-model-catalog-credentials.js", () =>
  mockExports("maybeMigrateModelCatalogCredentials"),
);

vi.mock("../commands/doctor-gateway-daemon-flow.js", () => mockExports("maybeRepairGatewayDaemon"));

vi.mock("../infra/container-environment.js", () => mockExports("isContainerEnvironment"));

vi.mock("../daemon/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/service.js")>();
  return {
    ...actual,
    readGatewayServiceState: async () => ({
      installed: true,
      loadState: { status: (await mocks.gatewayServiceIsLoaded()) ? "loaded" : "not-loaded" },
      running: false,
      env: {},
      command: null,
      runtime: { status: "stopped" },
    }),
    resolveGatewayService: mocks.resolveGatewayService,
  };
});

vi.mock("../daemon/systemd.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../daemon/systemd.js")>();
  return {
    ...actual,
    findInstalledSystemdGatewayScope: mocks.findInstalledSystemdGatewayScope,
    isSystemdUserServiceAvailable: mocks.isSystemdUserServiceAvailable,
    readSystemdUserLingerStatus: mocks.readSystemdUserLingerStatus,
    resolveSystemdUserServiceAccount: mocks.resolveSystemdUserServiceAccount,
  };
});

vi.mock("../commands/doctor-auth-legacy-oauth.js", () =>
  mockExports("maybeRepairLegacyOAuthProfileIds"),
);

vi.mock("../infra/state-migrations.doctor.js", () =>
  mockExports("detectLegacyStateMigrations", "runLegacyStateMigrations"),
);

vi.mock("../infra/exec-approvals-generated-migration.js", () =>
  mockExports("repairObsoleteGeneratedExecApprovals"),
);

vi.mock("../commands/doctor-plugin-manifests.js", () => ({
  collectLegacyPluginManifestContractMigrations:
    mocks.collectLegacyPluginManifestContractMigrations,
  legacyPluginManifestContractMigrationToHealthFinding:
    mocks.legacyPluginManifestContractMigrationToHealthFinding,
  maybeRepairLegacyPluginManifestContracts: mocks.maybeRepairLegacyPluginManifestContracts,
}));

vi.mock("../agents/auth-profiles.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/auth-profiles.js")>()),
  removeAuthProfilesAcrossOwnerStores: mocks.removeAuthProfilesAcrossOwnerStores,
}));

vi.mock("../commands/doctor-auth.js", () =>
  mockExports(
    "collectAuthProfileHealthFindings",
    "noteAuthProfileHealth",
    "noteCopilotAmbientToken",
    "noteLegacyCodexProviderOverride",
    "noteSharedAuthStoreStatus",
  ),
);

vi.mock("../commands/doctor-memory-recall.js", () => ({
  maybeRepairMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
  noteMemoryRecallHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/doctor-memory-search.js", () =>
  mockExports("noteMemorySearchHealth", "collectMemorySearchHealthFindings"),
);

vi.mock("../commands/doctor-web-fetch-proxy.js", () => mockExports("noteWebFetchProxyDiagnostic"));

vi.mock("../gateway/call.js", () => mockExports("buildGatewayConnectionDetails", "callGateway"));

vi.mock("../commands/doctor-platform-notes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../commands/doctor-platform-notes.js")>()),
  noteMacGatewayPlatformWarnings: mocks.noteMacGatewayPlatformWarnings,
  noteMacDisabledGatewayLaunchAgent: mocks.noteMacDisabledGatewayLaunchAgent,
}));

vi.mock("../commands/doctor-foreign-launchd-jobs.js", () => ({
  noteMacForeignLaunchdJobs: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../gateway/credentials-secret-inputs.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/credentials-secret-inputs.js")>();
  return {
    ...actual,
    gatewaySecretInputPathCanWin: (
      ...args: Parameters<typeof actual.gatewaySecretInputPathCanWin>
    ) =>
      mocks.gatewaySecretInputPathCanWin.getMockImplementation()
        ? mocks.gatewaySecretInputPathCanWin(...args)
        : actual.gatewaySecretInputPathCanWin(...args),
  };
});

vi.mock("../gateway/secret-input-paths.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../gateway/secret-input-paths.js")>();
  return {
    ...actual,
    readGatewaySecretInputValue: (
      ...args: Parameters<typeof actual.readGatewaySecretInputValue>
    ) =>
      mocks.readGatewaySecretInputValue.getMockImplementation()
        ? mocks.readGatewaySecretInputValue(...args)
        : actual.readGatewaySecretInputValue(...args),
  };
});

vi.mock("../commands/doctor-gateway-health.js", () =>
  mockExports("checkGatewayHealth", "probeGatewayMemoryStatus"),
);

vi.mock("../commands/doctor-browser.js", () =>
  mockExports("noteChromeMcpBrowserReadiness", "maybeRepairOwnedChromeExtensionNativeHosts"),
);

vi.mock("../agents/agent-scope.js", () =>
  mockExports(
    "listAgentIds",
    "listAgentEntries",
    "tryResolveSoleAgentId",
    "resolveAgentWorkspaceDir",
    "tryResolveConfiguredAgentWorkspaceDir",
    "tryResolveSystemAgentWorkspaceDir",
    "resolveDefaultAgentId",
    "resolveAgentContextLimits",
  ),
);

vi.mock("../../packages/terminal-core/src/note.js", () => mockExports("note"));

vi.mock("../agents/model-catalog.js", () => mockExports("findModelCatalogEntry"));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadProviderScopedThinkingCatalog: vi.fn(async () => []),
  readPreparedModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", () =>
  mockExports(
    "getModelRefStatus",
    "resolveConfiguredModelRef",
    "resolveDefaultModelForAgent",
    "resolveHooksGmailModel",
    "modelKey",
  ),
);

vi.mock("../version.js", async () => ({
  ...(await vi.importActual<typeof import("../version.js")>("../version.js")),
  VERSION: "2026.5.2-test",
  resolveCompatibilityHostVersion: vi.fn(() => "2026.5.2-test"),
  resolveIsNixMode: vi.fn(() => false),
}));

vi.mock("../commands/doctor/shared/config-flow-steps.js", () => ({
  restoreDoctorConfigEnvRefs: (cfg: OpenClawConfig) => cfg,
}));

vi.mock("../config/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/config.js")>()),
  CONFIG_PATH: "/tmp/fake-openclaw.json",
  transformConfigFile: async ({
    transform,
    ...options
  }: Parameters<typeof import("../config/config.js").transformConfigFile>[0]) => {
    const { nextConfig } = await transform(
      {},
      { snapshot: createDoctorConfigSnapshot(), previousHash: null, attempt: 0 },
      {},
    );
    await mocks.replaceConfigFile({ ...options, nextConfig });
    const path = options.writeOptions?.expectedConfigPath;
    if (!path) {
      throw new Error("Doctor write fixture requires an expected config path");
    }
    return { nextConfig, path, persistedHash: "committed-revision" };
  },
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
}));

vi.mock("../infra/update-check-package-target.js", () => ({
  fetchNpmPackageTargetStatus: vi.fn(),
}));

vi.mock("../cli/daemon-cli/status.gather.js", () => mockExports("gatherDaemonStatus"));

vi.mock("../commands/doctor-workspace-status.js", () =>
  mockExports("noteWorkspaceStatus", "collectWorkspaceStatusHealthFindings"),
);

vi.mock("../commands/doctor-workspace.js", () => ({
  collectWorkspaceBackupTip: mocks.collectWorkspaceBackupTip,
  MEMORY_SYSTEM_PROMPT: "Enable memory system for better recall.",
  shouldSuggestMemorySystem: mocks.shouldSuggestMemorySystem,
}));

vi.mock("../commands/doctor-disk-space.js", () => ({
  noteDiskSpace: vi.fn(),
  collectDiskSpaceHealthFindings: mocks.collectDiskSpaceHealthFindings,
}));

vi.mock("../commands/doctor-heartbeat-cadence-migration.js", () =>
  mockExports("collectHeartbeatCadenceMigrationFindings", "maybeMigrateHeartbeatCadenceToCron"),
);

vi.mock("../commands/doctor-heartbeat-scratch-migration.js", () =>
  mockExports("collectHeartbeatScratchMigrationFindings", "maybeMigrateHeartbeatFilesToScratch"),
);

vi.mock("../commands/doctor-tools-md-migration.js", () =>
  mockExports("collectToolsMdMigrationFindings", "maybeMigrateToolsMd"),
);

vi.mock("../commands/doctor-heartbeat-task-migration.js", () =>
  mockExports("collectHeartbeatTaskMigrationFindings", "maybeMigrateHeartbeatTasksToCron"),
);

vi.mock("../commands/doctor-whatsapp-responsiveness.js", () =>
  mockExports("collectWhatsappResponsivenessHealthFindings", "noteWhatsappResponsivenessHealth"),
);

vi.mock("../commands/doctor-device-pairing.js", () => ({
  collectDevicePairingHealthFindings: mocks.collectDevicePairingHealthFindings,
  noteDevicePairingHealth: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../commands/doctor/cron/index.js", () =>
  mockExports(
    "collectLegacyCronStoreHealthFindings",
    "collectLegacyWhatsAppCrontabHealthWarning",
    "maybeRepairLegacyCronStore",
    "noteLegacyWhatsAppCrontabHealthCheck",
  ),
);

vi.mock("../commands/doctor/cron/legacy-repair.js", () =>
  mockExports("repairCronCodexModelRefsAfterConfigWrite"),
);

vi.mock("../commands/doctor/shared/channel-plugin-blockers.js", () =>
  mockExports("scanConfiguredChannelPluginBlockers", "channelPluginBlockerHitToHealthFinding"),
);

vi.mock("../channels/plugins/package-state-probes.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../channels/plugins/package-state-probes.js")>()),
  collectBundledChannelPackageStateLoadFailures:
    mocks.collectBundledChannelPackageStateLoadFailures,
}));

vi.mock("./doctor-startup-channel-maintenance.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./doctor-startup-channel-maintenance.js")>();
  return {
    ...actual,
    collectChannelPreviewWarningHealthFindings: mocks.collectChannelPreviewWarningHealthFindings,
  };
});

vi.mock("../commands/onboard-helpers.js", () => ({
  applyWizardMetadata: mocks.applyWizardMetadata,
  randomToken: vi.fn(() => "generated-gateway-token"),
}));

vi.mock("../config/logging.js", () => mockExports("logConfigUpdated"));

vi.mock("../utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../utils.js")>();
  return {
    ...actual,
    isRecord: mocks.isRecord,
    resolveConfigDir: vi.fn(() => "/tmp/openclaw-config"),
    resolveUserPath: vi.fn((value: string) => value),
    shortenHomePath: mocks.shortenHomePath,
  };
});

vi.mock("../cli/command-format.js", () => mockExports("formatCliCommand"));

function expectNote(text: string, title: string) {
  expect(mocks.note).toHaveBeenCalledWith(expect.stringContaining(text), title);
}

function expectNoCalls(...functions: unknown[]) {
  for (const fn of functions) {
    expect(fn).not.toHaveBeenCalled();
  }
}

function expectedFinding(id: string, fields: Partial<HealthFinding> = {}) {
  return { findings: [expect.objectContaining({ checkId: `core/doctor/${id}`, ...fields })] };
}

function makeWarningFinding(id: string, fields: Partial<HealthFinding> = {}): HealthFinding {
  return { checkId: `core/doctor/${id}`, severity: "warning", message: id, ...fields };
}

async function expectSelectedLint(
  ctx: Parameters<typeof runDoctorLintChecks>[0],
  check: HealthCheck,
  expected: object,
) {
  await expect(
    runDoctorLintChecks(ctx, { checks: [check], onlyIds: [check.id] }),
  ).resolves.toMatchObject({ checksRun: 1, checksSkipped: 0, ...expected });
}

function expectWrite(options: object, fields: object = {}, call?: number) {
  const expected = expect.objectContaining({
    ...fields,
    writeOptions: expect.objectContaining(options),
  });
  if (call === undefined) {
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(expected);
  } else {
    expect(mocks.replaceConfigFile).toHaveBeenNthCalledWith(call, expected);
  }
}

function expectBefore(
  first: { mock: { invocationCallOrder: number[] } },
  second: { mock: { invocationCallOrder: number[] } },
) {
  expect(first.mock.invocationCallOrder[0]).toBeLessThan(second.mock.invocationCallOrder[0]!);
}

function configValidationError(
  message = "Config validation failed: agents.defaults.heartbeat.every",
) {
  return Object.assign(new Error(message), {
    code: "CONFIG_VALIDATION_FAILED",
    issues: [
      {
        path: "agents.defaults.heartbeat.every",
        message: "Invalid input: expected string, received number",
      },
    ],
  });
}

function repairResult(overrides: Record<string, unknown>) {
  return {
    config: {},
    findings: [],
    remainingFindings: [],
    changes: [],
    warnings: [],
    diffs: [],
    effects: [],
    checksRun: 0,
    checksRepaired: 0,
    checksValidated: 0,
    ...overrides,
  };
}

function requireDoctorContribution(id: string) {
  const contribution = resolveDoctorHealthContributions().find((entry) => entry.id === id);
  if (!contribution) {
    throw new Error(`expected doctor contribution ${id}`);
  }
  return contribution;
}

async function requireDoctorHealthCheck(id: string) {
  const check = (await resolveDoctorContributionHealthChecks()).find((entry) => entry.id === id);
  if (!check) {
    throw new Error(`expected doctor health check ${id}`);
  }
  return check;
}

type DoctorContributionRunContext = Parameters<
  ReturnType<typeof requireDoctorContribution>["run"]
>[0];

function createDoctorContext({
  shouldRepair = false,
  ...overrides
}: Parameters<typeof createDoctorHealthFlowContext>[0] & { shouldRepair?: boolean } = {}) {
  return createDoctorHealthFlowContext({
    configPath: "/tmp/fake-openclaw.json",
    prompter: createDoctorPrompterFixture(shouldRepair),
    ...overrides,
  });
}

async function runDoctor(id: string, overrides: Parameters<typeof createDoctorContext>[0]) {
  const ctx = createDoctorContext(overrides);
  await requireDoctorContribution(id).run(ctx);
  return ctx;
}

function createWriteContext(
  cfg: OpenClawConfig,
  overrides: Parameters<typeof createDoctorContext>[0] = {},
) {
  return createDoctorContext({
    cfg,
    cfgForPersistence: structuredClone(cfg),
    configResult: { cfg, shouldWriteConfig: true },
    shouldRepair: true,
    ...overrides,
  });
}

function createDeferredCronContext(
  shouldRepair: boolean,
  retiredModelRefConfig?: DoctorContributionRunContext["configResult"]["retiredModelRefConfig"],
) {
  const cfg: OpenClawConfig = { agents: { defaults: { models: {} } } };
  return createDoctorContext({
    cfg,
    cfgForPersistence: cfg,
    shouldRepair,
    env: {},
    configResult: {
      cfg,
      shouldWriteConfig: true,
      shouldRepairCronCodexModelRefsAfterConfigWrite: true,
      blockedCodexModelIdentities: ["codex\u0000gpt-5.6-sol"],
      ...(retiredModelRefConfig ? { retiredModelRefConfig } : {}),
    },
  });
}

function createDoctorLintFixture(
  cfg: OpenClawConfig | Record<string, unknown> = {},
  overrides: Omit<Parameters<typeof createDoctorLintContext>[0], "cfg"> = {},
) {
  return createDoctorLintContext({
    cfg: cfg as OpenClawConfig,
    mode: "lint",
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    ...overrides,
  });
}

function setRegisteredHealthChecks(
  checks: ReadonlyArray<Pick<HealthCheck, "id" | "kind"> & { defaultEnabled?: boolean }>,
) {
  clearHealthChecksForTest();
  for (const check of checks) {
    registerHealthCheck({ ...check, description: check.id, detect: async () => [] });
  }
}

describe("doctor health contributions", () => {
  async function withProcessPlatform<T>(
    platform: NodeJS.Platform,
    run: () => Promise<T>,
  ): Promise<T> {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    try {
      return await run();
    } finally {
      if (original) {
        Object.defineProperty(process, "platform", original);
      }
    }
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.callGateway.mockResolvedValue({});
    mocks.maybeRepairGatewayServiceConfig.mockImplementation(async (cfg: unknown) => cfg);
    mocks.runDoctorHealthRepairs.mockImplementation(async (input: { cfg?: unknown }) =>
      repairResult({ config: input.cfg ?? {}, checksValidated: 0 }),
    );
    mocks.noteChromeMcpBrowserReadiness.mockResolvedValue(undefined);
    mocks.detectLegacyStateMigrations.mockResolvedValue({ preview: [], warnings: [], notices: [] });
    mocks.runLegacyStateMigrations.mockResolvedValue({
      changes: [],
      warnings: [],
      stepReceipts: [],
    });
    mocks.readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      sourceConfig: {},
      config: {},
      issues: [],
    });
    mocks.gatherDaemonStatus.mockResolvedValue({});
    mocks.resolveGatewayService.mockReturnValue({ isLoaded: mocks.gatewayServiceIsLoaded });
    mocks.noteMacGatewayPlatformWarnings.mockResolvedValue(undefined);
    setRegisteredHealthChecks([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/unrelated", kind: "plugin" },
    ]);
  });

  afterEach(() => {
    clearHealthChecksForTest();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("stops after an optional contribution fails after writing config", async () => {
    const laterRun = vi.fn(async () => undefined);
    const ctx = createDoctorContext({ env: {} });
    const failure = new ConfigWritePostCommitError({
      configPath: ctx.configPath,
      rollbackStatus: "not-restored",
      cause: new Error("config path changed since last load"),
    });

    await expect(
      runDoctorHealthContributionList(ctx, [
        createDoctorHealthContribution("doctor:test-config-write", "Test config write", {
          run: async () => {
            throw failure;
          },
        }),
        createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
      ]),
    ).rejects.toBe(failure);

    expect(laterRun).not.toHaveBeenCalled();
  });

  it("rejects a failed initial config write before later work runs", async () => {
    const laterRun = vi.fn(async () => undefined);
    const cfg = { gateway: { mode: "invalid" } } as unknown as OpenClawConfig;
    const ctx = createWriteContext(cfg, { env: {}, updateWarnings: ["earlier warning"] });
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("Config validation failed"));

    await expect(
      runDoctorHealthContributionList(ctx, [
        requireDoctorContribution("doctor:write-config-migrations"),
        createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
      ]),
    ).rejects.toThrow("Config validation failed");

    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(ctx.updateWarnings).toEqual(["earlier warning"]);
  });

  it("keeps legacy plugin manifest lint opt-in for structured findings", async () => {
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/legacy-plugin-manifests"]);
    expect(check.defaultEnabled).toBe(false);

    const migration = {
      manifestPath: "/tmp/openclaw-plugin/openclaw.plugin.json",
      pluginId: "legacy-plugin",
      nextRaw: {},
      changeLines: ["- moved tools to contracts.tools"],
    };
    mocks.collectLegacyPluginManifestContractMigrations.mockReturnValueOnce([migration]);
    const ctx = createDoctorLintFixture({ plugins: { load: { paths: ["/tmp/openclaw-plugin"] } } });

    expect(mocks.collectLegacyPluginManifestContractMigrations).not.toHaveBeenCalled();

    await expectSelectedLint(ctx, check, {
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/legacy-plugin-manifests",
          target: "legacy-plugin",
          requirement: "contracts-capability-keys",
        }),
      ],
    });
    expect(mocks.collectLegacyPluginManifestContractMigrations).toHaveBeenCalledWith({
      config: ctx.cfg,
      env: process.env,
    });
    expect(mocks.legacyPluginManifestContractMigrationToHealthFinding).toHaveBeenCalledWith(
      migration,
      expect.any(Number),
      expect.any(Array),
    );
  });

  it("invalidates retained plugin metadata after rewriting a legacy manifest", async () => {
    mocks.maybeRepairLegacyPluginManifestContracts.mockResolvedValueOnce(true);
    const invalidatePluginMetadataSnapshot = vi.fn();
    const contribution = requireDoctorContribution("doctor:legacy-plugin-manifests");
    const ctx = createDoctorHealthFlowContext({
      prompter: createDoctorPrompterFixture(true),
      invalidatePluginMetadataSnapshot,
    });

    await contribution.run(ctx);

    expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
  });

  it("commits config migrations before reporting a runtime schema diagnostic failure", async () => {
    const cfg = { channels: { discord: { streaming: { mode: "partial" } } } } as OpenClawConfig;
    const ctx = createWriteContext(cfg, { env: {} });
    const failure = new Error("runtime plugin schema inspection failed");
    const check = CORE_HEALTH_CHECKS.find(
      (entry) => entry.id === "core/doctor/runtime-tool-schemas",
    )!;
    const detect = vi.spyOn(check, "detect").mockRejectedValueOnce(failure);
    const contributions = resolveDoctorHealthContributions().filter((entry) =>
      ["doctor:write-config-migrations", "doctor:runtime-tool-schemas"].includes(entry.id),
    );

    await runDoctorHealthContributionList(ctx, contributions);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(detect).toHaveBeenCalledOnce();
    expect(mocks.replaceConfigFile).toHaveBeenCalledBefore(detect);
    expect(ctx.configResultWriteCommitted).toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    const warning = `doctor:runtime-tool-schemas run failed: ${failure.message}`;
    expect(mocks.note).toHaveBeenCalledWith(warning, "Doctor warnings");
    expect(ctx.updateWarnings).toContain(warning);
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it("reports unapplied fixes and holds change panels when write validation refuses the candidate", async () => {
    // Regression: unknown root key repaired + type error elsewhere. Doctor used to
    // print "Doctor changes — gatway", then crash with a raw Error and persist nothing.
    const cfg = { agents: { defaults: { heartbeat: { every: 5 } } } } as unknown as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: { cfg, shouldWriteConfig: true, pendingChangePanels: ["- gatway"] },
      sourceConfigValid: false,
      shouldRepair: true,
      options: { nonInteractive: true, repair: true },
      env: {},
    });
    const pendingWarnings = [
      "Deferred legacy agent/session migration: select an agent owner",
      "Second pending owner needs operator input",
      ...Array.from({ length: 20 }, (_, index) => `Test owner ${index + 1} is blocked`),
    ];
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: [],
      warnings: pendingWarnings,
      notices: [],
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      configValidationError(
        "Config validation failed: agents.defaults.heartbeat.every: Invalid input: expected string, received number",
      ),
    );

    const laterRun = vi.fn(async () => undefined);
    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
    ]);

    // Later repairs must not persist state derived from the refused candidate.
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configWriteRefusal).toBe("validation");
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    expectNote("No config changes were written", "Doctor warnings");
    expectNote("agents.defaults.heartbeat.every", "Doctor warnings");
    const deferredPanels = mocks.note.mock.calls.filter(
      ([, title]) => title === "Legacy state deferred",
    );
    expect(deferredPanels).toHaveLength(1);
    expect(deferredPanels[0]?.[0]).toContain(pendingWarnings[0]);
    expect(deferredPanels[0]?.[0]).toContain(pendingWarnings[1]);
    expect(deferredPanels[0]?.[0]).toContain("2 additional pending entries were omitted");
    expect(deferredPanels[0]?.[0]).toContain("No listed legacy source was removed.");
    expect(deferredPanels[0]?.[0]).toContain("Fix the config errors above.");
    expect(deferredPanels[0]?.[0]).not.toContain("doctor --fix");
    expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();

    // A later write pass must not retry the identical candidate or duplicate the warning.
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expectNoCalls(mocks.replaceConfigFile, mocks.note);
  });

  it("describes only the failed later write after an earlier pass committed", async () => {
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createWriteContext(cfg, { env: {} });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);
    expect(ctx.configResultWriteCommitted).toBe(true);

    ctx.cfg = {
      ...ctx.cfg,
      agents: { defaults: { heartbeat: { every: 5 } } },
    } as unknown as OpenClawConfig;
    mocks.note.mockClear();
    mocks.replaceConfigFile.mockRejectedValueOnce(configValidationError());
    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(ctx.configWriteRefusal).toBe("validation");
    expectNote("Earlier config fixes were already saved", "Doctor warnings");
    expect(mocks.note).not.toHaveBeenCalledWith(
      expect.stringContaining("No config changes were written"),
      "Doctor warnings",
    );
  });

  it("prints held change panels as Doctor changes only after the write commits", async () => {
    const cfg = { gateway: { mode: "local" } } as OpenClawConfig;
    const ctx = createDoctorContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      configResult: {
        cfg,
        shouldWriteConfig: true,
        pendingChangePanels: ["- gatway"],
        skipWizardMetadataForIncludeWrite: true,
      },
      shouldRepair: true,
      env: {},
    });

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.applyWizardMetadata).not.toHaveBeenCalled();
    expect(mocks.note).toHaveBeenCalledWith("- gatway", "Doctor changes");
    expect(ctx.configResultWriteCommitted).toBe(true);
    // Panels print exactly once even when the final writer runs again.
    mocks.note.mockClear();
    await requireDoctorContribution("doctor:write-config").run(ctx);
    expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
  });

  it.each([
    ["cron-owner-safety", undefined, "preserving any retained legacy owner"],
    [
      "include-ownership",
      ["./browser.json"],
      "Repair browser in the included file ./browser.json by hand",
    ],
    [
      "include-ownership",
      ["./a.json", "./b.json"],
      "Repair browser in the included files ./a.json, ./b.json by hand",
    ],
    ["include-ownership", undefined, "Repair browser in its included file by hand"],
  ] as const)("defers config writes for %s (%j)", async (refusal, includeTargets, expected) => {
    const cron = refusal === "cron-owner-safety";
    const cfg: OpenClawConfig = {
      agents: { ownership: "explicit", entries: { ops: {}, research: {} } },
    };
    const ctx = createWriteContext(cfg, { options: { repair: true }, env: {} });
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: ["- Workspace setup and attestations: legacy files → shared SQLite state"],
      warnings: [],
      notices: [],
    });
    mocks.replaceConfigFile.mockRejectedValueOnce(
      cron
        ? Object.assign(
            new Error(
              'Config write refused: cannot inspect cron ownership. Run "openclaw doctor --fix", then retry.',
            ),
            { code: "CONFIG_WRITE_REJECTED", refusal },
          )
        : Object.assign(
            new Error(
              "Config write would flatten $include-owned config at browser; edit that include file directly or remove the $include first.",
            ),
            {
              code: "CONFIG_INCLUDE_OWNERSHIP",
              ownedConfigPath: "browser",
              ...(includeTargets ? { includeTargets } : {}),
            },
          ),
    );
    const laterRun = vi.fn(async () => undefined);
    await runDoctorHealthContributionList(ctx, [
      requireDoctorContribution("doctor:write-config-migrations"),
      createDoctorHealthContribution("doctor:test-later", "Test later", laterRun),
    ]);
    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(laterRun).not.toHaveBeenCalled();
    expect(ctx.configResultWriteCommitted).not.toBe(true);
    expect(ctx.configWriteRefusal).toBe(refusal);
    expect(ctx.cfgForPersistence).toEqual(cfg);
    expectNote(expected, "Doctor warnings");
    expectNote(
      cron
        ? "Resolve the Gateway or cron-store condition above"
        : "Repair the include boundary named above by hand",
      "Legacy state deferred",
    );
    if (cron) {
      expect(mocks.note).not.toHaveBeenCalledWith(
        expect.stringContaining("Fix the config errors above"),
        "Legacy state deferred",
      );
      expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();
    } else {
      expect(mocks.note).not.toHaveBeenCalledWith(expect.anything(), "Doctor changes");
    }
  });

  it.each(["maintenance", "reachability", "exec credential"] as const)(
    "skips read-scope gateway probes during %s",
    async (scenario) => {
      const ctx = createDoctorContext({ env: {} });
      if (scenario === "maintenance") {
        ctx.gatewayMaintenanceActive = true;
      } else {
        mocks.checkGatewayHealth.mockResolvedValue({
          authenticated: false,
          healthOk: true,
          status: { ok: true },
        });
      }
      if (scenario === "exec credential") {
        mocks.gatewaySecretInputPathCanWin.mockImplementation(
          ({ path }: { path: string }) => path === "gateway.auth.token",
        );
        mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");
        ctx.cfg = createDoctorConfigFixture({
          gateway: {
            mode: "remote",
            remote: { url: "wss://gateway.example" },
            auth: {
              mode: "token",
              token: { source: "exec", provider: "vault", id: "gateway/token" },
            },
          },
          secrets: { providers: { vault: { source: "exec", command: "/bin/false" } } },
        });
      }
      await requireDoctorContribution(DOCTOR_GATEWAY_HEALTH_ID).run(ctx);
      expect(mocks.probeGatewayMemoryStatus).not.toHaveBeenCalled();
      expect(ctx.gatewayMemoryProbe).toEqual({ checked: false, ready: false, skipped: true });
      if (scenario === "reachability") {
        expect(ctx).toMatchObject({ healthOk: true, gatewayHealthAuthenticated: false });
      } else {
        expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
        expect(ctx.gatewayHealthSkipped).toBe(true);
      }
      if (scenario === "exec credential") {
        expectNote("Gateway health checks skipped", "Gateway");
      }
    },
  );

  it.each(["inspect", "repair", "legacy-parent"] as const)(
    "preserves release plugin install policy in %s mode",
    async (mode) => {
      const legacy = mode === "legacy-parent";
      const sourceVersion = legacy ? "2026.5.16-beta.4" : "2026.4.29";
      const env = legacy
        ? {
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
          }
        : {};
      const invalidatePluginMetadataSnapshot = vi.fn();
      if (mode !== "inspect") {
        mocks.maybeRunConfiguredPluginInstallReleaseStep.mockResolvedValue({
          changes: ["Installed configured plugin matrix."],
          warnings: [],
          touchedConfig: true,
          ...(legacy ? {} : { pluginInventoryChanged: true }),
        });
      }
      const ctx = await runDoctor("doctor:release-configured-plugin-installs", {
        configResult: { cfg: {}, sourceLastTouchedVersion: sourceVersion },
        shouldRepair: mode !== "inspect",
        env,
        invalidatePluginMetadataSnapshot,
      });
      if (mode === "inspect") {
        expectNoCalls(mocks.maybeRunConfiguredPluginInstallReleaseStep, mocks.note);
      } else if (legacy) {
        expect(ctx.cfg.meta?.lastTouchedVersion).toBe(sourceVersion);
        expect(readConfigMachineState<string>("config.lastTouchedAt")).toEqual(expect.any(String));
      } else {
        const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
        expect(ids.indexOf("doctor:release-configured-plugin-installs")).toBeGreaterThan(-1);
        expect(ids.indexOf("doctor:plugin-registry")).toBeGreaterThan(-1);
        for (const [before, after] of [
          ["release-configured-plugin-installs", "plugin-registry"],
          ["plugin-registry", "write-config"],
          ["plugin-registry", "runtime-tool-schemas"],
        ]) {
          expect(ids.indexOf(`doctor:${before}`)).toBeLessThan(ids.indexOf(`doctor:${after}`));
        }
        expect(mocks.maybeRunConfiguredPluginInstallReleaseStep).toHaveBeenCalledWith({
          cfg: {},
          env,
          touchedVersion: sourceVersion,
        });
        expect(mocks.note).toHaveBeenCalledWith(
          "Installed configured plugin matrix.",
          "Doctor changes",
        );
        expect(ctx.cfg.meta?.lastTouchedVersion).toBe("2026.5.2-test");
        expect(invalidatePluginMetadataSnapshot).toHaveBeenCalledOnce();
      }
    },
  );

  it("runs the web fetch proxy diagnostic after security checks", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const contribution = requireDoctorContribution("doctor:web-fetch-proxy");
    const cfg = { gateway: { mode: "local" as const } };
    const env = { HTTPS_PROXY: "http://proxy.example:8080" };
    const ctx = createDoctorHealthFlowContext({ cfg, env });

    expect(ids.indexOf("doctor:security")).toBeLessThan(ids.indexOf("doctor:web-fetch-proxy"));
    await contribution.run(ctx);

    expect(mocks.noteWebFetchProxyDiagnostic).toHaveBeenCalledWith({ cfg, env });
  });

  it("keeps workspace status opt-in for structured lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:workspace-status");
    const check = contribution.healthChecks[0] as HealthCheck & { defaultEnabled?: boolean };
    expect(contribution.healthCheckIds).toEqual(["core/doctor/workspace-status"]);
    expect(check.defaultEnabled).toBe(false);

    const pluginVersionDrift = {
      gatewayVersion: "2026.6.1",
      drifts: [
        {
          pluginId: "codex",
          installedVersion: "2026.5.30-beta.1",
          gatewayVersion: "2026.6.1",
          source: "npm" as const,
          spec: "@openclaw/codex@2026.5.30-beta.1",
        },
      ],
    };
    mocks.gatherDaemonStatus.mockResolvedValueOnce({
      gateway: { version: "2026.6.1" },
      pluginVersionRestartReadiness: {
        status: "resolved",
        report: pluginVersionDrift,
        runningGatewayVersion: "2026.6.1",
      },
    });
    mocks.collectWorkspaceStatusHealthFindings.mockResolvedValueOnce([
      makeWarningFinding("workspace-status", { path: "plugins.entries.codex" }),
    ]);
    vi.mocked(fetchNpmPackageTargetStatus).mockResolvedValue({
      version: null,
      nodeEngine: null,
      error: "HTTP 404",
    });
    const ctx = createDoctorLintFixture(
      { plugins: { entries: { codex: { enabled: true } } } },
      { allowExecSecretRefs: true },
    );

    expect(mocks.collectWorkspaceStatusHealthFindings).not.toHaveBeenCalled();

    await expectSelectedLint(ctx, check, expectedFinding("workspace-status"));
    expect(mocks.collectWorkspaceStatusHealthFindings).toHaveBeenCalledWith(ctx.cfg, {
      pluginVersionReadiness: {
        status: "resolved",
        report: {
          ...pluginVersionDrift,
          drifts: [
            {
              ...pluginVersionDrift.drifts[0],
              targetResolution: expect.objectContaining({
                status: "unresolved",
                error: expect.stringContaining("HTTP 404"),
              }),
            },
          ],
        },
        runningGatewayVersion: "2026.6.1",
      },
    });
    expect(fetchNpmPackageTargetStatus).toHaveBeenCalledWith({
      packageName: "@openclaw/codex",
      target: "2026.6.1",
    });
    expect(mocks.gatherDaemonStatus).toHaveBeenCalledWith({
      rpc: { timeout: "3000", json: true },
      probe: true,
      requireRpc: false,
      deep: false,
      allowExecSecretRefs: true,
      pluginVersionTarget: "restart",
    });
  });

  it.each(["status failure", "remote gateway"] as const)(
    "omits plugin readiness for %s",
    async (scenario) => {
      const contribution = requireDoctorContribution("doctor:workspace-status");
      mocks.gatherDaemonStatus.mockRejectedValueOnce(new Error("service inspection failed"));
      const cfg: OpenClawConfig =
        scenario === "remote gateway"
          ? { gateway: { mode: "remote" }, plugins: { entries: { codex: { enabled: true } } } }
          : {};

      await contribution.run(createDoctorHealthFlowContext({ cfg }));

      if (scenario === "remote gateway") {
        expect(mocks.gatherDaemonStatus).not.toHaveBeenCalled();
      }
      expect(mocks.noteWorkspaceStatus).toHaveBeenCalledWith(cfg, {
        pluginVersionReadiness: undefined,
      });
    },
  );

  it("uses the read-only model catalog for hooks.gmail.model warnings", async () => {
    const cfg = { hooks: { gmail: { model: "openai/gpt-5.5" } } };
    await runDoctor("doctor:hooks-model", { cfg });

    expect(mocks.loadModelCatalog).toHaveBeenCalledWith({
      config: cfg,
      readOnly: true,
      providerDiscoveryProviderIds: [],
    });
  });

  it("materializes heartbeat cadence before scratch migration and final config writes", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);
    const cadenceIndex = ids.indexOf("doctor:heartbeat-cadence-migration");
    const scratchIndex = ids.indexOf("doctor:heartbeat-scratch-migration");

    expect(cadenceIndex).toBeGreaterThan(-1);
    expect(cadenceIndex).toBeLessThan(scratchIndex);
    expect(scratchIndex).toBeLessThan(ids.indexOf("doctor:write-config"));

    const contribution = requireDoctorContribution("doctor:heartbeat-cadence-migration");
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    await contribution.run(
      createDoctorHealthFlowContext({
        cfg,
        prompter: createDoctorPrompterFixture(true),
        env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
      }),
    );

    expect(mocks.maybeMigrateHeartbeatCadenceToCron).toHaveBeenCalledWith({
      cfg,
      shouldRepair: true,
      env: { OPENCLAW_STATE_DIR: "/tmp/openclaw-state" },
    });
  });

  it.each([
    ["heartbeat-cadence-migration", mocks.collectHeartbeatCadenceMigrationFindings],
    ["heartbeat-task-cron-migration", mocks.collectHeartbeatTaskMigrationFindings],
  ] as const)("forwards the health-check environment to %s", async (id, collect) => {
    const check = await requireDoctorHealthCheck(`core/doctor/${id}`);
    const cfg = { agents: { defaults: { heartbeat: { every: "15m" } } } };
    const env = { OPENCLAW_STATE_DIR: "/tmp/openclaw-detector-state" };

    await check.detect(createDoctorLintFixture(cfg, { env }));

    expect(collect).toHaveBeenCalledWith(cfg, env);
  });

  it("includes opt-in default-account diagnostics when all checks are requested", async () => {
    const contribution = requireDoctorContribution("doctor:default-account-routing");
    const check = contribution.healthChecks[0] as HealthCheck | undefined;
    expect(check).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture(
      createDoctorConfigFixture({
        channels: { telegram: { accounts: { alerts: {}, work: {} } } },
        bindings: [{ agentId: "ops", match: { channel: "telegram" } }],
      }),
    );

    await expect(
      runDoctorLintChecks(ctx, { checks: [check!], includeAllChecks: true }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
        expect.objectContaining({ checkId: "core/doctor/default-account-routing" }),
      ],
    });
  });

  it("preserves allow-exec Gateway SecretRef resolution in auth health", async () => {
    const ctx = await runDoctor("doctor:gateway-auth", {
      cfg: { gateway: { mode: "local", auth: { mode: "token", token: "exec-token" } } },
      options: { allowExec: true, nonInteractive: true },
      env: { OPENCLAW_TEST_GATEWAY_TOKEN: "1" },
      configPath: "/tmp/openclaw.json",
    });

    expect(mocks.resolveGatewayAuthToken).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        env: ctx.env,
        unresolvedReasonStyle: "detailed",
        envFallback: "never",
      }),
    );
    expectNote(
      "Gateway token SecretRef could not be resolved: exec provider failed",
      "Gateway auth",
    );
  });

  it("regenerates an invalid Gateway token", async () => {
    const token = "undefined";
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "token", token });
    mocks.resolveGatewayAuthToken.mockResolvedValue({ source: "config", token });
    const ctx = await runDoctor("doctor:gateway-auth", {
      cfg: { gateway: { mode: "local", auth: { mode: "token", token } } },
      options: { generateGatewayToken: true, nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    });

    expectNote("not a usable secret", "Gateway auth");
    expect(ctx.cfg.gateway?.auth?.token).toBe("generated-gateway-token");
  });

  it("preserves password auth during placeholder repair", async () => {
    mocks.resolveGatewayAuth.mockReturnValue({ mode: "password", token: "undefined" });
    const original = {
      mode: "password" as const,
      token: "undefined",
      password: "synthetic-password",
    };
    const ctx = createDoctorContext({
      cfg: { gateway: { mode: "local", auth: original } },
      options: { generateGatewayToken: true, nonInteractive: true },
    });
    await requireDoctorContribution("doctor:gateway-auth").run(ctx);
    expect(ctx.cfg.gateway?.auth).toEqual(original);
  });

  it("silently skips the host-service contribution in a container without an OpenClaw service", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue(null);
    await runDoctor("doctor:gateway-services", {
      cfg: { gateway: { mode: "local" } },
      prompter: createDoctorPrompterFixture(true),
    });

    expectNoCalls(
      mocks.maybeScanExtraGatewayServices,
      mocks.maybeResolveDuelingSystemdGatewayScopes,
      mocks.maybeRepairGatewayServiceConfig,
      mocks.note,
    );
  });

  it("hints how to enable authenticated GitHub project search", async () => {
    const contribution = requireDoctorContribution("doctor:github-projects");
    const ctx = createDoctorContext({ env: {}, configPath: "/tmp/openclaw.json" });

    await contribution.run(ctx);
    expectNote("gateway.controlUi.github.host matching gateway.github.host", "GitHub projects");

    mocks.note.mockClear();
    await contribution.run({ ...ctx, env: { GH_TOKEN: "configured" } });
    expect(mocks.note).not.toHaveBeenCalled();

    await contribution.run({
      ...ctx,
      cfg: {
        gateway: {
          controlUi: {
            github: {
              token: { source: "store", provider: "default", id: "CONTROL_UI_GITHUB" },
            },
          },
        },
      },
    });
    expect(mocks.note).not.toHaveBeenCalled();
  });

  it("grants Doctor-only state migration authority only in repair mode", async () => {
    const ids = resolveDoctorHealthContributions().map((entry) => entry.id);

    expect(ids.indexOf("doctor:legacy-state")).toBeLessThan(
      ids.indexOf("doctor:session-transcripts"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:agent-memory-schema"),
    );
    expect(ids.indexOf("doctor:session-transcripts")).toBeLessThan(
      ids.indexOf("doctor:plugin-registry"),
    );

    const cfg = { session: { store: "/tmp/shared-sessions.json" } };
    const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
    mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
    await runDoctor("doctor:legacy-state", {
      cfg,
      shouldRepair: true,
      options: { nonInteractive: true, repair: true },
      configPath: "/tmp/openclaw.json",
    });

    const detectParams = mocks.detectLegacyStateMigrations.mock.calls[0]?.[0] as
      | { legacySessionSurfaces?: unknown }
      | undefined;
    const legacySessionSurfaces = detectParams?.legacySessionSurfaces;
    expect(legacySessionSurfaces).toMatchObject({ failures: [], surfaces: expect.any(Array) });
    expect(mocks.detectLegacyStateMigrations).toHaveBeenCalledWith({
      cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
    expect(mocks.runLegacyStateMigrations).toHaveBeenCalledWith({
      detected,
      config: cfg,
      doctorOnlyStateMigrations: true,
      legacySessionSurfaces,
    });
  });

  it("renews exec approvals when an unrelated legacy migration is declined", async () => {
    mocks.detectLegacyStateMigrations.mockResolvedValue({
      preview: ["legacy sessions"],
      warnings: [],
      notices: [],
    });
    mocks.repairObsoleteGeneratedExecApprovals.mockReturnValue(1);
    await runDoctor("doctor:legacy-state", {
      shouldRepair: true,
      options: { repair: true },
      prompter: createDoctorPrompterFixture(false),
    });

    expect(mocks.runLegacyStateMigrations).not.toHaveBeenCalled();
    expect(mocks.repairObsoleteGeneratedExecApprovals).toHaveBeenCalledOnce();
    expectNote("removed 1 older generated approval", "Doctor changes");
  });

  it.each(["deferred", "refused"] as const)(
    "prints legacy state migration notices and records only advisories (%s)",
    async (outcome) => {
      const detected = { preview: ["legacy sessions"], warnings: [], notices: [] };
      mocks.detectLegacyStateMigrations.mockResolvedValue(detected);
      mocks.runLegacyStateMigrations.mockResolvedValue({
        changes: [],
        warnings: [],
        notices: ["Left reviewed legacy residue in place."],
        stepReceipts: [
          {
            id: "legacy-cleanup",
            phase: "final",
            source: [],
            target: [],
            requiredness: "required",
            reversibility: "checkpoint-required",
            outcome,
            changes: [],
            warnings: ["Legacy cleanup deferred; run openclaw doctor --fix"],
          },
        ],
      });
      const ctx = await runDoctor("doctor:legacy-state", {
        cfg: {},
        configResult: {},
        shouldRepair: true,
        options: { nonInteractive: true },
        configPath: "/tmp/openclaw.json",
      });

      expect(mocks.note).toHaveBeenCalledWith(
        "Left reviewed legacy residue in place.",
        "Doctor notices",
      );
      expect(ctx.updateWarnings ?? []).toEqual(
        outcome !== "refused" ? ["Legacy cleanup deferred; run openclaw doctor --fix"] : [],
      );
    },
  );

  it("cleans retired auth profiles before reporting profile health", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {
      auth: {
        profiles: {
          "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" as const },
        },
      },
    };
    const repairedCfg = {
      agents: {
        defaults: {
          models: { "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } } },
        },
      },
    };
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: repairedCfg,
      retiredProfileCleanupPlans: [
        { agentDir: "/tmp/openclaw/agents/main", profileIds: ["anthropic:claude-cli"] },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      cfgForPersistence: structuredClone(cfg),
      prompter: createDoctorPrompterFixture(true),
      options: { nonInteractive: true },
    });

    await requireDoctorContribution("doctor:auth-profile-migration").run(ctx);
    await contribution.run(ctx);

    expect(mocks.maybeRepairLegacyOAuthProfileIds).toHaveBeenCalledBefore(
      mocks.maybeMigrateModelCatalogCredentials,
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledWith(
      expect.objectContaining({ nextConfig: repairedCfg }),
    );
    expect(mocks.removeAuthProfilesAcrossOwnerStores).toHaveBeenCalledWith(
      expect.objectContaining({
        agentDir: "/tmp/openclaw/agents/main",
        profileIds: ["anthropic:claude-cli"],
      }),
    );
    expectBefore(mocks.replaceConfigFile, mocks.removeAuthProfilesAcrossOwnerStores);
    expectBefore(mocks.removeAuthProfilesAcrossOwnerStores, mocks.noteAuthProfileHealth);
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toBeUndefined();
    expect(ctx.configResult.explicitSetPaths).toContainEqual(["agents", "defaults", "models"]);
  });

  it("does not clean or report retired profiles when an update handoff skips persistence", async () => {
    const contribution = requireDoctorContribution("doctor:auth-profiles");
    const cfg = {};
    mocks.maybeRepairLegacyOAuthProfileIds.mockResolvedValue({
      config: { agents: { defaults: { model: { primary: "anthropic/claude-sonnet-4-6" } } } },
      retiredProfileCleanupPlans: [
        { agentDir: "/tmp/openclaw/agents/main", profileIds: ["anthropic:claude-cli"] },
      ],
    });
    const ctx = createDoctorHealthFlowContext({
      cfg,
      env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
      prompter: createDoctorPrompterFixture(true),
    });

    await requireDoctorContribution("doctor:auth-profile-migration").run(ctx);
    await contribution.run(ctx);

    expectNoCalls(
      mocks.replaceConfigFile,
      mocks.removeAuthProfilesAcrossOwnerStores,
      mocks.noteAuthProfileHealth,
    );
    expect(ctx.configResult.retiredAuthProfileCleanupPlans).toHaveLength(1);
  });

  it.each([
    {
      id: "auth-profiles",
      cfg: { auth: { profiles: {} } },
      collector: mocks.collectAuthProfileHealthFindings,
      prepare: () => {
        expect(requireDoctorContribution("doctor:auth-profiles").healthCheckIds).toEqual([
          "core/doctor/auth-profiles",
        ]);
      },
      expected: {},
      args: (ctx: ReturnType<typeof createDoctorLintFixture>) => [
        { cfg: ctx.cfg, allowKeychainPrompt: false },
      ],
    },
    {
      id: "stale-plugin-runtime-symlinks",
      collector: mocks.collectStalePluginRuntimeSymlinkHealthFindings,
      prepare: () =>
        mocks.collectStalePluginRuntimeSymlinkHealthFindings.mockResolvedValueOnce([
          makeWarningFinding("stale-plugin-runtime-symlinks", {
            path: "/tmp/node_modules/left-pad",
          }),
        ]),
      expected: expectedFinding("stale-plugin-runtime-symlinks", {
        path: "/tmp/node_modules/left-pad",
      }),
    },
    {
      id: "workspace-suggestions",
      collector: mocks.collectWorkspaceBackupTip,
      prepare: () =>
        mocks.collectWorkspaceBackupTip.mockReturnValueOnce(
          "Back up your workspace before major repair work.",
        ),
      expected: expectedFinding("workspace-suggestions", {
        severity: "info",
        message: "Back up your workspace before major repair work.",
      }),
      args: () => ["/tmp/openclaw-workspace"],
    },
    {
      id: "disk-space",
      collector: mocks.collectDiskSpaceHealthFindings,
      prepare: () =>
        mocks.collectDiskSpaceHealthFindings.mockReturnValueOnce([
          makeWarningFinding("disk-space"),
        ]),
      expected: expectedFinding("disk-space"),
      args: () => [],
    },
    {
      id: "device-pairing",
      cfg: { gateway: { mode: "local" } },
      collector: mocks.collectDevicePairingHealthFindings,
      expected: {},
      args: (ctx: ReturnType<typeof createDoctorLintFixture>) => [
        { cfg: ctx.cfg, healthOk: false, env: ctx.env },
      ],
    },
    {
      id: "legacy-cron-store",
      cfg: { cron: { store: "/tmp/openclaw-cron/jobs.json" } },
      collector: mocks.collectLegacyCronStoreHealthFindings,
      prepare: () => {
        expect(requireDoctorContribution("doctor:legacy-cron").healthCheckIds).toEqual([
          "core/doctor/legacy-whatsapp-crontab",
          "core/doctor/legacy-cron-store",
        ]);
        mocks.collectLegacyCronStoreHealthFindings.mockResolvedValueOnce([
          makeWarningFinding("legacy-cron-store"),
        ]);
      },
      expected: expectedFinding("legacy-cron-store"),
      args: (ctx: ReturnType<typeof createDoctorLintFixture>) => [{ cfg: ctx.cfg }],
    },
    {
      id: "legacy-whatsapp-crontab",
      collector: mocks.collectLegacyWhatsAppCrontabHealthWarning,
      prepare: () =>
        mocks.collectLegacyWhatsAppCrontabHealthWarning.mockResolvedValueOnce(
          "Legacy WhatsApp crontab health check detected.\nRemove the stale crontab entry.",
        ),
      expected: expectedFinding("legacy-whatsapp-crontab", { severity: "warning" }),
    },
    {
      id: "channel-plugin-blockers",
      cfg: { channels: { discord: { enabled: true } } },
      collector: mocks.scanConfiguredChannelPluginBlockers,
      prepare: () =>
        mocks.scanConfiguredChannelPluginBlockers.mockReturnValue([
          { channelId: "discord", pluginId: "discord", reason: "missing explicit enablement" },
        ]),
      expected: expectedFinding("channel-plugin-blockers", {
        path: "channels.discord",
        target: "discord",
      }),
      args: (ctx: ReturnType<typeof createDoctorLintFixture>) => [ctx.cfg, process.env],
    },
  ])(
    "keeps $id opt-in and delegates selected lint to its owner",
    async ({ id, cfg = {}, collector, prepare, expected, args }) => {
      const checkId = `core/doctor/${id}`;
      const check = await requireDoctorHealthCheck(checkId);
      expect(check).toMatchObject({ id: checkId, kind: "core", defaultEnabled: false });
      prepare?.();
      const ctx = createDoctorLintFixture(cfg);
      expect(collector).not.toHaveBeenCalled();

      await expectSelectedLint(ctx, check, { ...expected });
      expect(collector).toHaveBeenCalledTimes(1);
      if (args) {
        expect(collector).toHaveBeenCalledWith(...args(ctx));
      }
    },
  );

  it("forwards skipped Gateway health to daemon repair", async () => {
    const ctx = await runDoctor("doctor:gateway-daemon", {
      gatewayDetails: { message: "gateway details" },
      gatewayHealthSkipped: true,
      healthOk: false,
      shouldRepair: true,
      options: { nonInteractive: true },
      configPath: "/tmp/openclaw.json",
    } as unknown as Parameters<typeof createDoctorContext>[0]);

    expect(mocks.maybeRepairGatewayDaemon).toHaveBeenCalledWith(
      expect.objectContaining({
        cfg: ctx.cfg,
        runtime: ctx.runtime,
        prompter: ctx.prompter,
        options: ctx.options,
        gatewayDetailsMessage: "gateway details",
        healthOk: false,
        healthSkipped: true,
      }),
    );
  });

  it("preserves interactive linger repair for a user-scoped Gateway service", async () => {
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const ctx = createDoctorContext({ cfg: { gateway: { mode: "local" } } });

    await withProcessPlatform("linux", async () => {
      await contribution.run(ctx);
    });

    expect(mocks.readSystemdUserLingerStatus).toHaveBeenCalledOnce();
  });

  it("keeps selected systemd linger quiet when the gateway service is not loaded", async () => {
    mocks.gatewayServiceIsLoaded.mockResolvedValue(false);
    const systemdLingerCheck = await requireDoctorHealthCheck("core/doctor/systemd-linger");

    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

    await withProcessPlatform("linux", async () => {
      await expectSelectedLint(ctx, systemdLingerCheck!, { findings: [] });
    });
    expect(mocks.readSystemdUserLingerStatus).not.toHaveBeenCalled();
  });

  it("skips user lingering for a reachable system-scoped Gateway service in a container", async () => {
    mocks.isContainerEnvironment.mockReturnValue(true);
    mocks.findInstalledSystemdGatewayScope.mockResolvedValue({
      scope: "system",
      unitName: "openclaw-gateway.service",
      unitPath: "/etc/systemd/system/openclaw-gateway.service",
    });
    const contribution = requireDoctorContribution("doctor:systemd-linger");
    const checks = await resolveDoctorContributionHealthChecks();
    const lingerCheck = checks.find((check) => check.id === "core/doctor/systemd-linger");
    expect(lingerCheck).toBeDefined();
    const lintResult = await withProcessPlatform("linux", async () => {
      await contribution.run(createDoctorContext({ cfg: { gateway: { mode: "local" } } }));
      return await runDoctorLintChecks(createDoctorLintFixture({ gateway: { mode: "local" } }), {
        checks: [lingerCheck!],
        onlyIds: ["core/doctor/systemd-linger"],
      });
    });

    expect(mocks.findInstalledSystemdGatewayScope).toHaveBeenCalledTimes(2);
    expectNoCalls(
      mocks.gatewayServiceIsLoaded,
      mocks.isSystemdUserServiceAvailable,
      mocks.readSystemdUserLingerStatus,
    );
    expect(lintResult).toMatchObject({ checksRun: 1, findings: [] });
    expect(JSON.stringify(lintResult)).not.toContain("loginctl enable-linger");
  });

  it("reports the Gateway service owner under sudo-to-root", async () => {
    mocks.resolveSystemdUserServiceAccount.mockReturnValue("debian");
    mocks.readSystemdUserLingerStatus.mockImplementation(async (params) =>
      params?.user === "debian" ? { user: "debian", linger: "no" } : null,
    );
    const systemdLingerCheck = await requireDoctorHealthCheck("core/doctor/systemd-linger");
    const ctx = createDoctorLintFixture({ gateway: { mode: "local" } });

    await withProcessPlatform("linux", async () => {
      await expect(
        runDoctorLintChecks(ctx, {
          checks: [systemdLingerCheck!],
          onlyIds: ["core/doctor/systemd-linger"],
        }),
      ).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            fixHint: "Run: sudo loginctl enable-linger debian",
            target: "systemd.user.debian",
          }),
        ],
      });
    });
  });

  it("preserves the shipped legacy dependency selector as a non-destructive deprecation", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-legacy-plugin-deps-lint-",
    });
    const stateDir = openClawState.stateDir;
    const legacyRuntimeRoot = nodePath.join(stateDir, "plugin-runtime-deps");
    fs.mkdirSync(legacyRuntimeRoot, { recursive: true });
    try {
      const check = await requireDoctorHealthCheck("core/doctor/legacy-plugin-dependencies");
      expect(check).toMatchObject({ defaultEnabled: false });

      const ctx = createDoctorLintFixture();

      await expectSelectedLint(
        ctx,
        check!,
        expectedFinding("legacy-plugin-dependencies", {
          severity: "info",
          message:
            "Deprecated check: Doctor preserves shared plugin runtime caches and no longer scans them for removal.",
        }),
      );
      expect(fs.existsSync(legacyRuntimeRoot)).toBe(true);
    } finally {
      await openClawState.cleanup();
    }
  });

  it("collects memory-search findings from the diagnostic owner", async () => {
    const contribution = requireDoctorContribution("doctor:memory-search");
    const check = contribution.healthChecks[0] as HealthCheck;
    const ctx = createDoctorLintFixture(
      {},
      { env: { OPENCLAW_STATE_DIR: "/isolated-memory-state" } },
    );
    const findings = [
      makeWarningFinding("memory-search", {
        path: "memory.search.provider",
        message: 'Memory search provider is set to "openai" but no API key was found.',
        fixHint: "- Set OPENAI_API_KEY in your environment",
      }),
    ];
    mocks.collectMemorySearchHealthFindings.mockResolvedValueOnce(findings);

    expect(await check.detect(ctx)).toEqual(findings);
    expect(contribution.healthCheckIds).toEqual(["core/doctor/memory-search"]);
    expect((check as HealthCheck & { defaultEnabled?: boolean }).defaultEnabled).toBe(false);
    expect(mocks.collectMemorySearchHealthFindings).toHaveBeenCalledWith(ctx);
    expect(mocks.noteMemorySearchHealth).not.toHaveBeenCalled();
  });

  it("forwards the interactive Doctor environment to memory provider discovery", async () => {
    const env = { OPENCLAW_STATE_DIR: "/interactive-memory-state" };
    await runDoctor("doctor:memory-search", { env });

    expect(mocks.noteMemorySearchHealth).toHaveBeenCalledWith({}, expect.objectContaining({ env }));
  });

  it.each([
    { name: "secondary agent", agentIds: ["default", "secondary"], prefix: 'Agent "secondary": ' },
    { name: "single agent", agentIds: ["secondary"], prefix: "" },
  ])("labels workspace suggestions for $name", async ({ agentIds, prefix }) => {
    const contribution = requireDoctorContribution("doctor:workspace-suggestions");
    const cfg = {} as OpenClawConfig;
    const ctx = createDoctorContext({ cfg, env: {} });
    mocks.listAgentIds.mockReturnValue(agentIds);
    mocks.resolveAgentWorkspaceDir.mockImplementation((_cfg, agentId) => `/tmp/${agentId}`);
    mocks.collectWorkspaceBackupTip.mockImplementation((workspaceDir) =>
      workspaceDir === "/tmp/secondary" ? "- Back up this workspace." : undefined,
    );
    mocks.shouldSuggestMemorySystem.mockImplementation(
      async (workspaceDir) => workspaceDir === "/tmp/secondary",
    );

    await contribution.run(ctx);

    expect(mocks.note).toHaveBeenNthCalledWith(
      1,
      `${prefix}- Back up this workspace.`,
      "Workspace",
    );
    expect(mocks.note).toHaveBeenNthCalledWith(
      2,
      `${prefix}Enable memory system for better recall.`,
      "Workspace",
    );
    expect(mocks.note).toHaveBeenCalledTimes(2);
  });

  it("keeps WhatsApp responsiveness opt-in for default lint selection", async () => {
    const whatsappCheck = await requireDoctorHealthCheck("core/doctor/whatsapp-responsiveness");
    expect(whatsappCheck).toMatchObject({ defaultEnabled: false });

    const ctx = createDoctorLintFixture(
      { channels: { whatsapp: { enabled: true } } },
      { allowExecSecretRefs: true },
    );
    expectNoCalls(
      mocks.checkGatewayHealth,
      mocks.callGateway,
      mocks.collectWhatsappResponsivenessHealthFindings,
    );

    const status = { eventLoop: { degraded: true } };
    mocks.callGateway.mockResolvedValueOnce(status);
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([
      makeWarningFinding("whatsapp-responsiveness", {
        path: "channels.whatsapp",
        requirement: "local-tui-event-loop-pressure",
      }),
    ]);

    await expectSelectedLint(ctx, whatsappCheck, expectedFinding("whatsapp-responsiveness"));
    expect(mocks.checkGatewayHealth).not.toHaveBeenCalled();
    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "status",
      params: { includeChannelSummary: false },
      timeoutMs: 3000,
      config: ctx.cfg,
      deviceIdentity: null,
    });
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status,
    });

    mocks.callGateway.mockRejectedValueOnce(new Error("gateway unavailable"));
    mocks.collectWhatsappResponsivenessHealthFindings.mockReturnValueOnce([]);
    const error = vi.fn();
    await expectSelectedLint(
      { ...ctx, runtime: { log: vi.fn(), error, exit: vi.fn() } },
      whatsappCheck,
      { findings: [] },
    );
    expect(error).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenLastCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("skips WhatsApp responsiveness Gateway status probes for exec SecretRefs without allow-exec", async () => {
    const whatsappCheck = await requireDoctorHealthCheck("core/doctor/whatsapp-responsiveness");
    mocks.gatewaySecretInputPathCanWin.mockReturnValue(true);
    mocks.readGatewaySecretInputValue.mockReturnValue("exec-token");

    const ctx = createDoctorLintFixture({ channels: { whatsapp: { enabled: true } } });
    await expectSelectedLint(ctx, whatsappCheck, { findings: [] });
    expect(mocks.callGateway).not.toHaveBeenCalled();
    expect(mocks.collectWhatsappResponsivenessHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      status: undefined,
    });
  });

  it("defers channel package-state loading only until post-core plugin convergence", async () => {
    const contribution = requireDoctorContribution("doctor:channel-package-state-capabilities");
    mocks.collectBundledChannelPackageStateLoadFailures.mockReturnValue([
      {
        detail: "plugin module path not found: /plugins/example-chat/auth-presence",
        metadataKey: "persistedAuthState",
        pluginId: "example-chat",
      },
    ]);
    mocks.runDoctorHealthRepairs.mockImplementation(async (ctx, options) => {
      const findings = await options.checks[0]!.detect(ctx);
      return repairResult({
        config: ctx.cfg,
        findings,
        remainingFindings: findings,
        checksRun: 1,
      });
    });
    vi.stubEnv("OPENCLAW_UPDATE_IN_PROGRESS", "1");
    vi.stubEnv("OPENCLAW_UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR", "1");
    const ctx = createDoctorContext();

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).not.toHaveBeenCalled();

    vi.stubEnv("OPENCLAW_UPDATE_POST_CORE_CONVERGENCE", "1");

    await contribution.run(ctx);

    expect(mocks.collectBundledChannelPackageStateLoadFailures).toHaveBeenCalledOnce();
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      expect.stringContaining("core/doctor/channel-package-state-capabilities"),
    );
  });

  it("keeps channel preview warnings opt-in for default lint selection", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    expect(contribution.healthCheckIds).toEqual([
      "core/doctor/channel-plugin-blockers",
      "core/doctor/channel-preview-warnings",
    ]);
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toMatchObject({ defaultEnabled: false });
    mocks.collectChannelPreviewWarningHealthFindings.mockResolvedValue([
      {
        checkId: "core/doctor/channel-preview-warnings",
        severity: "warning",
        message: "channels.matrix has a preview warning",
        path: "channels.matrix",
      },
    ]);

    const ctx = createDoctorLintFixture({ channels: { matrix: { enabled: true } } });
    const checks = [previewWarningsCheck!];

    expect(mocks.collectChannelPreviewWarningHealthFindings).not.toHaveBeenCalled();

    await expect(
      runDoctorLintChecks(ctx, { checks, onlyIds: ["core/doctor/channel-preview-warnings"] }),
    ).resolves.toMatchObject({
      checksRun: 1,
      checksSkipped: 0,
      findings: [
        expect.objectContaining({
          checkId: "core/doctor/channel-preview-warnings",
          path: "channels.matrix",
        }),
      ],
    });
    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: false,
    });
  });

  it("forwards allow-exec secret refs into channel preview warnings", async () => {
    const contribution = requireDoctorContribution("doctor:startup-channel-maintenance");
    const previewWarningsCheck = contribution.healthChecks.find(
      (check) => check.id === "core/doctor/channel-preview-warnings",
    ) as HealthCheck | undefined;
    expect(previewWarningsCheck).toBeDefined();
    const ctx = createDoctorLintFixture(
      { channels: { matrix: { enabled: true } } },
      { allowExecSecretRefs: true },
    );

    await previewWarningsCheck!.detect(ctx);

    expect(mocks.collectChannelPreviewWarningHealthFindings).toHaveBeenCalledWith({
      cfg: ctx.cfg,
      allowExec: true,
    });
  });

  it("lets structured health own execution when legacy run is omitted", async () => {
    const healthChecks = { description: "test structured run", detect: vi.fn(async () => []) };
    mocks.runDoctorHealthRepairs.mockResolvedValue(
      repairResult({
        config: { updated: true },
        changes: ["changed from structured health"],
        warnings: ["structured warning"],
        checksRun: 1,
        checksRepaired: 1,
        checksValidated: 0,
      }),
    );
    const contribution = createDoctorHealthContribution(
      "doctor:test-structured-run",
      "Test structured run",
      { healthChecks },
    );
    const ctx = createDoctorContext({
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
    });

    await contribution.run(ctx);

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/openclaw-workspace",
        configPath: "/tmp/fake-openclaw.json",
      }),
      { checks: contribution.healthChecks, dryRun: false },
    );
    expect(ctx.cfg).toEqual({ updated: true });
    expect(ctx.cfgForPersistence).toEqual({});
    expect(ctx.runtime.error).toHaveBeenCalledWith("structured warning");
    expect(ctx.runtime.log).not.toHaveBeenCalledWith("changed from structured health");
    expect(ctx.configResult.pendingChangePanels).toEqual(["changed from structured health"]);
  });

  it("leaves workspace scope unset for explicit multi-agent config", async () => {
    mocks.tryResolveSoleAgentId.mockReturnValue(undefined);
    const runWithPluginMetadataSnapshot = vi.fn((_scope: unknown, run: () => unknown) =>
      run(),
    ) as unknown as NonNullable<DoctorContributionRunContext["runWithPluginMetadataSnapshot"]>;
    const contribution = createDoctorHealthContribution(
      "doctor:test-workspace-scope",
      "Test workspace scope",
      { healthChecks: { description: "test workspace scope", detect: vi.fn(async () => []) } },
    );
    const ctx = createDoctorContext({
      configResult: { cfg: {} },
      cfgForPersistence: {},
      cfg: { agents: { ownership: "explicit" } },
      shouldRepair: true,
      env: {},
      runWithPluginMetadataSnapshot,
    });

    await runDoctorHealthContributionList(ctx, [contribution]);

    expect(runWithPluginMetadataSnapshot).toHaveBeenCalledWith(
      { config: ctx.cfg, workspaceDir: undefined },
      expect.any(Function),
    );
    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: undefined }),
      { checks: contribution.healthChecks, dryRun: false },
    );
    expect(mocks.resolveAgentWorkspaceDir).not.toHaveBeenCalled();
  });

  it("renders findings from structured health when legacy run is omitted", async () => {
    const healthChecks = {
      description: "test structured findings",
      detect: vi.fn(async () => []),
    };
    mocks.runDoctorHealthRepairs.mockResolvedValue(
      repairResult({
        config: {},
        findings: [
          {
            checkId: "core/doctor/test-structured-findings",
            severity: "warning",
            message: "structured finding needs attention",
            path: "openclaw.json",
            line: 12,
            fixHint: "run openclaw doctor --fix",
          },
        ],
        checksRun: 1,
        checksValidated: 0,
      }),
    );
    const contribution = createDoctorHealthContribution(
      "doctor:test-structured-findings",
      "Test structured findings",
      { healthChecks },
    );
    const ctx = createDoctorContext({ cfgForPersistence: {}, configResult: { cfg: {} } });

    await contribution.run(ctx);

    expect(ctx.runtime.log).toHaveBeenCalledWith(
      "[warning] core/doctor/test-structured-findings openclaw.json:12 - structured finding needs attention",
    );
    expect(ctx.runtime.log).toHaveBeenCalledWith("  fix: run openclaw doctor --fix");
  });

  it("requires explicit health check ids for multi-check contributions", () => {
    expect(() =>
      createDoctorHealthContribution("doctor:test-multiple-checks", "Test multiple checks", {
        healthChecks: [
          { description: "first", detect: vi.fn(async () => []) },
          { description: "second", detect: vi.fn(async () => []) },
        ],
      }),
    ).toThrow("must specify health check ids when it declares multiple healthChecks");
  });

  it("skips opt-in extension checks during routine repair", async () => {
    setRegisteredHealthChecks([
      { id: "core/example/internal", kind: "core" },
      { id: "plugin/example/regular", kind: "plugin" },
      { id: "plugin/example/opt-in", kind: "plugin", defaultEnabled: false },
    ]);
    await runDoctor("doctor:structured-health-repairs", {
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: { OPENCLAW_UPDATE_POST_CORE: "1" },
    });

    expect(mocks.runDoctorHealthRepairs).toHaveBeenCalledWith(
      expect.objectContaining({ env: { OPENCLAW_UPDATE_POST_CORE: "1" } }),
      { checks: [getHealthCheck("plugin/example/regular")] },
    );
  });

  it("retains extension repair warnings without resolved or non-warning findings", async () => {
    const checkId = "plugin/example/probe";
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({
      configResult: { cfg: {} },
      cfgForPersistence: {},
      shouldRepair: true,
      env: { OPENCLAW_UPDATE_POST_CORE: "1" },
      updateWarnings: ["earlier warning"],
    });
    const remainingFindings: HealthFinding[] = [
      { checkId, severity: "warning", message: "optional maintenance incomplete" },
      { checkId, severity: "error", message: "required artifact missing" },
      { checkId, severity: "info", message: "optional setup is available" },
    ];
    mocks.runDoctorHealthRepairs.mockResolvedValue({
      config: {},
      changes: [],
      warnings: ["optional repair unavailable"],
      remainingFindings,
      findings: [
        ...remainingFindings,
        { checkId, severity: "warning", message: "already repaired" },
      ],
    });

    await contribution.run(ctx);

    expect(ctx.updateWarnings).toEqual([
      "earlier warning",
      `${checkId}: optional maintenance incomplete`,
      "optional repair unavailable",
    ]);
    expect(ctx.runtime.log).toHaveBeenCalledWith(
      `[warning] ${checkId} - optional maintenance incomplete`,
    );
    expect(ctx.runtime.error).toHaveBeenCalledWith(
      `[error] ${checkId} - required artifact missing`,
    );
    expect(ctx.runtime.exit).not.toHaveBeenCalled();
  });

  it.each(["warning", "info"] as const)(
    "records %s finding-only output without changing health or exit policy",
    async (severity) => {
      const check = CORE_HEALTH_CHECKS.find(
        (entry) => entry.id === "core/doctor/model-references",
      )!;
      vi.spyOn(check, "detect").mockResolvedValue([
        { checkId: check.id, severity, message: "configured model needs attention" },
      ]);
      const ctx = await runDoctor("doctor:model-references", {
        healthOk: true,
        updateWarnings: ["earlier warning"],
      });

      expect(ctx.updateWarnings).toEqual([
        "earlier warning",
        ...(severity === "warning" ? [`${check.id}: configured model needs attention`] : []),
      ]);
      expect(ctx.healthOk).toBe(severity === "info");
      expect(mocks.note).toHaveBeenCalledWith(
        "- configured model needs attention",
        severity === "info" ? "Doctor information" : "Doctor warnings",
      );
      expect(ctx.runtime.exit).not.toHaveBeenCalled();
    },
  );

  it("rejects extension repairs that claim reserved core doctor ids", async () => {
    setRegisteredHealthChecks([
      { id: "plugin/example/unrelated", kind: "plugin" },
      { id: "core/doctor/shell-completion", kind: "plugin" },
    ]);
    const contribution = requireDoctorContribution("doctor:structured-health-repairs");
    const ctx = createDoctorContext({ shouldRepair: true, env: {} });

    await expect(contribution.run(ctx)).rejects.toThrow(
      "health check already registered: core/doctor/shell-completion",
    );
    expect(mocks.runDoctorHealthRepairs).not.toHaveBeenCalled();
  });

  describe("write-config lint findings", () => {
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const check = writeConfigContribution.healthChecks[0] as HealthCheck & {
      defaultEnabled?: boolean;
    };

    function lintWriteConfig(configPath = "/tmp/openclaw-home/openclaw.json") {
      return runDoctorLintChecks(createDoctorLintFixture({}, { configPath }), {
        checks: [check],
        onlyIds: ["core/doctor/write-config"],
      });
    }

    it.each([
      ["OPENCLAW_NIX_MODE", "OpenClaw is running in Nix mode"],
      ["OPENCLAW_CONFIG_READONLY", "config is externally managed"],
    ])("reports immutable config mode selected by %s", async (envKey, reason) => {
      vi.stubEnv(envKey, "1");

      await expect(lintWriteConfig("/tmp/fake-openclaw.json")).resolves.toMatchObject({
        checksRun: 1,
        checksSkipped: 0,
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            message: `Doctor config writes are disabled because ${reason}.`,
            path: "/tmp/fake-openclaw.json",
            requirement: "mutable-config-write-path",
          }),
        ],
      });
    });

    it("reports an unwritable config directory for an existing config", async () => {
      const configPath = "/tmp/openclaw-home/openclaw.json";
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === configPath);
      vi.spyOn(fs, "statSync").mockReturnValue({ isDirectory: () => true } as fs.Stats);
      vi.spyOn(fs, "accessSync").mockImplementation(() => {
        throw new Error("EACCES");
      });

      await expect(lintWriteConfig(configPath)).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: configPath,
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports an existing parent without search permission", async () => {
      const configPath = nodePath.join(process.cwd(), ".doctor-missing-x/openclaw.json");
      vi.spyOn(fs, "accessSync").mockImplementation((_path, mode) => {
        if (mode === (fs.constants.W_OK | fs.constants.X_OK)) {
          throw new Error("EACCES");
        }
      });

      await expect(lintWriteConfig(configPath)).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: process.cwd(),
            target: nodePath.dirname(configPath),
            requirement: "writable-config-directory",
          }),
        ],
      });
    });

    it("reports a dangling symlink that blocks the config directory path", async () => {
      vi.spyOn(fs, "existsSync").mockImplementation((path) => path === "/tmp");
      vi.spyOn(fs, "lstatSync").mockImplementation((path) => {
        if (path === "/tmp/openclaw-home") {
          return { isDirectory: () => false } as fs.Stats;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      vi.spyOn(fs, "statSync").mockImplementation(() => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });
      const accessSpy = vi.spyOn(fs, "accessSync").mockImplementation(() => undefined);

      await expect(lintWriteConfig()).resolves.toMatchObject({
        findings: [
          expect.objectContaining({
            checkId: "core/doctor/write-config",
            path: "/tmp/openclaw-home",
            target: "/tmp/openclaw-home",
            requirement: "config-directory-path",
          }),
        ],
      });
      expect(accessSpy).not.toHaveBeenCalled();
    });
  });

  it("preserves gateway service config repairs for later doctor writes", async () => {
    const migrationWriteContribution = requireDoctorContribution("doctor:write-config-migrations");
    const gatewayServicesContribution = requireDoctorContribution("doctor:gateway-services");
    const writeConfigContribution = requireDoctorContribution("doctor:write-config");
    const originalCfg = { gateway: {} };
    const { config: repairedCfg, repair } = createGatewayWriterFixture("recovered-token");
    mocks.maybeRepairGatewayServiceConfig.mockImplementationOnce(repair);

    const ctx = createDoctorContext({
      cfg: originalCfg,
      cfgForPersistence: originalCfg,
      configResult: {
        cfg: originalCfg,
        preservedLegacyRootKeys: ["defaultModel"],
        shouldWriteConfig: true,
        skipPluginValidationOnWrite: true,
      },
      shouldRepair: true,
      options: { allowExec: true },
      env: {},
    });

    await migrationWriteContribution.run(ctx);
    await gatewayServicesContribution.run(ctx);
    expect(ctx.cfgForPersistence).toEqual(repairedCfg);
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    await writeConfigContribution.run(ctx);

    expect(ctx.cfg).toBe(repairedCfg);
    expect(mocks.maybeRepairGatewayServiceConfig).toHaveBeenCalledWith(
      originalCfg,
      "local",
      ctx.runtime,
      ctx.prompter,
      expect.objectContaining({ allowExecSecretRefs: true, writeConfig: expect.any(Function) }),
    );
    expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
    expectWrite(
      { expectedConfigPath: ctx.configPath },
      {
        nextConfig: originalCfg,
        baseHash: "planning-revision",
      },
      1,
    );
    expectWrite(
      {
        expectedConfigPath: ctx.configPath,
        allowConfigSizeDrop: true,
        preservedLegacyRootKeys: ["defaultModel"],
        skipPluginValidation: true,
      },
      { nextConfig: repairedCfg, baseHash: "committed-revision" },
      2,
    );
  });

  it("does not commit deferred cron migration when the config write fails", async () => {
    mocks.replaceConfigFile.mockRejectedValueOnce(new Error("config write failed"));
    const ctx = createDeferredCronContext(true);

    await expect(requireDoctorContribution("doctor:write-config").run(ctx)).rejects.toThrow(
      "config write failed",
    );
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();
  });

  it("keeps deferred legacy cron migration after the early write without repair mode", async () => {
    const retiredModelRefConfig = { agents: { defaults: { model: "openai/retired-model" } } };
    const ctx = createDeferredCronContext(false, retiredModelRefConfig);
    const cfg = ctx.cfg;

    await requireDoctorContribution("doctor:write-config-migrations").run(ctx);

    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).not.toHaveBeenCalled();

    await requireDoctorContribution("doctor:write-config").run(ctx);

    expect(mocks.replaceConfigFile).toHaveBeenCalledOnce();
    expect(mocks.repairCronCodexModelRefsAfterConfigWrite).toHaveBeenCalledWith({
      cfg,
      retiredModelRefConfig,
      migrateCodexModelRefs: true,
      repairRetiredModelRefs: false,
      blockedModelIdentities: new Set(["codex\u0000gpt-5.6-sol"]),
    });
    expect(mocks.replaceConfigFile.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.repairCronCodexModelRefsAfterConfigWrite.mock.invocationCallOrder[0] ?? 0,
    );
  });

  describe("config size drops during update", () => {
    const existsSync = fs.existsSync;
    const preUpdateBackupPath = "/tmp/fake-openclaw.json.pre-update";

    beforeEach(() => {
      mocks.replaceConfigFile.mockReset().mockResolvedValue(undefined);
      mocks.applyWizardMetadata.mockImplementation((cfg: unknown) => cfg);
      vi.spyOn(fs, "existsSync").mockImplementation((value) =>
        String(value) === preUpdateBackupPath ? false : existsSync(value),
      );
    });

    function buildWriteConfigCtx(env: Record<string, string | undefined>) {
      const cfg: OpenClawConfig = { gateway: { mode: "local" } };
      return createDoctorContext({
        cfg,
        cfgForPersistence: { gateway: { mode: "remote" } },
        configResult: { cfg, shouldWriteConfig: true, skipPluginValidationOnWrite: false },
        shouldRepair: true,
        env,
      });
    }

    const writeConfigContribution = resolveDoctorHealthContributions().find(
      (entry) => entry.id === "doctor:write-config",
    )!;

    it("preserves source config version for legacy parent writable update doctor writes", async () => {
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });
      ctx.configResult.sourceLastTouchedVersion = "2026.5.16-beta.4";

      await writeConfigContribution.run(ctx);

      expectWrite({
        auditOrigin: "doctor",
        allowConfigSizeDrop: true,
        skipPluginValidation: true,
        lastTouchedVersionOverride: "2026.5.16-beta.4",
      });
    });

    it("consumes committed roster format while preserving later explicit edits", async () => {
      const ctx = buildWriteConfigCtx({});
      ctx.cfg.agents = { ownership: "explicit", entries: { default: {} } };
      ctx.configResult.persistCanonicalAgentRoster = true;
      ctx.configResult.explicitSetPaths = [["agents", "ownership"]];

      await writeConfigContribution.run(ctx);

      expectWrite(
        {
          persistCanonicalAgentRoster: true,
          explicitSetPaths: [["agents", "ownership"]],
        },
        {},
        1,
      );

      expect(ctx.configResultWriteCommitted).toBe(true);
      expect(ctx.configResult.persistCanonicalAgentRoster).toBe(true);

      ctx.cfg = { ...ctx.cfg, gateway: { mode: "remote" } };
      await writeConfigContribution.run(ctx);

      expect(mocks.replaceConfigFile).toHaveBeenCalledTimes(2);
      expectWrite(
        {
          persistCanonicalAgentRoster: undefined,
          explicitSetPaths: [["agents", "ownership"]],
        },
        {},
        2,
      );
    });

    it("points update-time config rewrites at the pre-update backup", async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        (value) => String(value) === preUpdateBackupPath || existsSync(value),
      );
      const ctx = buildWriteConfigCtx({
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE: "1",
      });

      await writeConfigContribution.run(ctx);

      expect(ctx.runtime.log).toHaveBeenCalledWith(
        "Update changed config; pre-update backup: /tmp/fake-openclaw.json.pre-update",
      );
    });

    it("skips plugin schema validation for final validation during update doctor runs", async () => {
      const contribution = requireDoctorContribution("doctor:final-config-validation");

      await contribution.run(
        createDoctorContext({
          cfg: {},
          cfgForPersistence: {},
          configResult: { cfg: {} },
          shouldRepair: true,
          env: { OPENCLAW_UPDATE_IN_PROGRESS: "1" },
        }),
      );

      expect(mocks.readConfigFileSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ skipPluginValidation: true }),
      );
    });
  });
  describe("Doctor contribution migration outcomes", () => {
    function receipt(outcome: "refused" | "warning"): LegacyStateMigrationStepReceipt {
      const message = "Owner could not complete the planned repair";
      return {
        id: "plugin-doctor-post-session-state",
        phase: "final",
        source: [{ kind: "owner", id: "plugin:example:legacy-state" }],
        target: [{ kind: "owner", id: "plugin:example:doctor-state" }],
        requiredness: "conditional",
        reversibility: "checkpoint-required",
        outcome,
        changes: [],
        warnings: [message],
        ...(outcome === "refused" ? { refusal: { code: "step-refused", message } } : {}),
      };
    }

    it.each(["refused", "warning"] as const)(
      "settles %s migration receipts before later contributions",
      async (outcome) => {
        const recorded = receipt(outcome);
        const receipts: LegacyStateMigrationStepReceipt[] = [];
        const ctx = createDoctorHealthFlowContext({
          configResult: { stateMigrationStepReceipts: receipts },
        });
        if (outcome === "refused") {
          ctx.env = {
            ...buildUpdateRehearsalPathEnv("/synthetic/rehearsal"),
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            OPENCLAW_SERVICE_REPAIR_POLICY: "external",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR: "0",
            OPENCLAW_UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION: "0",
          };
          ctx.updateBudget = {
            agentCount: 1,
            phase: "validation",
            inspectionDeadlineMs: Date.now() + 149_000,
            source: "validation-ledger",
            deferred: new Map(),
          };
        }
        const later = vi.fn(async () => {});
        const contributions = [
          createDoctorHealthContribution("doctor:session-transcripts", "Sessions", {
            run: async () => {
              receipts.push(recorded);
            },
          }),
        ];
        if (outcome === "warning") {
          contributions.push(
            createDoctorHealthContribution("doctor:advisory", "Advisory", {
              run: async () => {
                throw new Error("optional diagnostic\nunavailable");
              },
            }),
          );
        }
        contributions.push(createDoctorHealthContribution("doctor:later", "Later repair", later));
        const run = runDoctorHealthContributionList(ctx, contributions);
        if (outcome === "refused") {
          await expect(run).rejects.toMatchObject({ stepReceipts: [recorded] });
          expect(later).not.toHaveBeenCalled();
        } else {
          await run;
          expect(later).toHaveBeenCalledOnce();
          expect(mocks.note).toHaveBeenCalledWith(
            "doctor:advisory run failed: optional diagnostic unavailable",
            "Doctor warnings",
          );
        }
        expect(receipts).toEqual([recorded]);
      },
    );
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
