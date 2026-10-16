import path from "node:path";
import { upsertSessionEntryCore } from "../../config/sessions/session-accessor.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";

export function sessionScope(storePath: string, sessionId: string) {
  return { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}`, storePath };
}

export function withSessionState<T>(
  sessionId: string,
  run: (fixture: {
    state: OpenClawTestState;
    scope: ReturnType<typeof sessionScope>;
  }) => Promise<T>,
  options: {
    storePath?: (state: OpenClawTestState) => string;
  } = {},
) {
  return withOpenClawTestState({ label: sessionId }, async (state) => {
    const scope = sessionScope(
      options.storePath?.(state) ?? path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      sessionId,
    );
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    return run({ state, scope });
  });
}

export function withTranscriptState<T>(
  sessionId: string,
  run: Parameters<typeof withSessionState<T>>[1],
) {
  return withSessionState(sessionId, run, {
    storePath: (state) => state.statePath("transcript.sqlite"),
  });
}
