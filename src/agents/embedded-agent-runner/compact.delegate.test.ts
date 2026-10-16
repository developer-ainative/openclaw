import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { observeHostDataSql } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ContextEngine, ContextEngineRuntimeContext } from "../../context-engine/types.js";
import { AsyncWorkScope } from "../../shared/async-work-scope.js";
import {
  createAssistant,
  createAssistantResultStream,
  testModel,
} from "../sessions/agent-session-loop-correctness.test-support.js";
import type { ProviderConfigInput } from "../sessions/model-registry.js";
import {
  applyExtraParamsToAgentMock,
  buildConfiguredAgentSystemPromptMock,
  hookRunner,
  limitHistoryTurnsMock,
  loadCompactHooksHarness,
  resetCompactHooksHarnessMocks,
  resolveContextEngineMock,
  resolveModelMock,
} from "./compact.hooks.harness.js";

const { requestPreparedCompaction } = vi.hoisted(() => ({
  requestPreparedCompaction:
    vi.fn<typeof import("@openclaw/ai/transports").requestPreparedOpenAIResponsesCompaction>(),
}));
vi.mock("@openclaw/ai/transports", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openclaw/ai/transports")>()),
  requestPreparedOpenAIResponsesCompaction: requestPreparedCompaction,
}));

let delegate: typeof import("../../context-engine/delegate.js").delegateCompactionToRuntime;
let compactQueued: Awaited<
  ReturnType<typeof loadCompactHooksHarness>
>["compactEmbeddedAgentSession"];
let sessions: typeof import("../sessions/index.js");
let accessor: typeof import("../../config/sessions/session-accessor.js");
let databases: typeof import("../../state/openclaw-agent-db.js");
let streamResolution: typeof import("./stream-resolution.js");
let replay: typeof import("../openai-transport-stream.test-support.js").testing;
let accounting: typeof import("./run/compaction-accounting-bridge.js");
let requestBudgets: typeof import("../sessions/compaction/request-budget.js");
let pressure: typeof import("./run/preemptive-compaction.js");
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    await closeDatabases();
    cleanup();
  }),
);
let workspaceDir: string;
const model = {
  ...testModel,
  id: "compaction-fixture",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 128_000,
  maxTokens: 1_024,
};
const summary = "The deployment checklist was reviewed. Compare the remaining options.";

async function closeDatabases() {
  await databases.closeOpenClawAgentDatabasesAsync();
  databases.closeOpenClawAgentDatabasesForTest();
}

function runDelegate(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<Parameters<typeof delegate>[0]> = {},
) {
  return delegate({
    sessionId: fixture.target.sessionId,
    sessionKey: fixture.target.sessionKey,
    sessionTarget: fixture.target,
    runtimeContext: fixture.runtimeContext,
    ...overrides,
  });
}

function expectUntouchedDecoy(fixture: Awaited<ReturnType<typeof createFixture>>) {
  expect(sessions.SessionManager.open(fixture.decoy).buildSessionContext().messages).toEqual([
    { role: "user", content: "Unrelated store history", timestamp: 1 },
  ]);
}

function expectCalls(count: 0 | 1, ...mocks: unknown[]) {
  for (const mock of mocks) {
    expect(mock).toHaveBeenCalledTimes(count);
  }
}

function expectOutcome(result: Awaited<ReturnType<typeof delegate>>, compacted = true) {
  expect(result, JSON.stringify(result)).toMatchObject({ ok: compacted, compacted });
}

async function waitForPause(reached: Promise<unknown>, pending: Promise<unknown>) {
  await Promise.race([
    reached,
    pending.then((result) => {
      throw new Error(`Compaction returned before its controlled pause: ${JSON.stringify(result)}`);
    }),
  ]);
}

beforeAll(async () => {
  // Retain real SQLite and compaction owners beneath the provider hook harness.
  ({ compactEmbeddedAgentSession: compactQueued } = await loadCompactHooksHarness({
    durableSession: true,
  }));
  [
    { delegateCompactionToRuntime: delegate },
    sessions,
    accessor,
    databases,
    streamResolution,
    { testing: replay },
    accounting,
    requestBudgets,
    pressure,
  ] = await Promise.all([
    import("../../context-engine/delegate.js"),
    import("../sessions/index.js"),
    import("../../config/sessions/session-accessor.js"),
    import("../../state/openclaw-agent-db.js"),
    import("./stream-resolution.js"),
    import("../openai-transport-stream.test-support.js"),
    import("./run/compaction-accounting-bridge.js"),
    import("../sessions/compaction/request-budget.js"),
    import("./run/preemptive-compaction.js"),
  ]);
});

beforeEach(async () => {
  workspaceDir = tempDirs.make("openclaw-compaction-delegate-");
  resetCompactHooksHarnessMocks(workspaceDir);
  const actualScope =
    await vi.importActual<typeof import("../agent-scope.js")>("../agent-scope.js");
  const scope = await import("../agent-scope.js");
  vi.mocked(scope.listAgentEntries).mockImplementation(actualScope.listAgentEntries);
  vi.mocked(scope.listAgentEntriesWithSource).mockImplementation(
    actualScope.listAgentEntriesWithSource,
  );
  vi.mocked(scope.resolveSessionAgentId).mockImplementation(actualScope.resolveSessionAgentId);
  vi.mocked(scope.resolveSessionAgentIds).mockImplementation(actualScope.resolveSessionAgentIds);
  requestPreparedCompaction.mockReset();
  limitHistoryTurnsMock.mockImplementation((messages) => messages);
  hookRunner.hasHooks.mockImplementation(
    (name) => name === "before_compaction" || name === "after_compaction",
  );
});

async function createFixture(operation: "summary" | "endpoint", globalAlias = false) {
  const target = {
    agentId: globalAlias ? "marketing" : "main",
    sessionId: "compaction-session",
    sessionKey: globalAlias ? "global" : "agent:main:compaction-session",
    storePath: join(workspaceDir, "alternate", "openclaw-agent.sqlite"),
  };
  const configuredStore = join(workspaceDir, "configured", "openclaw-agent.sqlite");
  await accessor.upsertSessionEntryCore(target, { sessionId: target.sessionId, updatedAt: 1 });
  // The same physical id in another store must not redirect partial-target resolution.
  const decoy = { ...target, storePath: configuredStore };
  await accessor.upsertSessionEntryCore(decoy, { sessionId: target.sessionId, updatedAt: 1 });
  const decoyManager = sessions.SessionManager.open(decoy, workspaceDir);
  decoyManager.appendMessage({ role: "user", content: "Unrelated store history", timestamp: 1 });
  decoyManager.flushPendingPersistence();
  const sessionManager = sessions.SessionManager.open(target, workspaceDir);
  await sessionManager.appendModelChange(model.provider, model.id);
  await sessionManager.appendThinkingLevelChange("off");
  for (const content of [
    "Review the deployment checklist.",
    "Compare the remaining options.",
    "Keep the rollout notes.",
  ]) {
    sessionManager.appendMessage({ role: "user", content, timestamp: 1 });
    sessionManager.appendMessage(
      createAssistant(model, [{ type: "text", text: `Recorded: ${content}` }]),
    );
  }
  sessionManager.flushPendingPersistence();
  const originalMessages = sessionManager.buildSessionContext().messages;
  const originalEntries = sessionManager.getEntries();
  const stream = vi.fn<NonNullable<ProviderConfigInput["streamSimple"]>>((activeModel) =>
    createAssistantResultStream(createAssistant(activeModel, [{ type: "text", text: summary }])),
  );
  const authStorage = sessions.AuthStorage.inMemory();
  authStorage.setRuntimeApiKey(model.provider, "test-api-key");
  const modelRegistry = sessions.ModelRegistry.inMemory(authStorage);
  modelRegistry.registerProvider(model.provider, { api: model.api, streamSimple: stream });
  resolveModelMock.mockImplementation((provider = model.provider, modelId = model.id) => ({
    logicalRef: { provider, model: modelId },
    model,
    error: null,
    authStorage,
    modelRegistry,
  }));
  vi.mocked(streamResolution.resolveEmbeddedAgentStream).mockReturnValue({
    streamFn: stream,
    strategy: "session-custom",
  });
  applyExtraParamsToAgentMock.mockReturnValue({
    effectiveExtraParams: { responsesCompactEndpoint: operation === "endpoint" },
  });
  const checkpoint = {
    type: "compaction" as const,
    id: "cmp_fixture",
    encrypted_content: "opaque-fixture",
  };
  requestPreparedCompaction.mockResolvedValue({
    item: checkpoint,
    output: [checkpoint],
    historyMode: "compacted-prefix",
    usage: { input_tokens: 1_000, output_tokens: 200 },
    model,
    replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(model, {
      sessionId: target.sessionId,
    }),
  });
  const runtimeContext = {
    workspaceDir,
    provider: model.provider,
    model: model.id,
    trigger: "manual",
    thinkLevel: "off",
    config: {
      session: { store: configuredStore },
      agents: {
        ownership: "explicit",
        entries: { main: {}, marketing: {} },
        defaults: { compaction: { mode: "default", keepRecentTokens: 1, postIndexSync: "off" } },
      },
    },
  } satisfies ContextEngineRuntimeContext & { config: OpenClawConfig };
  const recordUsage = vi.fn();
  const recordCompaction = vi.fn();
  accounting.attachCompactionAccountingRecorder(runtimeContext, { recordUsage, recordCompaction });
  return {
    target,
    decoy,
    originalEntries,
    originalMessages,
    runtimeContext,
    stream,
    recordUsage,
    recordCompaction,
  };
}

it.each([
  { budget: "absent", pendingPrompt: "" },
  { budget: "foreground with pending input", pendingPrompt: "Unrecorded request. ".repeat(500) },
])("records server checkpoint pressure with $budget budget", async ({ budget, pendingPrompt }) => {
  const fixture = await createFixture("endpoint");
  const compactorPrompt = "Summarize the deployment discussion.";
  buildConfiguredAgentSystemPromptMock.mockReturnValue(compactorPrompt);
  const requestBudget = requestBudgets.createCompactionRequestBudget({
    contextWindow: model.contextWindow,
    reserveTokens: 16_384,
    systemPrompt: "Help the operator deploy safely using the available tools.",
    tools: [
      {
        name: "lookup_deployment",
        description: "Available deployment target and its constraints. ".repeat(500),
        parameters: { type: "object", properties: { target: { type: "string" } } },
      },
    ],
    pendingPrompt,
  });
  const hasBudget = budget !== "absent";
  accounting.attachCompactionAccountingRecorder(fixture.runtimeContext, {
    ...(hasBudget ? { requestBudget } : {}),
    recordUsage: fixture.recordUsage,
    recordCompaction: fixture.recordCompaction,
  });
  const manager = sessions.SessionManager.open(fixture.target, workspaceDir);
  const retainedUsers = manager
    .buildSessionContext()
    .messages.filter((message) => message.role === "user")
    .map((message) => {
      if (typeof message.content !== "string") {
        throw new Error("Expected plain-text fixture input");
      }
      return {
        type: "message" as const,
        role: "user" as const,
        content: [{ type: "input_text" as const, text: message.content }],
      };
    });
  const checkpoint = {
    type: "compaction" as const,
    id: "cmp_budget",
    encrypted_content: "opaque",
  };
  const output = [...retainedUsers, checkpoint];
  requestPreparedCompaction.mockImplementationOnce(
    async (_stream, requestModel, _context, options) => ({
      item: checkpoint,
      output,
      historyMode: "retained-users",
      usage: { input_tokens: 30_000, output_tokens: 200 },
      model: requestModel,
      replayMetadata: replay.buildOpenAIResponsesReasoningReplayMetadata(requestModel, options),
    }),
  );

  const result = await runDelegate(fixture);
  expectOutcome(result);
  expect(result.result?.details).toMatchObject({ compactionKind: "server-endpoint" });
  await closeDatabases();
  const messages = sessions.SessionManager.open(fixture.target).buildSessionContext().messages;
  const endpointCall = requestPreparedCompaction.mock.calls[0]!;
  const replayContext = {
    model: endpointCall[1],
    sessionId: endpointCall[3].sessionId,
    authProfileId: endpointCall[3].authProfileId,
    enabled: true,
  };
  const replayHistory =
    pressure.estimateLlmBoundaryTokenPressure({ messages, prompt: "", replay: replayContext }) -
    pressure.estimateRenderedLlmBoundaryTokenPressure({ prompt: "" });
  const expected = hasBudget
    ? requestBudget.fixedTokens + replayHistory
    : pressure.estimateLlmBoundaryTokenPressure({
        messages,
        systemPrompt: compactorPrompt,
        prompt: "",
        replay: replayContext,
      });
  expect(requestBudget.fixedTokens).toBeGreaterThan(5_000);
  expect(result.result?.tokensAfter).toBe(expected);
  expect(fixture.recordCompaction).toHaveBeenCalledExactlyOnceWith({
    tokensBefore: 30_000,
    tokensAfter: expected,
    compactionKind: "server-endpoint",
  });
  expectCalls(1, requestPreparedCompaction);
  expectCalls(0, fixture.stream);
});

it.each([
  { operation: "summary", partial: true, threadId: 0 },
  { operation: "endpoint", partial: false, threadId: 0 },
] as const)(
  "returns durable $operation identity (partial=$partial, thread=$threadId)",
  async ({ operation, partial, threadId }) => {
    const fixture = await createFixture(operation, partial);
    const { target } = fixture;
    const sessionTarget = {
      ...(partial ? { agentId: target.agentId, storePath: target.storePath } : target),
      ...(threadId !== undefined ? { threadId } : {}),
      expectedWriterRunId: "caller-private-writer",
      expectedLifecycleRevision: "caller-private-revision",
      unrelatedCapability: "caller-private-capability",
    };
    const sql = observeHostDataSql();
    hookRunner.runBeforeCompaction.mockImplementationOnce(async () => {
      sql.restore();
      return undefined;
    });
    const result = await runDelegate(fixture, { sessionTarget }).finally(sql.restore);
    expectOutcome(result);
    expect(
      sql.queries.filter(
        (query) => /\bselect\b/i.test(query) && /\btranscript_events\b/i.test(query),
      ),
    ).toEqual([]);
    const returned = expectDefined(result.result?.sessionTarget, "resolved session identity");
    expect(returned).toEqual({ ...target, ...(threadId !== undefined ? { threadId } : {}) });
    expect(result.result).not.toHaveProperty("sessionFile");
    // Reopening after close proves the identity and history were durable.
    await closeDatabases();
    const reopened = sessions.SessionManager.open(returned);
    expect(reopened.getSessionId()).toBe(target.sessionId);
    expect(accessor.loadSessionEntry(target)?.sessionId).toBe(target.sessionId);
    const messages = reopened.buildSessionContext().messages;
    if (operation === "summary") {
      expect(result.result?.summary).toContain(summary);
      expect(reopened.getBranch().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      const firstKeptIndex = fixture.originalEntries.findIndex(
        (entry) => entry.id === result.result?.firstKeptEntryId,
      );
      expect(firstKeptIndex).toBeGreaterThan(0);
      const retained = fixture.originalEntries
        .slice(firstKeptIndex)
        .filter((entry) => entry.type === "message")
        .map((entry) => entry.message);
      expect(retained.length).toBeGreaterThan(0);
      expect(messages.slice(-retained.length)).toEqual(retained);
      expect(reopened.getEntries()).toEqual(expect.arrayContaining(fixture.originalEntries));
      expect(fixture.stream).toHaveBeenCalled();
      expect(requestPreparedCompaction).not.toHaveBeenCalled();
    } else {
      expect(result.result?.summary).toBeUndefined();
      expect(result.result?.details).toMatchObject({ compactionKind: "server-endpoint" });
      expect(messages).toMatchObject(fixture.originalMessages);
      expect(messages.at(-1)).toMatchObject({
        providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
      });
      expectCalls(1, requestPreparedCompaction);
      expectCalls(0, fixture.stream);
    }
    expect(fixture.recordUsage).toHaveBeenCalled();
    expectCalls(
      1,
      fixture.recordCompaction,
      hookRunner.runBeforeCompaction,
      hookRunner.runAfterCompaction,
    );
    expectUntouchedDecoy(fixture);
    expect(accessor.loadSessionEntry(target)).not.toHaveProperty("compactionCheckpoints");
    expect(accessor.loadSessionEntry(fixture.decoy)).not.toHaveProperty("compactionCheckpoints");
  },
);

it.each(["summary", "endpoint"] as const)(
  "cancels %s without publishing or rewriting history",
  async (operation) => {
    const fixture = await createFixture(operation);
    const started = createDeferred();
    const stopped = createDeferred();
    const controller = new AbortController();
    const abortReason = new Error("caller cancelled compaction");
    if (operation === "endpoint") {
      requestPreparedCompaction.mockImplementationOnce(
        async (_stream, _model, _context, options) => {
          started.resolve();
          return await new Promise<never>((_, reject) => {
            options.signal?.addEventListener(
              "abort",
              () => {
                stopped.resolve();
                reject(abortReason);
              },
              { once: true },
            );
          });
        },
      );
    } else {
      const { createAssistantMessageEventStream } = await import("openclaw/plugin-sdk/llm");
      fixture.stream.mockImplementationOnce((activeModel, _context, options) => {
        const stream = createAssistantMessageEventStream();
        started.resolve();
        options?.signal?.addEventListener(
          "abort",
          () => {
            stream.push({
              type: "error",
              reason: "aborted",
              error: createAssistant(activeModel, [], "aborted"),
            });
            stream.end();
            stopped.resolve();
          },
          { once: true },
        );
        return stream;
      });
    }
    const pending = runDelegate(fixture, {
      sessionTarget: { ...fixture.target, threadId: 0 },
      abortSignal: controller.signal,
    });
    await started.promise;
    controller.abort(abortReason);
    const result = await pending;
    await stopped.promise;
    expectOutcome(result, false);
    expect(result.result).toBeUndefined();
    await closeDatabases();
    const reopened = sessions.SessionManager.open(fixture.target);
    expect(reopened.getSessionId()).toBe(fixture.target.sessionId);
    expect(reopened.getEntries()).toEqual(fixture.originalEntries);
    expect(reopened.buildSessionContext().messages).toEqual(fixture.originalMessages);
    expectCalls(0, fixture.recordCompaction, hookRunner.runAfterCompaction);
  },
);

it.each(["abort", "owner-replaced"] as const)(
  "discards a hydrated compaction transcript after %s before publication",
  async (transition) => {
    const fixture = await createFixture("summary");
    const { historyLane } =
      await import("../../config/sessions/session-transcript-worker-resources.js");
    const { withSessionTranscriptWriteAssertion } =
      await import("../../config/sessions/transcript-write-context.js");
    const received = createDeferred();
    const release = createDeferred();
    const controller = new AbortController();
    let current = true;
    const reason = new Error("compaction preparation no longer current");
    const run = historyLane.pool.run.bind(historyLane.pool);
    const read = vi.spyOn(historyLane.pool, "run").mockImplementation((input, options) => {
      let hydration = false;
      return run(async () => {
        const request = typeof input === "function" ? await input() : input;
        hydration = request.kind === "transcript-hydration";
        return request;
      }, options).then(async (snapshot) => {
        if (hydration) {
          read.mockRestore();
          received.resolve();
          await release.promise;
        }
        return snapshot;
      });
    });
    const pending = withSessionTranscriptWriteAssertion(
      fixture.target,
      () => {
        if (!current) {
          throw reason;
        }
      },
      () => runDelegate(fixture, { abortSignal: controller.signal }),
    );
    try {
      await waitForPause(received.promise, pending);
      if (transition === "abort") {
        controller.abort(reason);
      } else {
        current = false;
      }
      release.resolve();
      expectOutcome(await pending, false);
      expectCalls(
        0,
        fixture.stream,
        hookRunner.runBeforeCompaction,
        hookRunner.runAfterCompaction,
        fixture.recordCompaction,
      );
      await closeDatabases();
      expect(sessions.SessionManager.open(fixture.target).getEntries()).toEqual(
        fixture.originalEntries,
      );
    } finally {
      release.resolve();
      read.mockRestore();
      await pending.catch(() => undefined);
    }
  },
);

it.each(["summary", "endpoint"] as const)(
  "keeps queued manual %s compaction countable when cancellation follows its commit during a post-compaction hook",
  async (operation) => {
    const fixture = await createFixture(operation);
    const { incrementCompactionCount } = await import("../../auto-reply/reply/session-updates.js");
    const backend = vi.fn<ContextEngine["compact"]>(delegate);
    resolveContextEngineMock.mockResolvedValueOnce({
      info: { ownsCompaction: false },
      compact: backend,
    });
    const expectedSession = expectDefined(
      accessor.loadSessionEntry(fixture.target),
      "persisted session",
    );
    const hookEntered = createDeferred();
    const releaseHook = createDeferred();
    const expectCommittedTranscript = () => {
      const manager = sessions.SessionManager.open(fixture.target);
      if (operation === "summary") {
        const compactions = manager.getBranch().filter((entry) => entry.type === "compaction");
        expect(compactions).toHaveLength(1);
        const committed = expectDefined(compactions[0], "persisted summary compaction");
        expect(committed.summary).toContain(summary);
        expect(committed.tokensBefore).toBeGreaterThan(0);
        return committed.tokensBefore;
      }
      expect(manager.buildSessionContext().messages.at(-1)).toMatchObject({
        providerReplay: { data: "opaque-fixture", compactedWindow: { state: "ready" } },
      });
      return 1_000;
    };
    hookRunner.runAfterCompaction.mockImplementationOnce(async () => {
      expectCommittedTranscript();
      hookEntered.resolve();
      await releaseHook.promise;
    });
    const controller = new AbortController();
    const work = new AsyncWorkScope();
    const pending = work.run(() =>
      compactQueued({
        ...fixture.target,
        sessionTarget: fixture.target,
        sessionFile: fixture.target.sessionKey,
        workspaceDir,
        config: fixture.runtimeContext.config,
        provider: model.provider,
        model: model.id,
        agentHarnessId: "openclaw",
        trigger: "manual",
        abortSignal: controller.signal,
        enqueue: async (task) => await task(),
      }),
    );
    try {
      await waitForPause(hookEntered.promise, pending);
      controller.abort(new Error("caller stopped after compaction committed"));
      const result = await pending;
      expect.soft(result).toMatchObject({
        ok: true,
        compacted: true,
        compactionKind: operation === "summary" ? "context-engine" : "server-endpoint",
      });
      const count =
        result.ok && result.compacted
          ? await incrementCompactionCount({
              agentId: fixture.target.agentId,
              sessionEntry: expectedSession,
              sessionStore: { [fixture.target.sessionKey]: expectedSession },
              sessionKey: fixture.target.sessionKey,
              storePath: fixture.target.storePath,
              expectedSession,
              tokensAfter: result.result?.tokensAfter,
              compactionKind: result.compactionKind,
            })
          : undefined;
      expect.soft(count).toBe(1);
      expect.soft(accessor.loadSessionEntry(fixture.target)?.compactionCount).toBe(1);
      expect(backend).toHaveBeenCalledOnce();
      expect(result.result?.tokensBefore).toBe(expectCommittedTranscript());
      expectUntouchedDecoy(fixture);
    } finally {
      releaseHook.resolve();
      await pending.catch(() => undefined);
      await work.drain();
    }
  },
);
