import { afterEach, beforeEach, expect, it } from "vitest";
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
import { activePlacement } from "./placement-suite.test-support.js";

async function prepareRuntimePatch(
  provider: string,
  model: string,
  current: () => ReturnType<typeof activePlacement>,
) {
  const { sessionId } = current();
  const key = `agent:main:${sessionId}`;
  return prepareSessionWorkerPlacementPatchValidation({
    agentId: "main",
    cfg: {},
    context: {
      workerSessionPlacementService: {
        getMany: () => new Map([[sessionId, current()]]),
        prepareSessionPlacement: async () => ({
          prepareRead: () => undefined,
          current,
          release() {},
        }),
      },
    },
    entry: { sessionId, updatedAt: 0, providerOverride: provider, modelOverride: model },
    key,
    patch: { key, model: `${provider}/${model}` },
    sessionKey: key,
    validateModelRuntime: true,
  });
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

it("derives presence mode from the default session runtime", () => {
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
  expect(resolveDefaultWorkerPlacementExecutionMode({ cfg, agentId: "main" })).toBe("remote-exec");
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

it("reads inherited runtime off thread and observes parent updates", async () => {
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

it("required worker inference overrides persisted runtime", () => {
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

it("fails closed above the device command-count bound", () => {
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
  expect(projectWorkerPlacementAgentRuntime({ id: "oversized-harness", source: "model" })).toEqual({
    id: "oversized-harness",
    cloudPlacementSupported: true,
    cloudPlacementExecutionMode: "remote-exec",
    devicePlacementSupported: false,
    source: "model",
  });
});

it("rejects local CLI execution", () => {
  // #136611: CLI backends dispatch locally even when no harness claims the model.
  registerCliBackend();
  const caps = runtimeCapabilities({
    providerOverride: "claude-cli",
    modelOverride: "claude-fable-5-1",
  });
  expect(caps.executionMode).toBeUndefined();
  expect(caps.devicePlacement).toBeUndefined();
});

it("honors an embedded runtime override over a CLI provider", () => {
  registerCliBackend();
  const caps = runtimeCapabilities({
    providerOverride: "claude-cli",
    modelOverride: "opus-4.7",
    agentRuntimeOverride: "openclaw",
  });
  expect(caps.executionMode).toBe("worker-turn");
});

it("direct-API profiles override CLI-first auth order", () => {
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

it("CLI profiles override API-first auth order", () => {
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

it("resolves remote-exec through provider policy", () => {
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

it("selects an auto harness with device placement", () => {
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

it("unclaimed auto models use built-in placement", () => {
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

it("sessions.patch rejects incompatible worker-turn runtimes", async () => {
  registerHarness("claude-cli", {
    cloudPlacement: undefined,
    autoSelection: { providerIds: ["claude-cli"] },
  });
  const placement = activePlacement("s6");
  const prepared = await prepareRuntimePatch("claude-cli", "claude-fable-5-1", () => placement);
  try {
    expect(prepared.validate()).toContain(
      "cannot select a runtime without cloud placement support",
    );
  } finally {
    prepared.release();
  }
});

it("sessions.patch allows auto fallback and rechecks execution mode", async () => {
  const placement = activePlacement("s8");
  let executionMode: "worker-turn" | "remote-exec" = "worker-turn";
  const prepared = await prepareRuntimePatch("some-provider", "some-model", () => ({
    ...placement,
    executionMode,
  }));
  try {
    expect(prepared.validate()).toBeUndefined();
    executionMode = "remote-exec";
    expect(prepared.validate()).toContain("cannot change cloud placement execution mode");
  } finally {
    prepared.release();
  }
});
