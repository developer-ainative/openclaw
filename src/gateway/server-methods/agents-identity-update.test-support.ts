import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, type Mock } from "vitest";
import { registerAgentWorkspaceAccess } from "../../agents/workspace-access.js";
import { FsSafeError, type ReadResult } from "../../infra/fs-safe.js";
import {
  expectRecordFields,
  expectRespondErrorContaining,
  expectRespondOk,
  expectUncalled,
  expectStringContaining,
  expectStringNotContaining,
  mockCallArg,
} from "./agents-mutate.test-support.js";

type IdentityUpdateHarness = {
  mocks: {
    loadConfigReturn: Record<string, unknown>;
    applyAgentConfig: Mock<(cfg: unknown, opts: unknown) => unknown>;
    ensureAgentWorkspace: Mock<
      (params?: { dir?: string }) => Promise<{ dir: string; identityPathCreated: boolean }>
    >;
    rootRead: Mock<(params: { rootDir: string; relativePath: string }) => Promise<ReadResult>>;
    rootWrite: Mock<(params?: unknown) => Promise<void>>;
    writeConfigFile: Mock<(nextConfig?: unknown, writeOptions?: unknown) => Promise<void>>;
    fsMkdir: unknown;
  };
  makeCall: (
    method: "agents.update",
    params: Record<string, unknown>,
  ) => { respond: Mock; promise: Promise<void> | void };
  makeFileStat: () => import("node:fs").Stats;
  createEnoentError: () => Error;
};

/** Share the mutation harness while exercising identity changes through agents.update. */
export function registerAgentIdentityUpdateTests(harness: IdentityUpdateHarness): void {
  const { mocks, makeCall, makeFileStat, createEnoentError } = harness;
  function identityRead(rootDir: string, relativePath: string, content: string): ReadResult {
    return {
      buffer: Buffer.from(content),
      realPath: `${rootDir}/${relativePath}`,
      stat: makeFileStat(),
      containment: "best-effort",
      exactIdentity: { dev: 1n, ino: 1n },
    };
  }
  function readIdentities(files: Record<string, string>) {
    mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
      const content = files[`${rootDir}/${relativePath}`];
      if (content === undefined) {
        throw createEnoentError();
      }
      return identityRead(rootDir, relativePath, content);
    });
  }
  describe("identity", () => {
    it.each(["available", "revoked"] as const)(
      "updates the identity form through remote workspace access when %s",
      async (state) => {
        const workspace = `/remote-identity-${randomUUID()}`;
        mocks.loadConfigReturn = {
          agents: { entries: { "test-agent": { workspace, identity: { name: "Current Agent" } } } },
        };
        let release = () => {};
        const readFile = vi.fn(async () => {
          if (state === "revoked") {
            release();
          }
          return Buffer.from("# Identity\n\n- **Name:** Current Agent\n\nRemote custom notes.\n");
        });
        const writeFile = vi.fn(async () => {});
        release = registerAgentWorkspaceAccess(workspace, {
          bridge: { readFile, writeFile, stat: vi.fn() },
        });
        try {
          const { respond, promise } = makeCall("agents.update", {
            agentId: "test-agent",
            name: "Updated Name",
          });
          if (state === "revoked") {
            await expect(promise).rejects.toThrow("Workspace access");
            expectUncalled(writeFile, mocks.writeConfigFile);
          } else {
            await promise;
            expect(respond).toHaveBeenCalledWith(
              true,
              { ok: true, agentId: "test-agent" },
              undefined,
            );
            expect(writeFile).toHaveBeenCalledWith({
              filePath: "IDENTITY.md",
              data: expect.stringContaining("Updated Name"),
              mkdir: false,
            });
            expect(writeFile).toHaveBeenCalledWith(
              expect.objectContaining({ data: expect.stringContaining("Remote custom notes.") }),
            );
            expect(mocks.writeConfigFile).toHaveBeenCalled();
          }
          expectUncalled(mocks.rootRead, mocks.rootWrite, mocks.fsMkdir);
        } finally {
          release();
        }
      },
    );

    it("does not redirect an identity save when its destination binding changes during fallback read", async () => {
      const workspace = `/identity-move-${randomUUID()}`;
      const destination = `/resolved${workspace}`;
      const oldWrite = vi.fn(async () => {});
      const replacementWrite = vi.fn(async () => {});
      const releaseOld = registerAgentWorkspaceAccess(destination, {
        bridge: {
          readFile: vi.fn(async () => {
            throw createEnoentError();
          }),
          writeFile: oldWrite,
          stat: vi.fn(),
        },
      });
      let releaseReplacement = () => {};
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: destination,
        identityPathCreated: false,
      });
      mocks.rootRead.mockImplementation(async ({ rootDir, relativePath }) => {
        expect(rootDir).toBe("/workspace/test-agent");
        releaseOld();
        releaseReplacement = registerAgentWorkspaceAccess(destination, {
          bridge: { readFile: vi.fn(), writeFile: replacementWrite, stat: vi.fn() },
        });
        return identityRead(
          rootDir,
          relativePath,
          "# Identity\n\n- Name: Current Agent\n\nOriginal notes.\n",
        );
      });
      try {
        const { promise } = makeCall("agents.update", { agentId: "test-agent", workspace });
        await expect(promise).rejects.toThrow("Workspace access changed");
        expectUncalled(oldWrite, replacementWrite, mocks.writeConfigFile);
      } finally {
        releaseOld();
        releaseReplacement();
      }
    });

    it("writes combined identity fields to both config and IDENTITY.md", async () => {
      mocks.rootRead.mockRejectedValue(new FsSafeError("not-found", "file not found"));
      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        name: "New Name",
        emoji: "🤖",
        avatar: "https://example.com/new.png",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      expectRecordFields(mockCallArg(mocks.rootRead), { relativePath: "IDENTITY.md" });
      const configOptions = expectRecordFields(mockCallArg(mocks.applyAgentConfig, 0, 1), {
        name: "New Name",
      });
      expectRecordFields(configOptions.identity, {
        name: "New Name",
        emoji: "🤖",
        avatar: "https://example.com/new.png",
      });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/workspace/test-agent",
        relativePath: "IDENTITY.md",
      });
      expect(write.data).toBe(
        "# IDENTITY.md - Agent Identity\n\n- Name: New Name\n- Theme: steady\n- Emoji: 🤖\n- Avatar: https://example.com/new.png\n",
      );
    });

    it("syncs existing identity into a new workspace even without identity params", async () => {
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: "/resolved/new/workspace",
        identityPathCreated: true,
      });
      readIdentities({
        "/workspace/test-agent/IDENTITY.md":
          "# IDENTITY.md - Agent Identity\n\n- **Name:** Current Agent\n- **Creature:** Steady Turtle\n- **Vibe:** Calm and methodical\n- **Emoji:** 🐢\n\n## Role\n\nProtect the queue.\n",
        "/resolved/new/workspace/IDENTITY.md":
          "# IDENTITY.md - Agent Identity\n\n- **Name:** C-3PO (Clawd's Third Protocol Observer)\n- **Creature:** Flustered Protocol Droid\n\n## Role\n\nDebug agent for `--dev` mode.\n",
      });

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        workspace: "/new/workspace",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
      });
      expectStringContaining(write.data, "- **Creature:** Steady Turtle");
      expectStringContaining(write.data, "## Role");
      expectStringNotContaining(write.data, "Flustered Protocol Droid");
    });

    it("preserves an existing destination identity file when workspace changes", async () => {
      mocks.ensureAgentWorkspace.mockResolvedValueOnce({
        dir: "/resolved/new/workspace",
        identityPathCreated: false,
      });
      readIdentities({
        "/workspace/test-agent/IDENTITY.md":
          "# IDENTITY.md - Agent Identity\n\n- **Name:** Current Agent\n- **Creature:** Old Turtle\n\n## Role\n\nOld workspace role.\n",
        "/resolved/new/workspace/IDENTITY.md":
          "# IDENTITY.md - Agent Identity\n\n- **Name:** Destination Agent\n- **Creature:** Destination Fox\n\n## Role\n\nDestination workspace role.\n",
      });

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        workspace: "/new/workspace",
      });
      await promise;

      expectRespondOk(respond, { ok: true, agentId: "test-agent" });
      const write = expectRecordFields(mockCallArg(mocks.rootWrite), {
        rootDir: "/resolved/new/workspace",
        relativePath: "IDENTITY.md",
      });
      expectStringContaining(write.data, "- **Creature:** Destination Fox");
      expectStringContaining(write.data, "Destination workspace role.");
      expectStringNotContaining(write.data, "Old workspace role.");
    });

    it("does not persist config when IDENTITY.md write fails on update", async () => {
      mocks.rootWrite.mockRejectedValueOnce(
        new FsSafeError("path-mismatch", "path escapes workspace root"),
      );

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        name: "Bad Update",
        avatar: "https://example.com/avatar.png",
      });
      await promise;

      expectRespondErrorContaining(respond, "unsafe workspace file");
      expect(mocks.writeConfigFile).not.toHaveBeenCalled();
    });

    it("treats unsafe IDENTITY.md reads as invalid update requests", async () => {
      mocks.rootRead.mockRejectedValue(
        new FsSafeError("invalid-path", "path is not a regular file under root"),
      );

      const { respond, promise } = makeCall("agents.update", {
        agentId: "test-agent",
        avatar: "https://example.com/unsafe.png",
      });
      await promise;

      expectRespondErrorContaining(respond, 'unsafe workspace file "IDENTITY.md"');
      expectUncalled(mocks.writeConfigFile, mocks.rootWrite);
    });
  });
}
