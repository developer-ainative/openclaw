import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { GatewayRequestError } from "../../../ui/src/api/gateway.ts";
import {
  agentFileValues,
  setAgentFileValues,
} from "../../../ui/src/pages/agents/agent-file-state.test-helpers.ts";
import {
  loadAgentFileContent,
  saveAgentFile,
  type AgentFilesState,
} from "../../../ui/src/pages/agents/files.ts";
import { createTestGatewayClient } from "../../../ui/src/test-helpers/gateway-client.ts";
import { createSandbox } from "../../agents/sandbox/fs-bridge.test-helpers.js";
import { createRemoteShellSandboxFsBridge } from "../../agents/sandbox/remote-fs-bridge.js";
import { createLocalRemoteShellScriptRunner } from "../../agents/sandbox/remote-fs-bridge.test-helpers.js";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { agentsHandlers } from "./agents.js";

type HandlerCall = {
  ok: boolean;
  payload?: unknown;
  error?: ConstructorParameters<typeof GatewayRequestError>[0];
};

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

// The real remote scripts require GNU tools, as they do on the execution host.
const hasGnuShell =
  process.platform !== "win32" &&
  spawnSync("stat", ["--version"], { encoding: "utf8" }).stdout?.includes("GNU coreutils");

function registerFileTests(storage: "local" | "remote") {
  const memory = "MEMORY.md";
  const original = "# Memory\n";
  const edited = "# Memory\n- operator note\n";
  const learned = "# Memory\n- agent learned a birthday\n";
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let workspace: string;
  let storageDir: string;
  let release: (() => void) | undefined;
  let remoteBridge: ReturnType<typeof createRemoteShellSandboxFsBridge> | undefined;
  const broadcast = vi.fn();

  afterEach(() => {
    release?.();
    release = undefined;
  });

  beforeEach(() => {
    broadcast.mockReset();
    workspace = fs.realpathSync(tempDirs.make("openclaw-agent-files-"));
    storageDir = workspace;
    remoteBridge = undefined;
    if (storage === "remote") {
      storageDir = fs.realpathSync(tempDirs.make("openclaw-remote-agent-files-"));
      remoteBridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({ workspaceDir: workspace, agentWorkspaceDir: workspace }),
        runtime: {
          remoteWorkspaceDir: storageDir,
          remoteAgentWorkspaceDir: storageDir,
          runRemoteShellScript: createLocalRemoteShellScriptRunner(),
        },
      });
      release = registerAgentWorkspaceAccess(workspace, { bridge: remoteBridge });
    }
  });

  async function invokeFiles(
    method: "agents.files.list" | "agents.files.get" | "agents.files.set",
    params: Record<string, unknown>,
  ): Promise<HandlerCall> {
    const calls: HandlerCall[] = [];
    await agentsHandlers[method]?.({
      req: { type: "req", id: method, method, params: {} },
      params,
      client: null,
      isWebchatConnect: () => false,
      respond: (ok, payload, error) => {
        calls.push({ ok, payload, error });
      },
      context: {
        getRuntimeConfig: () => ({ agents: { defaults: { workspace } } }),
        broadcast,
      } as never,
    });
    expect(calls).toHaveLength(1);
    return calls[0] as HandlerCall;
  }

  function setFile(
    content: string,
    preconditions: { expectedHash?: string; expectedMissing?: boolean } = {},
    name = memory,
  ) {
    return invokeFiles("agents.files.set", { agentId: "main", name, content, ...preconditions });
  }
  function saveDraft(editor: AgentFilesState) {
    return saveAgentFile(
      editor,
      "main",
      memory,
      expectDefined(agentFileValues(editor, "draft")[memory], "editor draft"),
    );
  }
  function readFile(name = memory): string {
    return fs.readFileSync(path.join(storageDir, name), "utf8");
  }
  function writeFile(content: string, name = memory) {
    fs.writeFileSync(path.join(storageDir, name), content);
  }

  it.each([
    ["ASCII", "x", 1],
    ["multibyte", "é", 2],
  ] as const)("bounds UTF-8 bytes (%s)", async (_, character, bytes) => {
    const name = "AGENTS.md";
    const accepted = character.repeat((2 * 1024 * 1024) / bytes);
    const saved = await setFile(accepted, {}, name);
    expect(saved.ok).toBe(true);
    expect(readFile(name)).toBe(accepted);

    await expect(setFile(`${accepted}x`, {}, name)).rejects.toThrow(
      "Workspace document exceeds its write bound",
    );
    expect(readFile(name)).toBe(accepted);
  });

  it.each([
    ["IDENTITY.md", false],
    ["AGENTS.md", false],
    ["IDENTITY.md", true],
  ] as const)("identity publication (%s, conflict=%s)", async (name, conflict) => {
    const originalIdentity = "- Name: Before\n";
    const replacement = "- Name: After\n";
    writeFile(originalIdentity, name);
    let publishedContent: string | undefined;
    broadcast.mockImplementation(() => {
      publishedContent = readFile(name);
    });
    const result = await setFile(
      replacement,
      { expectedHash: hashContent(conflict ? "stale" : originalIdentity) },
      name,
    );

    expect(result.ok).toBe(!conflict);
    expect(readFile(name)).toBe(conflict ? originalIdentity : replacement);
    if (name === "IDENTITY.md" && !conflict) {
      expect(broadcast).toHaveBeenCalledExactlyOnceWith("agent.identity.changed", {
        agentId: "main",
      });
      expect(publishedContent).toBe(replacement);
    } else {
      expect(broadcast).not.toHaveBeenCalled();
    }
  });

  async function loadEditor(draft: string) {
    const editor: AgentFilesState = {
      client: createTestGatewayClient(async (method, params) => {
        if ((method !== "agents.files.get" && method !== "agents.files.set") || !isRecord(params)) {
          throw new Error(`Unexpected editor request: ${method}`);
        }
        const call = await invokeFiles(method, params);
        if (call.error) {
          throw new GatewayRequestError(call.error);
        }
        expect(call.ok).toBe(true);
        return call.payload;
      }),
      connected: true,
      requestGeneration: 0,
      agents: { recordFile: () => null },
      agentFilesLoading: false,
      agentFilesError: null,
      agentFileEditors: {},
      agentFileConflict: null,
      agentFileSaving: false,
      agentFileWriteRevisions: new Map(),
    };
    expect(await loadAgentFileContent(editor, "main", memory)).toBe(true);
    setAgentFileValues(editor, "draft", { [memory]: draft });
    return editor;
  }

  it("preserves the first creation when two editors loaded a missing document", async () => {
    const first = await loadEditor("# Memory\n- first operator\n");
    const second = await loadEditor("# Memory\n- second operator\n");
    expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);
    expect(await saveDraft(first)).toBe(true);
    expect(readFile()).toBe(agentFileValues(first, "draft")[memory]);
    expect(await saveDraft(second)).toBe(false);
    expect(second.agentFileConflict).toBe(memory);
    expect(agentFileValues(second, "draft")[memory]).toBe("# Memory\n- second operator\n");
    expect(readFile()).toBe("# Memory\n- first operator\n");
  });

  it.runIf(storage === "remote")("rejects unsupported create, permits blind writes", async () => {
    const bridge = expectDefined(remoteBridge, "remote workspace fixture");
    release?.();
    release = registerAgentWorkspaceAccess(workspace, {
      bridge: {
        readFile: bridge.readFile.bind(bridge),
        writeFile: bridge.writeFile.bind(bridge),
        stat: bridge.stat.bind(bridge),
      },
    });
    const editor = await loadEditor("unsaved new memory");
    expect(await saveDraft(editor)).toBe(false);
    expect(editor.agentFilesError).toContain("Update its workspace provider");
    expect(agentFileValues(editor, "draft")[memory]).toBe("unsaved new memory");
    expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);

    const result = await setFile("explicit blind write");
    expect(result.ok).toBe(true);
    expect(readFile()).toBe("explicit blind write");
  });

  it("lists a directory named AGENTS.md as a missing document", async () => {
    fs.mkdirSync(path.join(storageDir, "AGENTS.md"));
    const call = await invokeFiles("agents.files.list", { agentId: "main" });
    expect(call.ok).toBe(true);
    const file = (call.payload as { files: Array<{ name: string; missing: boolean }> }).files.find(
      (entry) => entry.name === "AGENTS.md",
    );
    expect(file).toMatchObject({ name: "AGENTS.md", missing: true });
    expect(file).not.toHaveProperty("size", expect.any(Number));
  });

  it.each(["conflicting-preconditions", "expected-present", "stale", "gone"] as const)(
    "rejects %s preconditions without overwriting",
    async (variant) => {
      let expectedHash = hashContent(original);
      if (variant === "stale") {
        writeFile(original);
        const opened = await invokeFiles("agents.files.get", { agentId: "main", name: memory });
        expect(opened.ok).toBe(true);
        const openedHash = (opened.payload as { file: { hash: string } }).file.hash;
        expect(openedHash).toBe(expectedHash);
        expectedHash = openedHash;
        fs.appendFileSync(path.join(storageDir, memory), "- agent learned a birthday\n");
      }
      const preconditions =
        variant === "conflicting-preconditions"
          ? { expectedMissing: true, expectedHash: hashContent("old") }
          : variant === "expected-present"
            ? { expectedMissing: false }
            : { expectedHash };
      const call = await setFile(edited, preconditions);
      expect(call).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
      if (variant === "stale" || variant === "gone") {
        expect(call.error?.details).toEqual({
          type: "agent_file_conflict",
          name: memory,
          ...(variant === "stale" ? { currentHash: hashContent(learned) } : {}),
        });
      }
      if (variant === "stale") {
        expect(readFile()).toBe(learned);
      } else {
        expect(fs.existsSync(path.join(storageDir, memory))).toBe(false);
      }
    },
  );

  it.each(["uppercase", "omitted"] as const)(
    "accepts %s hash and returns new hash",
    async (hashCase) => {
      writeFile(original);
      const expectedHash = hashContent(original);

      const call = await setFile(
        edited,
        hashCase === "uppercase" ? { expectedHash: expectedHash.toUpperCase() } : {},
      );

      expect(call.ok).toBe(true);
      expect((call.payload as { file: { hash?: string } }).file.hash).toBe(hashContent(edited));
      expect(readFile()).toBe(edited);
    },
  );

  it("admits only one of two concurrent saves that share an expectedHash", async () => {
    writeFile(original);
    const expectedHash = hashContent(original);

    const calls = await Promise.all([
      setFile("# Memory\n- first operator\n", { expectedHash }),
      setFile("# Memory\n- second operator\n", { expectedHash }),
    ]);

    expect(calls.filter((call) => call.ok)).toHaveLength(1);
    expect(["# Memory\n- first operator\n", "# Memory\n- second operator\n"]).toContain(readFile());
    expect(calls.find((call) => !call.ok)?.error?.details).toMatchObject({
      type: "agent_file_conflict",
      currentHash: hashContent(readFile()),
    });
  });
}

for (const storage of ["local", "remote"] as const) {
  describe.runIf(storage === "local" || hasGnuShell)(
    `agents.files.get/set content hashes (${storage})`,
    () => registerFileTests(storage),
  );
}
