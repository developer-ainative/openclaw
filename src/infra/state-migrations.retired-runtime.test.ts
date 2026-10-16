import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { readPluginBindingApprovalsInDatabase } from "../plugins/conversation-binding-state.kernel.js";
import { writeConfigMachineState } from "../state/config-machine-state-write.js";
import { readConfigMachineState } from "../state/config-machine-state.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { inspectCurrentConversationBindingRecordsInDatabase } from "./outbound/current-conversation-bindings.kernel.js";
import { assertNoRetiredRuntimeStateFiles } from "./state-migrations.retired-runtime-files.js";
import { migrateRetiredRuntimeState } from "./state-migrations.retired-runtime.js";

describe("Doctor retired runtime state recovery", () => {
  const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
    afterEach(() => {
      closeOpenClawStateDatabaseForTest();
      cleanup();
    }),
  );
  let stateDir: string;
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    const home = tempDirs.make("openclaw-retired-runtime-");
    stateDir = path.join(home, ".openclaw");
    env = { ...process.env, HOME: home, OPENCLAW_HOME: home, OPENCLAW_STATE_DIR: stateDir };
  });
  function write(relative: string, value: unknown) {
    const file = path.join(stateDir, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(
      typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`,
    );
    fs.writeFileSync(file, bytes);
    return { file, bytes };
  }
  function migrate() {
    return migrateRetiredRuntimeState({ stateDir, env, assertCurrent() {} });
  }

  it("preserves meaningful settings and bindings while archiving every retired source", async () => {
    const conversation = { channel: "discord", accountId: "default", conversationId: "123" };
    const fixtures = [
      write("settings/voicewake.json", { triggers: [" wake up ", "computer"] }),
      write("settings/voicewake-routing.json", {
        version: 1,
        defaultTarget: { agentId: "work" },
        routes: [],
      }),
      write("bindings/current-conversations.json", {
        version: 1,
        bindings: [{ conversation, targetSessionKey: "agent:main:test", boundAt: 100 }],
      }),
      write("plugin-binding-approvals.json", {
        version: 1,
        approvals: [
          {
            pluginRoot: "/plugins/example",
            pluginId: "example",
            channel: "discord",
            approvedAt: 100,
          },
        ],
      }),
      ...[
        "acp/event-ledger.json",
        "acp/event-ledger.json.doctor-import",
        "restart-sentinel.json",
        "restart-sentinel.json.doctor-importing",
        "update-check.json",
      ].map((file) => write(file, '{"retained":"exact bytes"}\n')),
    ];
    const result = await migrate();
    expect(result.warnings).toHaveLength(fixtures.length);
    expect(readConfigMachineState("voicewake.triggers", { env })).toEqual(["wake up", "computer"]);
    expect(readConfigMachineState("voicewake.routing", { env })).toMatchObject({
      defaultTarget: { agentId: "work" },
    });
    const { db } = openOpenClawStateDatabase({ env });
    expect(inspectCurrentConversationBindingRecordsInDatabase(db, [conversation])[0]).toMatchObject(
      { targetSessionKey: "agent:main:test", boundAt: 100 },
    );
    expect(readPluginBindingApprovalsInDatabase(db)).toEqual([
      {
        pluginRoot: "/plugins/example",
        pluginId: "example",
        pluginName: undefined,
        channel: "discord",
        accountId: "default",
        approvedAt: 100,
      },
    ]);
    for (const { file, bytes } of fixtures) {
      expect(fs.existsSync(file)).toBe(false);
      expect(fs.readFileSync(`${file}.migrated`)).toEqual(bytes);
      expect(result.warnings.join("\n")).toContain(`${file}.migrated`);
    }
    expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
    expect(await migrate()).toEqual({ changes: [], warnings: [] });
  });

  it("keeps canonical settings and preserves a distinct earlier archive", async () => {
    writeConfigMachineState("voicewake.triggers", ["current phrase"], { env });
    const source = write("settings/voicewake.json", { triggers: ["legacy phrase"] });
    fs.writeFileSync(`${source.file}.migrated`, "earlier backup");
    await migrate();
    expect(readConfigMachineState("voicewake.triggers", { env })).toEqual(["current phrase"]);
    expect(fs.readFileSync(`${source.file}.migrated`, "utf8")).toBe("earlier backup");
    expect(fs.readFileSync(`${source.file}.migrated.2`)).toEqual(source.bytes);
  });

  it("archives malformed meaningful data with recovery instructions and still admits updates", async () => {
    const source = write("settings/voicewake.json", "{malformed\n");
    const result = await migrate();
    expect(result.warnings.join("\n")).toContain(
      "Restore the listed trigger phrases through Voice Wake settings",
    );
    expect(fs.readFileSync(`${source.file}.migrated`)).toEqual(source.bytes);
    expect(() => assertNoRetiredRuntimeStateFiles(stateDir, env)).not.toThrow();
  });

  it("does not import another profile's default-home approval", async () => {
    const source = write("plugin-binding-approvals.json", { version: 1, approvals: [] });
    const profileDir = path.join(path.dirname(stateDir), ".openclaw-work");
    await migrateRetiredRuntimeState({ stateDir: profileDir, env, assertCurrent() {} });
    expect(fs.readFileSync(source.file)).toEqual(source.bytes);
  });
});
