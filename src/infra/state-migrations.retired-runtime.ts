import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  readPluginBindingApprovalsInDatabase,
  upsertPluginBindingApprovalInDatabase,
} from "../plugins/conversation-binding-state.kernel.js";
import { importConfigMachineState } from "../state/config-machine-state-write.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { hasErrnoCode } from "./errno.js";
import { resolveRequiredHomeDir } from "./home-dir.js";
import { executeSqliteQueryTakeFirstSync, getNodeSqliteKysely } from "./kysely-sync.js";
import { updateCurrentConversationBindingRecordInDatabase } from "./outbound/current-conversation-bindings.kernel.js";
import { normalizeConversationRef } from "./outbound/session-binding-normalization.js";
import type { SessionBindingRecord } from "./outbound/session-binding.types.js";
import { archiveRetiredStateFiles } from "./state-migrations.retired-archive.js";
import { backupLegacyStateSource } from "./state-migrations.source-backup.js";
import type { MigrationMessages } from "./state-migrations.types.js";

type RetiredRuntimeMigrationParams = {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  assertCurrent: () => void;
};

function normalizeLegacyBinding(input: unknown): SessionBindingRecord {
  const value = asRecord(input);
  const ref = asRecord(value.conversation);
  const channel = normalizeOptionalString(ref.channel);
  const conversationId = normalizeOptionalString(ref.conversationId);
  const targetSessionKey = normalizeOptionalString(value.targetSessionKey);
  if (!channel || !conversationId || !targetSessionKey) {
    throw new Error("Invalid legacy conversation binding");
  }
  const conversation = normalizeConversationRef({
    channel,
    accountId: normalizeOptionalString(ref.accountId) ?? "default",
    conversationId,
    ...(typeof ref.parentConversationId === "string"
      ? { parentConversationId: ref.parentConversationId }
      : {}),
  });
  const key = [
    conversation.channel,
    conversation.accountId,
    conversation.parentConversationId ?? "",
    conversation.conversationId,
  ].join("\u241f");
  return {
    bindingId: `generic:${key}`,
    targetSessionKey,
    targetKind: value.targetKind === "subagent" ? "subagent" : "session",
    conversation,
    status: value.status === "ending" || value.status === "ended" ? value.status : "active",
    boundAt:
      typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
        ? Math.floor(value.boundAt)
        : Date.now(),
    ...(typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? { expiresAt: Math.floor(value.expiresAt) }
      : {}),
    ...(value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
      ? { metadata: asRecord(value.metadata) }
      : {}),
  };
}

/** Doctor-only import; ordinary runtime readers never open these retired sources. */
export async function migrateRetiredRuntimeState(
  params: RetiredRuntimeMigrationParams,
): Promise<MigrationMessages> {
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  const result: MigrationMessages = { changes: [], warnings: [] };
  async function migrate(
    relative: string,
    importValue: (value: unknown) => void,
    recovery: string,
  ) {
    const filePath = path.join(params.stateDir, relative);
    try {
      fs.lstatSync(filePath);
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }
    const backup = await backupLegacyStateSource({ filePath, assertCurrent: params.assertCurrent });
    let imported = false;
    try {
      const value: unknown = JSON.parse(backup.bytes.toString("utf8"));
      params.assertCurrent();
      importValue(value);
      imported = true;
      result.changes.push(`Migrated ${relative} → shared SQLite state (existing values retained)`);
    } catch (error) {
      result.warnings.push(`Could not import ${relative}: ${String(error)}. ${recovery}`);
    }
    backup.removeSource(() => undefined);
    result.warnings.push(
      `${relative}: original bytes are preserved at ${backup.backupPath}. ${imported ? "Existing SQLite values were retained." : recovery}`,
    );
  }
  await migrate(
    "settings/voicewake.json",
    (value) => {
      const triggers = normalizeTrimmedStringList(asRecord(value).triggers);
      if (triggers.length === 0) {
        throw new Error("No valid voice wake triggers");
      }
      importConfigMachineState([["voicewake.triggers", triggers]], { env });
    },
    "Restore the listed trigger phrases through Voice Wake settings.",
  );
  await migrate(
    "settings/voicewake-routing.json",
    (value) => {
      const routing = asRecord(value);
      if (!Array.isArray(routing.routes)) {
        throw new Error("Invalid voice wake routing rules");
      }
      // The canonical Voice Wake reader owns route normalization, including legacy defaults.
      importConfigMachineState([["voicewake.routing", routing]], { env });
    },
    "Restore the archived defaultTarget and routes through Voice Wake routing settings.",
  );
  await migrate(
    "bindings/current-conversations.json",
    (value) => {
      const file = asRecord(value);
      if (file.version !== 1 || !Array.isArray(file.bindings)) {
        throw new Error("Expected version 1 conversation bindings");
      }
      const records = file.bindings.map(normalizeLegacyBinding);
      runOpenClawStateWriteTransaction(
        ({ db }) => {
          params.assertCurrent();
          for (const record of records) {
            // An expired canonical binding still supersedes this older source.
            const existing = executeSqliteQueryTakeFirstSync(
              db,
              getNodeSqliteKysely<
                Pick<OpenClawStateKyselyDatabase, "current_conversation_bindings">
              >(db)
                .selectFrom("current_conversation_bindings")
                .select("binding_key")
                .where("binding_key", "=", record.bindingId.slice("generic:".length)),
            );
            if (!existing) {
              updateCurrentConversationBindingRecordInDatabase(
                db,
                record.conversation,
                () => record,
              );
            }
          }
        },
        { env },
      );
    },
    "Use /focus in each archived conversation to reconnect its target session.",
  );
  // The old approvals writer used the default home even when a profile was selected.
  const defaultStateDir = path.join(resolveRequiredHomeDir(env, os.homedir), ".openclaw");
  if (path.resolve(params.stateDir) === path.resolve(defaultStateDir)) {
    await migrate(
      "plugin-binding-approvals.json",
      (value) => {
        const file = asRecord(value);
        if (file.version !== 1 || !Array.isArray(file.approvals)) {
          throw new Error("Expected version 1 plugin binding approvals");
        }
        const approvals = file.approvals.map((input: unknown) => {
          const entry = asRecord(input);
          const pluginRoot = normalizeOptionalString(entry.pluginRoot);
          const pluginId = normalizeOptionalString(entry.pluginId);
          const channel = normalizeOptionalString(entry.channel)?.toLowerCase();
          if (!pluginRoot || !pluginId || !channel) {
            throw new Error("Invalid plugin binding approval");
          }
          return {
            pluginRoot,
            pluginId,
            channel,
            accountId: normalizeOptionalString(entry.accountId) ?? "default",
            pluginName: normalizeOptionalString(entry.pluginName),
            approvedAt:
              typeof entry.approvedAt === "number" && Number.isFinite(entry.approvedAt)
                ? Math.floor(entry.approvedAt)
                : Date.now(),
          };
        });
        runOpenClawStateWriteTransaction(
          ({ db }) => {
            params.assertCurrent();
            const existing = readPluginBindingApprovalsInDatabase(db);
            for (const approval of approvals) {
              if (
                !existing.some(
                  (entry) =>
                    entry.pluginRoot === approval.pluginRoot &&
                    entry.channel === approval.channel &&
                    entry.accountId === approval.accountId,
                )
              ) {
                upsertPluginBindingApprovalInDatabase(db, approval);
              }
            }
          },
          { env },
        );
      },
      "Review and approve the plugin again when binding its channel conversation.",
    );
  }
  const archived = await archiveRetiredStateFiles({
    label: "runtime replay and notification state",
    paths: [
      "acp/event-ledger.json",
      "acp/event-ledger.json.doctor-import",
      "update-check.json",
      "restart-sentinel.json",
      "restart-sentinel.json.doctor-importing",
    ].map((file) => path.join(params.stateDir, file)),
    assertCurrent: params.assertCurrent,
    recoveryInstructions:
      "Replay history and restart notifications are no longer active. Consult this archive to recover old event or notification details; new sessions and update checks rebuild runtime state.",
  });
  result.changes.push(...archived.changes);
  result.warnings.push(...archived.warnings);
  return result;
}
