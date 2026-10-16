import { join } from "node:path";
import { afterAll, expect, it, onTestFinished, vi } from "vitest";
import type { AgentDefaultsConfig } from "../../config/types.agent-defaults.js";
import { delegateCompactionToRuntime } from "../../context-engine/delegate.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import { createApiKeyCredential } from "../auth-profiles/credential-fixtures.test-support.js";
import { prepareSharedAuthStoreOwnershipForNative } from "../auth-profiles/path-resolve.native.js";
import {
  clearRuntimeAuthProfileStoreSnapshotCore,
  setRuntimeAuthProfileStoreSnapshot,
} from "../auth-profiles/runtime-snapshots.js";
import { installSessionPlacementAdmissionProvider } from "../session-placement-admission.js";
import {
  contextEngineCompactMock,
  getApiKeyForModelMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
  sessionCompactImpl,
} from "./compact.hooks.harness.js";

const { compactEmbeddedAgentSession, compactEmbeddedAgentSessionDirect } =
  await loadCompactHooksHarness();
const [
  { upsertSessionEntryCore },
  { ensureAuthProfileStoreWithoutExternalProfiles },
  { AsyncWorkScope },
  { prepareProviderRuntimeAuth },
  { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot },
] = await Promise.all([
  import("../../config/sessions/session-accessor.js"),
  import("../model-auth.js"),
  import("../../shared/async-work-scope.js"),
  import("../../plugins/provider-runtime.js"),
  import("../../config/runtime-snapshot.js"),
]);
const tempDirs = useSessionStoreTempDirs(afterAll, "openclaw-compaction-auth-");
const primaryModel = { provider: "openai", model: "gpt-primary" };
const configFor = (defaults: AgentDefaultsConfig) => ({ agents: { defaults } });

async function prepareCompactionParams() {
  const workspaceDir = tempDirs.make();
  resetCompactHooksHarnessMocks(workspaceDir);
  const sessionTarget = {
    agentId: "main",
    sessionId: "compaction-auth",
    sessionKey: "agent:main:compaction-auth",
    storePath: join(workspaceDir, "sessions.sqlite"),
  };
  await upsertSessionEntryCore(sessionTarget, { sessionId: sessionTarget.sessionId, updatedAt: 1 });
  return { ...sessionTarget, sessionTarget, sessionFile: sessionTarget.sessionKey, workspaceDir };
}

async function runOwnedCompaction(
  params: Parameters<typeof compactEmbeddedAgentSession>[0],
  mode: "direct" | "queued" = "direct",
) {
  const parent = new AsyncWorkScope();
  try {
    return await parent.run(() =>
      mode === "direct"
        ? compactEmbeddedAgentSessionDirect(params)
        : compactEmbeddedAgentSession(params),
    );
  } finally {
    await AsyncWorkScope.runWhenAllIdle(
      () => [parent],
      () => parent.drain(),
    );
  }
}

it.each(["lookup", "hook", "allowed"] as const)(
  "honors direct compaction cancellation across provider auth (%s)",
  async (stage) => {
    const baseParams = await prepareCompactionParams();
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("compaction source revoked"));
    getApiKeyForModelMock.mockImplementation(async (params) => {
      if (stage === "lookup") {
        cancel();
      }
      return {
        apiKey: "lookup-fixture-key",
        mode: "api-key",
        source: "compaction auth fixture",
        profileId: params?.profileId,
      };
    });
    const prepareAuth = vi.mocked(prepareProviderRuntimeAuth);
    const previousPrepareAuth = prepareAuth.getMockImplementation();
    onTestFinished(() => {
      prepareAuth.mockReset();
      if (previousPrepareAuth) {
        prepareAuth.mockImplementation(previousPrepareAuth);
      }
    });
    prepareAuth.mockReset();
    prepareAuth.mockImplementation(async () => {
      if (stage === "hook") {
        cancel();
      }
      return { apiKey: "prepared-fixture-key" };
    });
    const result = await runOwnedCompaction({
      ...baseParams,
      ...primaryModel,
      trigger: "budget",
      abortSignal: controller.signal,
      config: configFor({ compaction: { model: "openai/gpt-primary" } }),
    });
    expect(getApiKeyForModelMock).toHaveBeenCalled();
    expect(prepareAuth).toHaveBeenCalledTimes(stage === "lookup" ? 0 : 1);
    expect(result.ok).toBe(stage === "allowed");
    if (stage !== "allowed") {
      expect(result.reason).toContain("compaction source revoked");
    }
    expect(resolveModelMock).toHaveBeenCalled();
    for (const resolution of resolveModelMock.mock.results) {
      if (resolution.type === "return") {
        expect(resolution.value.authStorage.setRuntimeApiKey).toHaveBeenCalledTimes(
          stage === "allowed" ? 1 : 0,
        );
      }
    }
  },
);

it.each([false, true])(
  "retains sandbox placement through queued engine preparation (revoked=%s)",
  async (revoke) => {
    const baseParams = await prepareCompactionParams();
    let revoked = false;
    const dispose = vi.fn();
    const uninstall = installSessionPlacementAdmissionProvider({
      async prepareSandbox() {
        return {
          sandbox: null,
          assertCurrent() {
            if (revoked) {
              throw new Error("placement revoked during engine preparation");
            }
          },
          [Symbol.dispose]: dispose,
        };
      },
      assertCompactionSuccessorAllowed() {},
      executeLocalTurn: async (_claim, run) => await run(),
      executeTurn: async (_claim, _params, run) => await run(),
    });
    resolveContextEngineMock.mockImplementation(async () => {
      revoked = revoke;
      return { info: { ownsCompaction: true }, compact: contextEngineCompactMock };
    });
    setRuntimeConfigSnapshot({});
    try {
      const operation = runOwnedCompaction(
        {
          ...baseParams,
          ...primaryModel,
          trigger: "manual",
          enqueue: async (task) => await task(),
        },
        "queued",
      );
      if (revoke) {
        await expect(operation).rejects.toThrow("placement revoked during engine preparation");
        expect(contextEngineCompactMock).not.toHaveBeenCalled();
      } else {
        await operation;
        expect(contextEngineCompactMock).toHaveBeenCalledOnce();
      }
      expect(resolveContextEngineMock).toHaveBeenCalled();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      uninstall();
      clearRuntimeConfigSnapshot();
    }
  },
);

it.each(["direct", "queued", "fallback"] as const)(
  "handles a cooldowned auth profile in %s compaction",
  async (mode) => {
    const baseParams = await prepareCompactionParams();
    const fallback = mode === "fallback";
    const provider = fallback ? "primary" : "summary";
    const agentDir = join(baseParams.workspaceDir, "agent");
    const authStore = {
      version: 1 as const,
      profiles: Object.fromEntries(
        (fallback ? [provider, "backup"] : [provider]).map(
          (id) => [`${id}:default`, createApiKeyCredential(id, `test-${id}-key`)] as const,
        ),
      ),
      ...(!fallback ? { order: { summary: ["summary:default"] } } : {}),
      usageStats: {
        [`${provider}:default`]: {
          cooldownUntil: Date.now() + (fallback ? 3_600_000 : 60_000),
          ...(fallback ? { cooldownReason: "rate_limit" as const } : {}),
        },
      },
    };
    const originalAuthStore = structuredClone(authStore);
    vi.mocked(ensureAuthProfileStoreWithoutExternalProfiles).mockReturnValue(authStore);
    if (fallback) {
      prepareSharedAuthStoreOwnershipForNative();
      setRuntimeAuthProfileStoreSnapshot(authStore, agentDir);
      onTestFinished(() => clearRuntimeAuthProfileStoreSnapshotCore(agentDir));
      resolveContextEngineMock.mockResolvedValue({
        info: { ownsCompaction: false },
        compact: vi.fn(delegateCompactionToRuntime),
      });
    }
    const result = await runOwnedCompaction(
      {
        ...baseParams,
        ...(fallback ? { agentDir, provider, model: "model" } : primaryModel),
        trigger: "budget",
        forcePreflight: true,
        preflightRequired: true,
        ...(fallback
          ? { preflightCompactionTrigger: "transcript_bytes" as const }
          : {
              enqueue: async <T>(task: () => Promise<T> | T) => await task(),
            }),
        config: configFor(
          fallback
            ? { model: { primary: "primary/model", fallbacks: ["backup/model"] } }
            : {
                model: { primary: "openai/gpt-primary", fallbacks: ["openai/gpt-fallback"] },
                compaction: { model: "summary/compact-model" },
              },
        ),
      },
      fallback ? "queued" : mode,
    );

    if (fallback) {
      expect(result, JSON.stringify(result)).toMatchObject({ ok: true, compacted: true });
      expect(sessionCompactImpl).toHaveBeenCalledOnce();
      expect(getApiKeyForModelMock).toHaveBeenCalledWith(
        expect.objectContaining({ profileId: "backup:default" }),
      );
    } else {
      expect(result).toMatchObject({
        ok: false,
        compacted: false,
        reason:
          'Auth profile "summary:default" is temporarily unavailable for summary/compact-model.',
      });
      expect(resolveModelMock).toHaveBeenCalledTimes(1);
      expect(resolveModelMock.mock.calls[0]?.slice(0, 2)).toEqual(["summary", "compact-model"]);
      for (const mock of [contextEngineCompactMock, sessionCompactImpl, getApiKeyForModelMock]) {
        expect(mock).not.toHaveBeenCalled();
      }
      expect(authStore).toEqual(originalAuthStore);
    }
  },
);
