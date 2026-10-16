import { mkdtempSync } from "node:fs";
import path from "node:path";
import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
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
