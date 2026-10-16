import { mkdtempSync } from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  deliverTelegramUpdate,
  groupChat,
  harness,
} from "./bot.create-telegram-bot.native-pipeline.test-support.js";

let updateId = 12_000;
export function createContextStorePath() {
  return path.join(mkdtempSync(harness.state.path("telegram-context-")), "sessions.json");
}

export function contextConfig(store: string, group: TelegramGroupConfig): OpenClawConfig {
  return {
    session: { store },
    commands: { native: false },
    channels: {
      telegram: {
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        autoTopicLabel: false,
        streaming: { mode: "off" },
        groups: { "*": group },
      },
    },
  };
}

export function topicService(name: string, from?: Message["from"], message_id = 99) {
  return {
    message_id,
    date: 1736380700,
    chat: groupChat,
    from,
    forum_topic_created: { name, icon_color: 0x6fb9f0 },
  };
}

export async function receiveContextMessage(bot: Bot, message: Message) {
  await deliverTelegramUpdate(bot, { update_id: ++updateId, message });
}

export function bindContext(
  conversationId: string,
  targetSessionKey: string,
  options: {
    accountId?: string;
    bindingId?: string;
    metadata?: SessionBindingRecord["metadata"];
  } = {},
) {
  const { accountId = "default", bindingId = "context-binding", metadata } = options;
  const record: SessionBindingRecord = {
    bindingId,
    targetSessionKey,
    targetKind: "session",
    status: "active",
    boundAt: 1,
    metadata,
    conversation: { channel: "telegram", accountId, conversationId },
  };
  const adapter = {
    channel: "telegram",
    accountId,
    listBySession: () => [record],
    resolveByConversation: (conversation: SessionBindingRecord["conversation"]) =>
      conversation.conversationId === conversationId ? record : null,
  };
  registerSessionBindingAdapter(adapter);
  return () => unregisterSessionBindingAdapter({ channel: "telegram", accountId, adapter });
}

export function seedContextSession(
  storePath: string,
  sessionKey: string,
  entry: Parameters<typeof upsertSessionEntry>[0]["entry"],
) {
  return upsertSessionEntry({ storePath, sessionKey, entry });
}
