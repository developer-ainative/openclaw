import { expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../../test/helpers/promise.js";
import { AgentDeletionAuthorityRollbackError } from "../../agents/agent-lifecycle-registry.js";
import { EMBEDDED_RUN_WAITERS } from "../../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  resolveEmbeddedAgentRunProgressState,
  setActiveEmbeddedRun,
} from "../../agents/embedded-agent-runner/runs.js";
import { createEmbeddedRunHandle } from "../../agents/embedded-agent-runner/runs.test-support.js";
import { SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS } from "../../sessions/session-lifecycle-admission.js";
import * as sessionPlacement from "../worker-environments/session-placement-lifecycle.js";
import {
  deletionJournal,
  expectRespondErrorContaining,
  expectRespondOk,
  agentConfig,
  expectUncalled,
} from "./agents-mutate.test-support.js";
import type { AgentMutationHarness } from "./agents-mutate.test.js";

export function registerAgentDeleteDrainRecoveryTests(harness: AgentMutationHarness): void {
  const { mocks, makeCall, call, resume, expectTrashedWithinParent, expectNotTrashed } = harness;
  it.each([
    new Error("Placement read failed; restore the placement database and retry"),
    new Error("Session placement identity changed; reload the session and retry"),
    new AggregateError([new Error("placement cleanup failed")], "Placement stop failed", {
      cause: new Error("Placement read failed; restore the placement database and retry"),
    }),
  ])("preserves a pre-cancellation placement failure: %s", async (placementError) => {
    const sessionId = "placement-failure-session";
    const sessionKey = "agent:test-agent:placement-failure";
    const handle = createEmbeddedRunHandle({ runId: "placement-failure-run", abort: vi.fn() });
    setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "test-agent");
    const prepareStop = vi
      .spyOn(sessionPlacement, "prepareSessionWorkerPlacementStop")
      .mockRejectedValueOnce(placementError);
    try {
      const deletion = makeCall("agents.delete", { agentId: "test-agent" });
      await expect(deletion.promise).rejects.toBe(placementError);
      expect(handle.abort).not.toHaveBeenCalled();
      expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBeDefined();
      expect(EMBEDDED_RUN_WAITERS.has(sessionId)).toBe(false);
      expectUncalled(mocks.beginAgentDeletionRetire, mocks.writeConfigFile, mocks.movePathToTrash);
    } finally {
      prepareStop.mockRestore();
      clearActiveEmbeddedRun(sessionId, handle, sessionKey);
    }
  });

  it.each([
    { sessionKey: undefined, isAbortable: false, slowPlacement: false },
    { sessionKey: undefined, isAbortable: true, slowPlacement: false },
    { sessionKey: "agent:test-agent:stuck", isAbortable: false, slowPlacement: false },
    { sessionKey: "agent:test-agent:stuck", isAbortable: true, slowPlacement: false },
    { sessionKey: "agent:test-agent:slow-placement", isAbortable: true, slowPlacement: true },
  ])(
    "bounds deletion (key: $sessionKey, abortable: $isAbortable, slow placement: $slowPlacement)",
    async ({ sessionKey, isAbortable, slowPlacement }) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const sessionId = slowPlacement ? "slow-placement-session" : "stuck-deletion-session";
      const handle = createEmbeddedRunHandle(
        slowPlacement ? { abort: vi.fn() } : { runId: "stuck-run", isAbortable },
      );
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "test-agent");
      const preparation =
        createDeferred<
          Awaited<ReturnType<typeof sessionPlacement.prepareSessionWorkerPlacementStop>>
        >();
      const stop = vi.fn(async () => {});
      const prepareStop = slowPlacement
        ? vi
            .spyOn(sessionPlacement, "prepareSessionWorkerPlacementStop")
            .mockReturnValueOnce(preparation.promise)
        : undefined;
      const deletion = makeCall("agents.delete", { agentId: "test-agent" });
      const failed = vi.fn();
      const completed = Promise.resolve(deletion.promise).catch(failed);
      try {
        await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);
        expect(failed).toHaveBeenCalledOnce();
        expect(failed).toHaveBeenCalledWith(
          expect.objectContaining({
            message: slowPlacement
              ? expect.stringContaining(
                  "deletion preparation timed out for sessions: agent:test-agent:slow-placement. Check session placement availability",
                )
              : expect.stringMatching(/stuck-deletion-session.*retry agents.delete/),
          }),
        );
        if (slowPlacement) {
          expect(prepareStop).toHaveBeenCalledOnce();
          preparation.resolve({ stop, startBeforeDrain: false });
          await vi.runAllTimersAsync();
          expectUncalled(handle.abort, stop);
        } else {
          expectUncalled(mocks.closeOpenClawAgentDatabaseByPath, mocks.beginAgentDeletionRollback);
        }
        expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBeDefined();
        expect(EMBEDDED_RUN_WAITERS.has(sessionId)).toBe(false);
        expectUncalled(
          mocks.beginAgentDeletionRetire,
          mocks.writeConfigFile,
          mocks.movePathToTrash,
        );
      } finally {
        if (slowPlacement) {
          preparation.resolve({ stop, startBeforeDrain: false });
          await vi.runAllTimersAsync();
          await completed;
        }
        prepareStop?.mockRestore();
        clearActiveEmbeddedRun(sessionId, handle, sessionKey);
        await completed;
        vi.useRealTimers();
      }
    },
  );

  it.for(["agent:test-agent:active", "global", undefined])(
    "drains an active %s run before retirement and permits recreation without a deletion retry",
    async (sessionKey, { signal }) => {
      const sessionId = "delete-active-session";
      const aborted = createDeferred();
      const settled = createDeferred();
      const abort = vi.fn(() => aborted.resolve());
      const handle = createEmbeddedRunHandle({ runId: "delete-active-run", abort });
      const foreign = createEmbeddedRunHandle({ runId: "other-active-run", abort: vi.fn() });
      setActiveEmbeddedRun(sessionId, handle, sessionKey, undefined, "test-agent");
      setActiveEmbeddedRun("other-session", foreign, "global", undefined, "main");
      const owner = settled.promise.then(() =>
        clearActiveEmbeddedRun(sessionId, handle, sessionKey),
      );
      const deletion = makeCall("agents.delete", { agentId: "test-agent" });
      try {
        await withinTest(
          awaitGateBeforeSettlement(
            aborted.promise,
            Promise.resolve(deletion.promise),
            "Deletion completed without aborting its active run",
          ),
          signal,
        );
        expect(abort).toHaveBeenCalledOnce();
        expectUncalled(
          mocks.beginAgentDeletionRetire,
          mocks.closeOpenClawAgentDatabaseByPath,
          mocks.movePathToTrash,
          deletion.respond,
          foreign.abort,
        );

        settled.resolve();
        await owner;
        await deletion.promise;
        const result = expectRespondOk(deletion.respond, { ok: true, failed: [] });
        expect(result.removed).toEqual(
          expect.arrayContaining([
            { path: "/workspace/test-agent", method: "trash" },
            { path: "/agents/test-agent", method: "trash" },
            { path: "/transcripts/test-agent", method: "trash" },
          ]),
        );
        expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
        expect(EMBEDDED_RUN_WAITERS.has(sessionId)).toBe(false);
        expect(resolveEmbeddedAgentRunProgressState(sessionId)).toBeUndefined();
        expect(resolveEmbeddedAgentRunProgressState("other-session")).toBeDefined();
        mocks.loadConfigReturn = agentConfig({ main: {} });
        mocks.findAgentEntryIndex.mockReturnValue(-1);
        mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal({ cleanupCompleted: true }));
        const recreated = await call("agents.create", { name: "Test Agent" });
        expectRespondOk(recreated, { ok: true, agentId: "test-agent" });
      } finally {
        settled.resolve();
        await owner;
        clearActiveEmbeddedRun("other-session", foreign, "global");
        await deletion.promise;
      }
    },
  );

  it.each(["draining", "legacy"] as const)(
    "automatically resumes a %s deletion journal after restart",
    async (phase) => {
      const journal: Record<string, unknown> = { ...deletionJournal({ phase: "draining" }) };
      if (phase === "legacy") {
        delete journal.phase;
      }
      mocks.readAgentDeletionJournal.mockReturnValue(journal);
      mocks.listPendingAgentDeletionJournals.mockReturnValue([journal]);
      await resume();
      expect(mocks.logGatewayWarn).not.toHaveBeenCalled();
      expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
      expectTrashedWithinParent("/journal/agent/openclaw-agent.sqlite");
      if (phase === "draining") {
        expect(mocks.beginAgentDeletionRetire).toHaveBeenCalledOnce();
      } else {
        expect(mocks.readSessionEntrySummariesInWorker).not.toHaveBeenCalled();
      }
    },
  );

  it("does not replay a deletion journal after another operation replaces it", async () => {
    mocks.listPendingAgentDeletionJournals.mockReturnValue([
      deletionJournal({ phase: "draining", operationId: "previous-deletion" }),
    ]);
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({ phase: "draining", operationId: "replacement-deletion" }),
    );
    await resume();
    expect(mocks.logGatewayWarn).toHaveBeenCalledOnce();
    expectUncalled(
      mocks.beginAgentDeletionRetire,
      mocks.beginAgentDeletionFinish,
      mocks.closeOpenClawAgentDatabaseByPath,
      mocks.movePathToTrash,
      mocks.writeConfigFile,
    );
  });

  it("settles recovery without touching a journaled directory claimed by another agent", async () => {
    mocks.resolveOpenClawAgentSqlitePath.mockImplementation(
      (params) => params?.path ?? "/journal/agent/openclaw-agent.sqlite",
    );
    const directoryOwners = new Map([["/journal/agent", "other-agent"]]);
    const databaseRows = [
      { agentId: "test-agent", path: "/journal/agent/openclaw-agent.sqlite" },
      { agentId: "other-agent", path: "/journal/agent/openclaw-agent.sqlite" },
    ];
    mocks.loadConfigReturn = agentConfig({ main: {} });
    mocks.readAgentDeletionJournal.mockReturnValue(
      deletionJournal({ workspaceDir: "/journal", sessionsDir: "/deleted/sessions" }),
    );
    mocks.resolveRegisteredAgentIdForDir.mockImplementation((pathname?: string) =>
      directoryOwners.get(pathname ?? ""),
    );
    mocks.isPathOwnedByAnotherRegisteredAgent.mockImplementation(
      ({ agentId, pathname }: { agentId: string; pathname: string }) =>
        (pathname === "/journal/agent" || pathname.startsWith("/journal/agent/")) &&
        directoryOwners.get("/journal/agent") !== agentId,
    );
    mocks.unregisterResolvedAgentDir.mockImplementation(
      ({ agentId, agentDir }: { agentId: string; agentDir: string }) =>
        directoryOwners.get(agentDir) === agentId && directoryOwners.delete(agentDir),
    );
    mocks.listOpenClawRegisteredAgentDatabases.mockImplementation(() => databaseRows);

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true });
    expect(mocks.listOpenClawRegisteredAgentDatabases).toHaveBeenCalled();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expect(mocks.assertNoOpenClawAgentDatabaseLeases).toHaveBeenCalledWith("test-agent", {});
    expect(mocks.closeDeletedAgentDatabases).toHaveBeenCalledWith(
      "test-agent",
      [],
      expect.objectContaining({
        assertCurrentFinal: mocks.assertAgentDeletionCurrentFinal,
        assertCurrentAsync: mocks.assertAgentDeletionCurrentAsync,
      }),
    );
    expectNotTrashed("/journal/agent", "/journal");
    expectTrashedWithinParent("/deleted/sessions");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledWith({ unregisterDatabases: true });
    expect(mocks.unregisterResolvedAgentDir).toHaveBeenCalledWith({
      agentId: "test-agent",
      agentDir: "/journal/agent",
    });
    expect(directoryOwners.get("/journal/agent")).toBe("other-agent");
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });

  it("protects every journaled path claimed as a surviving agent workspace", async () => {
    mocks.resolveOpenClawAgentSqlitePath.mockImplementation(
      (params) => params?.path ?? "/journal/agent/openclaw-agent.sqlite",
    );
    mocks.loadConfigReturn = agentConfig({ "other-agent": { workspace: "/journal" } });
    mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondOk(respond, { ok: true, removed: [], failed: [] });
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledWith(
      "/journal/agent/openclaw-agent.sqlite",
      "test-agent",
    );
    expectUncalled(mocks.movePathToTrash, mocks.deleteWorkspaceState);
    expect(mocks.beginAgentDeletionFinish).toHaveBeenCalledOnce();
  });
}

export function registerAgentDeleteRollbackTests(harness: AgentMutationHarness): void {
  const { mocks, makeCall, call } = harness;
  it("rolls back a fresh deletion when draining leaves it as the only configured agent", async () => {
    mocks.sharedAuthStoreOwnership = { location: "state-db" };
    mocks.beginAgentDeletionRetire.mockImplementationOnce(() => {
      mocks.loadConfigReturn = agentConfig({
        "test-agent": { workspace: "/workspace/test-agent" },
      });
    });

    const respond = await call("agents.delete", { agentId: "test-agent" });

    expectRespondErrorContaining(respond, "only configured agent");
    expect(mocks.beginAgentDeletionRetire).toHaveBeenCalledOnce();
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expectUncalled(
      mocks.closeOpenClawAgentDatabaseByPath,
      mocks.movePathToTrash,
      mocks.writeConfigFile,
      mocks.beginAgentDeletionFinish,
    );
  });

  it("rolls cron back and keeps the roster when authority cleanup fails", async () => {
    const cronJobs = [
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ];
    mocks.cronRemoveAgentJobsTransactional.mockImplementation(
      async (agentId: string, commit: () => Promise<unknown>) => {
        const snapshot = structuredClone(cronJobs);
        cronJobs.splice(0, cronJobs.length, ...cronJobs.filter((job) => job.agentId !== agentId));
        try {
          return await commit();
        } catch (error) {
          cronJobs.splice(0, cronJobs.length, ...snapshot);
          throw error;
        }
      },
    );
    mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(new Error("approvals busy"));

    const { promise } = makeCall("agents.delete", { agentId: "test-agent" });

    await expect(promise).rejects.toThrow("approvals busy");
    expect(cronJobs).toEqual([
      { id: "deleted-job", agentId: "test-agent" },
      { id: "other-job", agentId: "other-agent" },
    ]);
    expect(mocks.beginAgentDeletionRollback).toHaveBeenCalledOnce();
    expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalledTimes(1);
    expectUncalled(mocks.writeConfigFile, mocks.movePathToTrash);
  });

  it.each([
    ["recovered cleanup", "approvals busy"],
    ["authority rollback", "approval rollback failed"],
    ["post-write refresh", "post-write refresh failed"],
  ])("keeps deletion fenced after %s failure", async (label, message) => {
    if (label === "post-write refresh") {
      mocks.writeConfigFile.mockImplementationOnce(async (nextConfig) => {
        if (!nextConfig || typeof nextConfig !== "object") {
          throw new Error("expected config object");
        }
        mocks.loadConfigReturn = nextConfig as Record<string, unknown>;
        throw new Error(message);
      });
    } else {
      if (label === "recovered cleanup") {
        mocks.readAgentDeletionJournal.mockReturnValue(deletionJournal());
      }
      mocks.withAgentExecApprovalsRemoved.mockRejectedValueOnce(
        label === "recovered cleanup"
          ? new Error(message)
          : new AgentDeletionAuthorityRollbackError(
              [new Error("config failed"), new Error("approval restore failed")],
              message,
            ),
      );
    }
    await expect(makeCall("agents.delete", { agentId: "test-agent" }).promise).rejects.toThrow(
      message,
    );
    expect(mocks.beginAgentDeletionRollback).not.toHaveBeenCalled();
    if (label !== "post-write refresh") {
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    }
    if (label === "recovered cleanup") {
      expect(mocks.beginAgentDeletionFinish).not.toHaveBeenCalled();
    }
    if (label === "post-write refresh") {
      expect(mocks.closeOpenClawAgentDatabaseByPath).toHaveBeenCalled();
      expect(mocks.movePathToTrash).not.toHaveBeenCalled();
    }
  });
}
