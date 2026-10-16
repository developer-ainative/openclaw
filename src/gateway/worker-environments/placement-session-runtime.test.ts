import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../agents/auth-profiles/runtime-snapshots.js";
import { registerAgentHarness } from "../../agents/harness/registry.js";
import type { AgentHarness } from "../../agents/harness/types.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../../config/io.js";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  getActivePluginRegistry,
  resetPluginRuntimeStateForTest,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { prepareSessionWorkerPlacementPatchValidation } from "../server-methods/sessions-shared.js";
import {
  projectWorkerPlacementAgentRuntime,
  resolveDefaultWorkerPlacementExecutionMode,
  resolveWorkerPlacementCapabilities,
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
  resolveWorkerPlacementSessionRuntimeAsync,
} from "./placement-session-runtime.js";

async function preparePatchError(
  params: Parameters<typeof prepareSessionWorkerPlacementPatchValidation>[0],
) {
  const prepared = await prepareSessionWorkerPlacementPatchValidation(params);
  try {
    return prepared.validate();
  } finally {
    prepared.release();
  }
}

const originalPluginRegistry = getActivePluginRegistry();

function registerHarness(id: string, overrides: Partial<AgentHarness> = {}) {
  registerAgentHarness({
    id,
    label: id,
    cloudPlacement: {
      mode: "remote-exec",
      devicePlacement: {
        requiredNodeCommands: ["runtime.exec-server.v1"],
        consumesWorkerSlot: false,
      },
    },
    supports: () => ({ supported: true }),
    async runAttempt() {
      throw new Error("not used");
    },
    ...overrides,
  });
}

function runtimeCapabilities(
  entry: Partial<Parameters<typeof resolveWorkerPlacementSessionRuntime>[0]["entry"]>,
  cfg: Parameters<typeof resolveWorkerPlacementSessionRuntime>[0]["cfg"] = {},
) {
  return resolveWorkerPlacementCapabilities(
    resolveWorkerPlacementSessionRuntime({
      readSourceEntry: () => undefined,
      cfg,
      entry: { sessionId: "runtime-session", updatedAt: 0, ...entry },
      agentId: "main",
      sessionKey: "agent:main:runtime-session",
    }),
  );
}

function registerCliBackend(modelProvider?: string) {
  getActivePluginRegistry()?.cliBackends.push({
    pluginId: "test-cli-plugin",
    pluginName: "test-cli-plugin",
    backend: {
      id: "claude-cli",
      ...(modelProvider ? { modelProvider } : {}),
      config: { command: "claude" },
    },
    source: "test",
  });
}

function authConfig(order: string[]) {
  return {
    auth: {
      order: { anthropic: order },
      profiles: {
        "anthropic:api": { provider: "anthropic", mode: "api_key" as const },
        "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" as const },
      },
    },
  };
}

function patchPlacement(sessionId: string) {
  return {
    sessionId,
    state: "active" as const,
    executionMode: "worker-turn" as const,
    generation: 1,
    environmentId: "env-1",
    runnerId: "runner-1",
    runnerStatus: "available" as const,
    recoveryError: null,
    terminalReason: null,
    terminalAtMs: null,
    transitionGeneration: 1,
    ownerId: "worker",
    ownerEpoch: 1,
    turnClaim: null,
    workspace: null,
    retirement: null,
    createdAtMs: 0,
    updatedAtMs: 0,
  };
}

beforeEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  setActivePluginRegistry(createEmptyPluginRegistry(), "placement-runtime-test", "default");
});

afterEach(() => {
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  if (originalPluginRegistry) {
    setActivePluginRegistry(originalPluginRegistry, "placement-runtime-test-restore", "default");
    return;
  }
  resetPluginRuntimeStateForTest();
});

describe("worker placement runtime capabilities", () => {
  it("derives presence preparation mode from the default session runtime owner", () => {
    registerHarness("codex", {
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["codex.exec-server.stdio.v1"],
          consumesWorkerSlot: false,
        },
      },
    });
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "openai/gpt-test" },
          models: { "openai/gpt-test": { agentRuntime: { id: "codex" } } },
        },
      },
    };
    const session = {
      cfg,
      entry: {
        sessionId: "browser-created-codex",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-test",
        agentRuntimeOverride: "codex",
      },
      agentId: "main",
      sessionKey: "agent:main:dashboard:browser-created-codex",
    };
    expect(
      resolveWorkerPlacementCapabilities(
        resolveWorkerPlacementSessionRuntime({ ...session, readSourceEntry: () => undefined }),
      ).executionMode,
    ).toBe("remote-exec");
    expect(resolveDefaultWorkerPlacementExecutionMode({ cfg, agentId: "main" })).toBe(
      "remote-exec",
    );
  });

  it.each([
    {
      name: "ignores an unlocked historical runtime after selecting a different provider",
      entry: { agentHarnessId: "codex" },
      expected: "openclaw",
    },
    {
      name: "ignores an unlocked historical runtime behind the default override",
      entry: { agentHarnessId: "codex", agentRuntimeOverride: "default" },
      expected: "openclaw",
    },
    {
      name: "preserves locked transcript ownership",
      entry: { agentHarnessId: "codex", modelSelectionLocked: true },
      expected: "codex",
    },
    {
      name: "does not let a historical embedded runtime override a Codex model",
      entry: {
        agentHarnessId: "openclaw",
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      },
      expected: "codex",
    },
    {
      name: "honors an explicit compatible runtime override",
      entry: {
        agentRuntimeOverride: "codex",
        providerOverride: "openai",
        modelOverride: "gpt-test",
      },
      expected: "codex",
    },
  ])("$name", ({ entry, expected }) => {
    expect(
      resolveWorkerPlacementSessionRuntime({
        cfg: {},
        entry: {
          sessionId: "placement-runtime-session",
          updatedAt: 0,
          providerOverride: "anthropic",
          modelOverride: "claude-test",
          ...entry,
        },
        agentId: "main",
        sessionKey: "agent:main:placement-runtime",
        readSourceEntry: () => undefined,
      }),
    ).toBe(expected);
  });

  it("reads inherited runtime selection off-thread and observes a committed parent update", async () => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      setRuntimeConfigSnapshot({});
      const parent = { agentId: "main", sessionKey: "agent:main:parent-runtime" };
      await upsertSessionEntryCore(parent, {
        sessionId: "parent-runtime",
        updatedAt: 1,
        providerOverride: "openai",
        modelOverride: "gpt-5.6-sol",
      });
      const input = {
        cfg: {},
        agentId: "main",
        sessionKey: "agent:main:child-runtime",
        entry: { sessionId: "child-runtime", updatedAt: 1, parentSessionKey: parent.sessionKey },
      };
      const observed = observeHostDataSql();
      try {
        expect(await resolveWorkerPlacementSessionRuntimeAsync(input)).toBe("codex");
        expect(observed.queries).toEqual([]);
      } finally {
        observed.restore();
      }
      await upsertSessionEntryCore(parent, {
        sessionId: "parent-runtime",
        updatedAt: 2,
        providerOverride: "anthropic",
        modelOverride: "claude-test",
      });
      expect(await resolveWorkerPlacementSessionRuntimeAsync(input)).toBe("openclaw");
    });
  });

  it("does not let a persisted runtime override bypass required worker inference", () => {
    expect(
      resolveWorkerPlacementSessionRuntime({
        cfg: { cloudWorkers: { requiredProfile: "dedicated-native" } },
        entry: {
          sessionId: "required-placement-runtime",
          updatedAt: 0,
          providerOverride: "openai",
          modelOverride: "gpt-test",
          agentRuntimeOverride: "codex",
        },
        agentId: "main",
        sessionKey: "agent:main:required-placement-runtime",
        readSourceEntry: () => undefined,
      }),
    ).toBe("openclaw");
  });

  it.each([
    {
      name: "embedded worker turns support paired devices",
      runtimeId: "openclaw",
      executionMode: "worker-turn",
      devicePlacementSupported: true,
      devicePlacement: { requiredNodeCommands: [], consumesWorkerSlot: true },
    },
    {
      name: "device command requirements are deterministic and deduplicated",
      runtimeId: "ordered-harness",
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: ["runtime.zeta.v1", "runtime.alpha.v1", "runtime.zeta.v1"],
          consumesWorkerSlot: false,
        },
      },
      executionMode: "remote-exec",
      devicePlacementSupported: true,
      devicePlacement: {
        requiredNodeCommands: ["runtime.alpha.v1", "runtime.zeta.v1"],
        consumesWorkerSlot: false,
      },
    },
    {
      name: "cloud-only remote execution does not support paired devices",
      runtimeId: "cloud-harness",
      cloudPlacement: { mode: "remote-exec" },
      executionMode: "remote-exec",
      devicePlacementSupported: false,
    },
    {
      name: "unknown runtimes support no placement",
      runtimeId: "missing-harness",
      executionMode: undefined,
      devicePlacementSupported: false,
    },
  ] as const)("$name", ({ runtimeId, executionMode, devicePlacementSupported, ...declaration }) => {
    if ("cloudPlacement" in declaration) {
      registerHarness(runtimeId, { cloudPlacement: declaration.cloudPlacement });
    }

    expect(resolveWorkerPlacementExecutionMode(runtimeId)).toBe(executionMode);
    expect(resolveWorkerPlacementCapabilities(runtimeId)).toEqual({
      ...(executionMode ? { executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
    });
    expect(projectWorkerPlacementAgentRuntime({ id: runtimeId, source: "model" })).toEqual({
      id: runtimeId,
      cloudPlacementSupported: executionMode !== undefined,
      ...(executionMode ? { cloudPlacementExecutionMode: executionMode } : {}),
      ...("devicePlacement" in declaration ? { devicePlacement: declaration.devicePlacement } : {}),
      devicePlacementSupported,
      source: "model",
    });
  });

  it("fails closed when a harness requires more than the bounded command count", () => {
    registerHarness("oversized-harness", {
      cloudPlacement: {
        mode: "remote-exec",
        devicePlacement: {
          requiredNodeCommands: Array.from({ length: 33 }, (_, index) => `runtime.${index}.v1`),
          consumesWorkerSlot: false,
        },
      },
    });

    expect(resolveWorkerPlacementCapabilities("oversized-harness").devicePlacement).toBeUndefined();
    expect(
      projectWorkerPlacementAgentRuntime({ id: "oversized-harness", source: "model" }),
    ).toEqual({
      id: "oversized-harness",
      cloudPlacementSupported: true,
      cloudPlacementExecutionMode: "remote-exec",
      devicePlacementSupported: false,
      source: "model",
    });
  });
});

describe("worker placement runtime capability projection", () => {
  it("rejects a CLI-backed provider whose dispatch runs as a local process", () => {
    // #136611: CLI backends dispatch locally even when no harness claims the model.
    registerCliBackend();
    const caps = runtimeCapabilities({
      providerOverride: "claude-cli",
      modelOverride: "claude-fable-5-1",
    });
    expect(caps.executionMode).toBeUndefined();
    expect(caps.devicePlacement).toBeUndefined();
  });

  it("honors a non-CLI session runtime override over a CLI-backed provider", () => {
    registerCliBackend();
    const caps = runtimeCapabilities({
      providerOverride: "claude-cli",
      modelOverride: "opus-4.7",
      agentRuntimeOverride: "openclaw",
    });
    expect(caps.executionMode).toBe("worker-turn");
  });

  it("passes the selected auth profile to CLI classification — direct-API profile overrides CLI auth order", () => {
    registerCliBackend("anthropic");
    const caps = runtimeCapabilities(
      {
        providerOverride: "anthropic",
        modelOverride: "opus-4.7",
        authProfileOverride: "anthropic:api",
      },
      authConfig(["anthropic:claude-cli", "anthropic:api"]),
    );
    expect(caps.executionMode).toBe("worker-turn");
  });

  it("rejects when an explicit CLI auth profile overrides a direct-API auth order", () => {
    registerCliBackend("anthropic");
    const caps = runtimeCapabilities(
      {
        providerOverride: "anthropic",
        modelOverride: "opus-4.7",
        authProfileOverride: "anthropic:claude-cli",
      },
      authConfig(["anthropic:api"]),
    );
    expect(caps.executionMode).toBeUndefined();
  });

  it("reports remote-exec capabilities for a registered harness via provider policy", () => {
    registerHarness("device-harness");

    const caps = runtimeCapabilities(
      {
        providerOverride: "device-harness",
        modelOverride: "model-x",
      },
      {
        models: {
          providers: {
            "device-harness": {
              baseUrl: "https://device-harness.example/v1",
              models: [],
              agentRuntime: { id: "device-harness" },
            },
          },
        },
      },
    );
    expect(caps.executionMode).toBe("remote-exec");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: ["runtime.exec-server.v1"],
      consumesWorkerSlot: false,
    });
  });

  it("resolves a registered auto harness placement capability instead of rejecting auto", () => {
    registerHarness("auto-device-harness");

    const caps = runtimeCapabilities({
      providerOverride: "auto-provider",
      modelOverride: "auto-model",
    });
    expect(caps.executionMode).toBe("remote-exec");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: ["runtime.exec-server.v1"],
      consumesWorkerSlot: false,
    });
  });

  it("falls back to built-in openclaw placement capabilities for an unclaimed auto model", () => {
    registerHarness("unrelated-harness", { supports: () => ({ supported: false }) });

    const caps = runtimeCapabilities({
      providerOverride: "unsupported-provider",
      modelOverride: "unsupported-model",
    });
    expect(caps.executionMode).toBe("worker-turn");
    expect(caps.devicePlacement).toEqual({
      requiredNodeCommands: [],
      consumesWorkerSlot: true,
    });
  });

  it("sessions.patch boundary: rejects an incompatible model change for an active worker-turn placement", async () => {
    registerHarness("claude-cli", {
      cloudPlacement: undefined,
      autoSelection: { providerIds: ["claude-cli"] },
    });
    const sessionId = "s6";
    const placement = patchPlacement(sessionId);
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, placement]]),
        prepareSessionPlacement: async () => ({
          prepareRead: () => undefined,
          current: () => placement,
          release() {},
        }),
      },
    };
    const error = await preparePatchError({
      agentId: "main",
      cfg: {} as never,
      context: context as never,
      entry: {
        sessionId,
        updatedAt: 0,
        providerOverride: "claude-cli",
        modelOverride: "claude-fable-5-1",
      } as never,
      key: "agent:main:s6",
      patch: { key: "agent:main:s6", model: "claude-cli/claude-fable-5-1" } as never,
      sessionKey: "agent:main:s6",
      validateModelRuntime: true,
    });
    expect(error).toContain("cannot select a runtime without cloud placement support");
  });

  it("sessions.patch boundary: allows an unclaimed auto model with openclaw fallback for an active worker-turn placement", async () => {
    const sessionId = "s8";
    const placement = patchPlacement(sessionId);
    let executionMode: "worker-turn" | "remote-exec" = "worker-turn";
    const context = {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, { ...placement, executionMode }]]),
        prepareSessionPlacement: async () => ({
          prepareRead: () => undefined,
          current: () => ({ ...placement, executionMode }),
          release() {},
        }),
      },
    };
    const prepared = await prepareSessionWorkerPlacementPatchValidation({
      agentId: "main",
      cfg: {} as never,
      context: context as never,
      entry: {
        sessionId,
        updatedAt: 0,
        providerOverride: "some-provider",
        modelOverride: "some-model",
      } as never,
      key: "agent:main:s8",
      patch: { key: "agent:main:s8", model: "some-provider/some-model" } as never,
      sessionKey: "agent:main:s8",
      validateModelRuntime: true,
    });
    try {
      expect(prepared.validate()).toBeUndefined();
      executionMode = "remote-exec";
      expect(prepared.validate()).toContain("cannot change cloud placement execution mode");
    } finally {
      prepared.release();
    }
  });
});
