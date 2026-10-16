import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveGatewayTaskScriptPath } from "../daemon/paths.js";
import { gatewayHealthResponse } from "../gateway/health-response.test-support.js";
import { isBetaTag } from "../infra/update-channels.js";
import type { UpdateRunResult } from "../infra/update-runner-types.js";
import { withEnvAsync } from "../test-utils/env.js";
import { VERSION } from "../version.js";
import * as assertions from "./update-cli-assertions.test-support.js";
import { registerUpdateCliLifecycle } from "./update-cli-lifecycle.test-support.js";
import * as mocks from "./update-cli-mocks.test-support.js";
import * as update from "./update-cli-modules.test-support.js";
import * as configSupport from "./update-cli/update-cli-config.test-support.js";
import * as packageSupport from "./update-cli/update-cli-package.test-support.js";

await vi.hoisted(() => import("./update-cli-mocks.test-support.js"));

export function createUpdateCliFixture() {
  // Unique across concurrent runs; realpath normalizes macOS's /var symlink.
  const fixtureRoot = fsSync.realpathSync(
    fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-update-tests-")),
  );
  const checkoutRoot = path.join(fixtureRoot, "checkout");
  fsSync.mkdirSync(checkoutRoot);
  for (const directory of [".git", "src", "extensions"]) {
    fsSync.mkdirSync(path.join(checkoutRoot, directory));
  }
  fsSync.writeFileSync(
    path.join(checkoutRoot, "package.json"),
    JSON.stringify({ name: "openclaw", version: VERSION }),
  );
  const globalNpmConfig = path.join(fixtureRoot, "global-npmrc");
  fsSync.writeFileSync(globalNpmConfig, "");
  const profileStateDir = (profile = "default") =>
    path.join(
      expectDefined(process.env.HOME, "isolated test home"),
      profile === "default" ? ".openclaw" : `.openclaw-${profile}`,
    );
  let fixtureCount = 0;
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  const tempDirsToCleanup = new Set<string>();

  // Real-I/O callers create the directory; others only need a stable path.
  const createCaseDir = (prefix: string) => path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);

  const initializeExistingUpdateProfile = update.createUpdateStateProfileInitializer(fixtureRoot);

  const baseConfig: OpenClawConfig = {};
  const baseSnapshot = configSupport.createUpdateCliBaseSnapshot(baseConfig);

  const clawHubRiskWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSuspiciousPayloadWarning =
    "╭─ ClawHub Security Audit ─────────────────────────────────╮\n" +
    "│ Outcome: Review                                         │\n" +
    "│ Overview: Review the requested capabilities.             │\n" +
    "╰───────────────────────────────────────────────────────────────────────╯";
  const clawHubSyncRiskError =
    "Failed to update demo: ClawHub blocked this release; update was not started. (ClawHub clawhub:demo@1.2.4).";

  const setStreamTty = (
    stream: NodeJS.ReadStream | NodeJS.WriteStream,
    value: boolean | undefined,
  ) => Object.defineProperty(stream, "isTTY", { value, configurable: true });
  const setTty = (value: boolean | undefined) => {
    setStreamTty(process.stdin, value);
  };
  const setStdoutTty = (value: boolean | undefined) => {
    setStreamTty(process.stdout, value);
  };

  const mockPackageInstallStatus = (root: string) => {
    vi.mocked(update.resolveOpenClawPackageRoot).mockResolvedValue(root);
    vi.mocked(update.resolveUpdateInstallKind).mockResolvedValue("package");
    vi.mocked(update.resolveUpdateInstallIdentity).mockResolvedValue({ installKind: "package" });
    vi.mocked(update.checkUpdateStatus).mockResolvedValue({
      root,
      installKind: "package",
      packageManager: "npm",
      deps: { manager: "npm", status: "ok", lockfilePath: null, markerPath: null },
    });
  };

  const mockPackageInstallAtCaseDir = async (prefix = "openclaw-update", version = "1.0.0") => {
    const { pkgRoot, nodeModules } = await setupInstalledPackageRoot(
      createCaseDir(prefix),
      version,
    );
    // The global prefix owns bin even when no launchers are published.
    await fs.mkdir(path.join(path.dirname(path.dirname(nodeModules)), "bin"), {
      recursive: true,
    });
    mockNpmGlobalCommands(nodeModules, async (argv) => {
      if (argv[0] === "npm" && argv[1] === "i") {
        await packageSupport.writeNpmPackageInstall(argv, pkgRoot);
      }
    });
    mockCurrentProcessFreshDoctor({ packageRoot: pkgRoot });
    return pkgRoot;
  };

  const primeNpmChannelTag = (tag: string, version: string | null): void => {
    vi.mocked(update.resolveNpmChannelTag).mockResolvedValue({ tag, version });
  };

  const primeServiceCommand = (
    programArguments: Array<string | undefined>,
    environment?: NodeJS.ProcessEnv,
    sourcePath?: string,
  ): void => {
    const managedDefinition = {
      programArguments,
      ...(environment === undefined ? {} : { environment }),
    };
    mocks.serviceReadCommand.mockResolvedValue({
      ...managedDefinition,
      managedDefinition,
      ...(sourcePath ? { sourcePath } : {}),
    });
  };

  const statfsFixture = (params: {
    bavail: number;
    bsize?: number;
    blocks?: number;
  }): ReturnType<typeof fsSync.statfsSync> => ({
    type: 0,
    bsize: params.bsize ?? 1024,
    blocks: params.blocks ?? 2_000_000,
    bfree: params.bavail,
    bavail: params.bavail,
    files: 0,
    frsize: params.bsize ?? 1024,
    ffree: 0,
  });

  const reportCandidateSteps = async <T extends { steps: UpdateRunResult["steps"] }>(
    options: { onStep?: (step: UpdateRunResult["steps"][number]) => void | Promise<void> },
    result: T,
  ): Promise<T> => {
    for (const step of result.steps) {
      await options.onStep?.(step);
    }
    return result;
  };

  const mockOwnedGitService = (root = process.cwd()) => {
    const serviceEntrypoint = path.join(root, "dist", "index.js");
    primeServiceCommand(
      ["node", serviceEntrypoint, "gateway", "run"],
      undefined,
      process.platform === "win32" ? resolveGatewayTaskScriptPath(process.env) : undefined,
    );
    mocks.pathExists.mockImplementation(
      async (candidate: string) =>
        candidate === path.join(root, "package.json") || candidate === serviceEntrypoint,
    );
  };

  const useNativeScheduledTaskControl = async () => {
    const nativeTaskControl = await vi.importActual<typeof import("../daemon/schtasks-control.js")>(
      "../daemon/schtasks-control.js",
    );
    mocks.suspendScheduledTaskAutoStartForUpdate.mockImplementation(
      nativeTaskControl.suspendScheduledTaskAutoStartForUpdate,
    );
    mocks.resumeScheduledTaskAutoStartAfterUpdate.mockImplementation(
      nativeTaskControl.resumeScheduledTaskAutoStartAfterUpdate,
    );
  };

  const runRestartFallbackScenario = async (params: { daemonInstall: "ok" | "fail" }) => {
    mockOwnedGitService();
    const entrypoint = path.join(process.cwd(), "dist", "index.js");
    update.mockGitUpdateAfterMutation(update.makeOkUpdateResult({ root: process.cwd() }));
    vi.mocked(update.resolveGatewayInstallEntrypoint).mockResolvedValue(entrypoint);
    if (params.daemonInstall === "fail") {
      mockGatewayInstallFailure(entrypoint);
    }
    mocks.serviceLoaded.mockResolvedValue(true);

    await update.updateCommand({});

    expect(assertions.gatewayCommandCall(entrypoint, "install")).toBeDefined();
    expect(assertions.freshRestartCalls()).toHaveLength(1);
  };

  const setupNonInteractiveDowngrade = async () => {
    const tempDir = await mockPackageInstallAtCaseDir();
    setTty(false);
    mocks.readPackageVersion.mockResolvedValue("2.0.0");
    primeNpmChannelTag(isBetaTag(VERSION) ? "beta" : "latest", "0.0.1");
    vi.mocked(update.updateGitCheckout).mockResolvedValue(
      update.makeOkUpdateResult({ mode: "npm" }),
    );
    vi.mocked(update.defaultRuntime.error).mockClear();
    vi.mocked(update.defaultRuntime.exit).mockClear();

    return tempDir;
  };

  const setupUpdatedRootRefresh = (params?: {
    gatewayUpdateImpl?: (root: string) => Promise<UpdateRunResult>;
    entrypoints?: string[];
    admitMutation?: boolean;
    targetVersion?: string;
  }) => {
    const root = createCaseDir("openclaw-updated-root");
    const targetVersion = params?.targetVersion ?? VERSION;
    const entrypoints = params?.entrypoints ?? [path.join(root, "dist", "entry.js")];
    const packageRoots = entrypoints.map((entrypoint) => path.dirname(path.dirname(entrypoint)));
    const packageJsonPaths = new Set(
      packageRoots.map((packageRoot) => path.join(packageRoot, "package.json")),
    );
    for (const entrypoint of entrypoints) {
      const packageRoot = path.dirname(path.dirname(entrypoint));
      const packageJsonPath = path.join(packageRoot, "package.json");
      fsSync.mkdirSync(path.dirname(entrypoint), { recursive: true });
      fsSync.writeFileSync(entrypoint, "// test entrypoint\n", "utf8");
      fsSync.writeFileSync(
        packageJsonPath,
        JSON.stringify({ name: "openclaw", version: targetVersion }),
        "utf8",
      );
      tempDirsToCleanup.add(packageRoot);
    }
    mocks.pathExists.mockImplementation(
      async (candidate: string) =>
        packageJsonPaths.has(candidate) || entrypoints.includes(candidate),
    );
    const readPreviousPackageVersion = assertions.requireValue(
      mocks.readPackageVersion.getMockImplementation(),
      "package version fixture",
    );
    mocks.readPackageVersion.mockImplementation(async (packageRoot: string) =>
      packageRoots.includes(packageRoot) ? targetVersion : readPreviousPackageVersion(packageRoot),
    );
    vi.mocked(update.updateGitCheckout).mockImplementation(async ({ opts: options }) => {
      // Admit the original owner even without activation, as the Git runner does.
      await options.inspectGitTarget({});
      // Baseline-capture cases separately exercise the actual mutation callback.
      if (params?.admitMutation) {
        await assertions.requireValue(options.beforeGitMutation, "Git mutation admission")({});
      }
      return params?.gatewayUpdateImpl
        ? params.gatewayUpdateImpl(root)
        : update.makeOkUpdateResult({ mode: "npm", root, after: { version: targetVersion } });
    });
    mockGatewayHealth(targetVersion, "updated-gateway");
    mocks.serviceLoaded.mockResolvedValue(true);
    primeServiceCommand(["node", entrypoints[0], "gateway", "run"]);
    return { root, entrypoints };
  };

  const FRESH_POST_UPDATE_ENTRYPOINT = "/tmp/openclaw-updated-entry.mjs";

  const mockCurrentProcessFreshDoctor = packageSupport.createCurrentProcessFreshDoctorFixture(
    update.resolveGatewayInstallEntrypoint,
    FRESH_POST_UPDATE_ENTRYPOINT,
  );

  const expectFreshPostUpdateDoctor = (params: {
    yes: boolean;
    workspaceSuggestions?: boolean;
  }) => {
    const calls = vi
      .mocked(update.runExec)
      .mock.calls.filter(
        ([, args]) => args[0] === FRESH_POST_UPDATE_ENTRYPOINT && args[1] === "doctor",
      );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[1]).toEqual([
      FRESH_POST_UPDATE_ENTRYPOINT,
      "doctor",
      "--repair",
      "--non-interactive",
      ...(params.workspaceSuggestions ? [] : ["--no-workspace-suggestions"]),
      ...(params.yes ? ["--yes"] : []),
    ]);
  };

  const configFixtures = configSupport.createUpdateCliConfigFixtures({
    baseConfig,
    baseSnapshot,
    readConfigFileSnapshot: update.readConfigFileSnapshot,
    syncPluginsForUpdateChannel: mocks.syncPluginsForUpdateChannel,
    updateNpmInstalledPlugins: mocks.updateNpmInstalledPlugins,
    createCaseDir,
  });

  const runPostCoreCommand = (
    options: Parameters<typeof update.updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_UPDATE_POST_CORE: "1",
        OPENCLAW_UPDATE_POST_CORE_CHANNEL: "stable",
        OPENCLAW_COMPATIBILITY_HOST_VERSION: process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION,
        ...env,
      },
      () => update.updateCommand(options),
    );

  const runPostCoreUpdate = (env: NodeJS.ProcessEnv = {}) =>
    runPostCoreCommand({ yes: true, restart: false }, env);

  const expectFailedManagedGitRestart = (message: string) => {
    const logs = assertions.getLogOutput();
    expect(mocks.serviceStop).toHaveBeenCalledTimes(1);
    expect(assertions.freshRestartCalls()).toHaveLength(1);
    expect(update.defaultRuntime.exit).not.toHaveBeenCalled();
    expect(
      [logs, ...vi.mocked(update.defaultRuntime.error).mock.calls.flat()].join("\n"),
    ).toContain(message);
    expect(logs).not.toContain("Gateway: restarted and verified.");
    expect(logs).not.toContain("Update Result: OK");
  };

  const mockGatewayHealth = (version: string, connId: string, buildId?: string) => {
    mocks.callGateway.mockImplementation(
      gatewayHealthResponse({ server: { version, connId, buildId, bootId: "test-gateway-boot" } }),
    );
  };

  const packageFixtures = packageSupport.createUpdateCliPackageFixtures({
    runCommandWithTimeout: update.runCommandWithTimeout,
    serviceStop: mocks.serviceStop,
    serviceReadRuntime: mocks.serviceReadRuntime,
    serviceReadCommand: mocks.serviceReadCommand,
    serviceLoaded: mocks.serviceLoaded,
    pathExists: mocks.pathExists,
    gatewayFixturePid: mocks.gatewayFixturePid,
    sqliteHostPlatform: mocks.sqliteHostPlatform,
    mockGatewayHealth,
    mockPackageInstallStatus,
  });
  const {
    mockNpmGlobalCommands,
    mockFileBackedPathExists,
    setupInstalledPackageRoot,
    mockGatewayInstallFailure,
  } = packageFixtures;

  const completeChangedPostCorePluginUpdate = (
    overrides: Partial<Parameters<typeof update.completePostCorePluginUpdate>[0]> = {},
  ) =>
    update.completePostCorePluginUpdate(
      configSupport.createChangedPostCoreUpdateOptions(overrides),
    );

  const setupNpmUpdatedRootRefresh = () => {
    const updatedRoot = createCaseDir("openclaw-updated-root");
    const updatedEntrypoint = path.join(updatedRoot, "dist", "entry.js");
    setupUpdatedRootRefresh({
      entrypoints: [updatedEntrypoint],
      targetVersion: "2026.4.24",
      gatewayUpdateImpl: async () =>
        update.makeOkUpdateResult({
          mode: "npm",
          root: updatedRoot,
          before: { version: "2026.4.23" },
          after: { version: "2026.4.24" },
        }),
    });
    return { updatedRoot, updatedEntrypoint };
  };

  const setupManagedGitRootRefresh = async (reinspect = false) => {
    const { root, entrypoints } = setupUpdatedRootRefresh();
    const updatedEntrypoint = assertions.requireValue(entrypoints[0], "updated entrypoint");
    mockOwnedGitService();
    update.mockGitUpdateAfterMutation(
      await packageSupport.writeGitUpdateResultFixture({
        root,
        before: { sha: "old-managed-sha", version: "2026.4.26" },
        after: { sha: "new-managed-sha", version: VERSION },
      }),
      reinspect,
    );
    mockFileBackedPathExists();
    mocks.serviceLoaded.mockResolvedValue(true);
    mocks.serviceReadRuntime.mockResolvedValue({
      status: "running",
      pid: mocks.gatewayFixturePid,
      state: "running",
    });
    mocks.serviceStop.mockImplementationOnce(async () => {
      mocks.serviceReadRuntime.mockResolvedValue({ status: "stopped", state: "stopped" });
    });
    const runFixtureCommand = assertions.requireValue(
      vi.mocked(update.runCommandWithTimeout).getMockImplementation(),
      "default command fixture",
    );
    vi.mocked(update.runCommandWithTimeout).mockImplementation(async (argv, options) => {
      const result = await runFixtureCommand(argv, options);
      if (argv[2] === "gateway" && argv[3] === "install" && result.code === 0) {
        expect(argv[1]).toBe(updatedEntrypoint);
        const env = assertions.requireValue(
          typeof options === "number" ? undefined : options.env,
          "gateway install environment",
        );
        primeServiceCommand([argv[0], updatedEntrypoint, "gateway", "run"], env);
      }
      if (argv[2] === "gateway" && argv[3] === "restart" && result.code === 0) {
        expect(argv[1]).toBe(updatedEntrypoint);
        mocks.serviceReadRuntime.mockResolvedValue({
          status: "running",
          pid: mocks.gatewayFixturePid,
          state: "running",
        });
        mockGatewayHealth(VERSION, "updated-work");
      }
      return result;
    });
    return updatedEntrypoint;
  };

  const runWithGatewayServiceEnv = (
    options: Parameters<typeof update.updateCommand>[0],
    env: NodeJS.ProcessEnv = {},
  ) =>
    withEnvAsync(
      {
        OPENCLAW_SERVICE_MARKER: "openclaw",
        OPENCLAW_SERVICE_KIND: "gateway",
        ...env,
      },
      () => update.invokeUpdateCli(options),
    );

  const runControlPlaneUpdate = async (params: {
    meta: Record<string, unknown>;
    options: Parameters<typeof update.updateCommand>[0];
    beforeUpdate?: () => void | Promise<void>;
    expectedExitCode?: number;
  }) => {
    const home = tempDirs.make("openclaw-update-sentinel-home-");
    const stateDir = path.join(home, ".openclaw");
    await fs.mkdir(stateDir);
    const metaDir = tempDirs.make("openclaw-update-sentinel-meta-");
    const metaPath = path.join(metaDir, "meta.json");
    await packageSupport.writeJsonFixture(metaPath, { version: 1, meta: params.meta }, false);
    await params.beforeUpdate?.();
    await withEnvAsync(
      {
        [update.CONTROL_PLANE_UPDATE_SENTINEL_META_ENV]: metaPath,
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
      },
      async () => {
        initializeExistingUpdateProfile();
        if (params.expectedExitCode === undefined) {
          await update.invokeUpdateCli(params.options);
        } else {
          await expect(update.invokeUpdateCli(params.options)).rejects.toEqual(
            new update.ExitError(params.expectedExitCode),
          );
        }
      },
    );
    return update.readRestartSentinel({ OPENCLAW_STATE_DIR: stateDir } as NodeJS.ProcessEnv);
  };

  const fixture = {
    ...configFixtures,
    ...packageFixtures,
    baseConfig,
    baseSnapshot,
    clawHubRiskWarning,
    clawHubSuspiciousPayloadWarning,
    clawHubSyncRiskError,
    completeChangedPostCorePluginUpdate,
    createCaseDir,
    expectFailedManagedGitRestart,
    expectFreshPostUpdateDoctor,
    fixtureRoot,
    FRESH_POST_UPDATE_ENTRYPOINT,
    globalNpmConfig,
    initializeExistingUpdateProfile,
    mockCurrentProcessFreshDoctor,
    mockGatewayHealth,
    mockOwnedGitService,
    mockPackageInstallAtCaseDir,
    mockPackageInstallStatus,
    primeNpmChannelTag,
    primeServiceCommand,
    profileStateDir,
    reportCandidateSteps,
    runControlPlaneUpdate,
    runPostCoreCommand,
    runPostCoreUpdate,
    runRestartFallbackScenario,
    runWithGatewayServiceEnv,
    setStdoutTty,
    setTty,
    setupManagedGitRootRefresh,
    setupNonInteractiveDowngrade,
    setupNpmUpdatedRootRefresh,
    setupUpdatedRootRefresh,
    statfsFixture,
    tempDirs,
    tempDirsToCleanup,
    useNativeScheduledTaskControl,
  };
  registerUpdateCliLifecycle(fixture);
  return fixture;
}
