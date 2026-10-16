import type { Bot } from "grammy";
import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramGroupConfig } from "openclaw/plugin-sdk/config-contracts";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import * as context from "./bot-message-context.native.test-support.js";
import * as native from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { TelegramConfigSchema } from "./config-schema.js";
import { resetTelegramTopicNameCacheForTest } from "./runtime.test-support.js";
import { createForumTopicTelegram } from "./send-forum-topics.js";
import { getTopicCreatorUserId } from "./topic-name-cache.js";

let storePath: string;
let runtimeError: MockInstance<typeof defaultRuntime.error>;

beforeEach(() => {
  storePath = context.createContextStorePath();
  resetTelegramTopicNameCacheForTest();
  runtimeError = vi.spyOn(defaultRuntime, "error");
});
afterEach(() => {
  resetTelegramTopicNameCacheForTest();
  runtimeError.mockRestore();
});

function config(group: TelegramGroupConfig): OpenClawConfig {
  const cfg = context.contextConfig(storePath, group);
  TelegramConfigSchema.parse(cfg.channels!.telegram);
  return cfg;
}

function topicMessage(text: string, extra: Partial<Message.TextMessage> = {}, threadId = 99) {
  return { ...native.groupCommand(text, threadId), entities: [], ...extra };
}

function media(reply_to_message?: Message["reply_to_message"]) {
  return { ...topicMessage(""), text: undefined, photo: native.photo, reply_to_message };
}

function service(source = "creation") {
  const messageId = source === "foreign topic" ? 100 : 99;
  const topic = context.topicService("Bot topic", telegramBotInfoForTest, messageId);
  return {
    ...topic,
    forum_topic_created: source === "editing" ? undefined : topic.forum_topic_created,
    ...(source === "editing" ? { forum_topic_edited: { name: "Renamed" } } : {}),
  };
}

async function receive(bot: Bot, message: Message) {
  await context.receiveContextMessage(bot, message);
  expect(runtimeError).not.toHaveBeenCalled();
}
const directed = (bot: Bot, text: string, type: "mention" | "bot_command", length: number) =>
  receive(bot, topicMessage(text, { entities: [{ type, offset: 0, length }] }));

async function createTopic(cfg: OpenClawConfig, creatorToken?: string) {
  native.apiResponses.set("createForumTopic", {
    ok: true,
    result: { message_thread_id: 99, name: "Bot topic", icon_color: 7322096 },
  });
  await createForumTopicTelegram(String(native.groupChat.id), "Bot topic", {
    cfg,
    ...(creatorToken ? { token: creatorToken } : {}),
  });
  const store = resolveStorePath(cfg.session?.store, { agentId: "main" });
  await expect(getTopicCreatorUserId(native.groupChat.id, 99, store)).resolves.toBe(
    creatorToken ? 123456789 : telegramBotInfoForTest.id,
  );
}

describe("Telegram bot-created topic mention policy", () => {
  it("accepts text and media in its created topic after reopen while keeping parent and sender gates", async () => {
    const cfg = config({
      requireMention: true,
      requireMentionInBotThreads: false,
      allowFrom: [String(native.from.id)],
    });
    native.publishTelegramTestConfig(cfg);
    await createTopic(cfg);
    resetTelegramTopicNameCacheForTest();
    resetPluginStateStoreForTests();
    const bot = await native.createBot(false, true, cfg);

    await receive(bot, topicMessage("unmentioned parent", {}, 1));
    await receive(bot, topicMessage("denied sender", { from: { ...native.from, id: 123 } }));
    expect(native.harness.replySpy).not.toHaveBeenCalled();

    await receive(bot, topicMessage("unmentioned follow-up"));
    await receive(bot, media());
    expect(native.harness.replySpy).toHaveBeenCalledTimes(2);
    expect(native.harness.replySpy.mock.calls[0]?.[0]).toMatchObject({
      TopicName: "Bot topic",
      SessionKey: "agent:main:telegram:group:-10042001:topic:99",
    });
    expect(native.apiCalls).toHaveBeenCalledWith("getFile", expect.anything());
  });

  it.each([
    { name: "omitted", setting: undefined, topic: undefined, otherBot: false, admitted: false },
    { name: "another bot", setting: false, topic: undefined, otherBot: true, admitted: false },
    { name: "topic override", setting: true, topic: false, otherBot: false, admitted: true },
  ])(
    "keeps exact ownership and configured precedence: $name",
    async ({ setting, topic, otherBot, admitted }) => {
      const cfg = config({
        requireMention: true,
        requireMentionInBotThreads: setting,
        topics: { "99": { requireMentionInBotThreads: topic } },
      });
      const bot = await native.createBot(false, true, cfg);
      await createTopic(cfg, otherBot ? "123456789:another-test-bot" : undefined);
      await receive(bot, topicMessage("ordinary follow-up"));
      expect(native.harness.replySpy).toHaveBeenCalledTimes(admitted ? 1 : 0);
    },
  );

  it("requires mentions for text and media replies while preserving authorized text commands", async () => {
    const cfg = config({ requireMention: false, requireMentionInBotThreads: true });
    const bot = await native.createBot(false, true, cfg);
    await receive(bot, media(service()));
    const reply = topicMessage("Earlier bot answer", { from: telegramBotInfoForTest });
    await receive(bot, topicMessage("follow-up", { reply_to_message: reply }));
    await receive(bot, media(reply));
    expect(native.harness.replySpy).not.toHaveBeenCalled();
    expect(native.apiCalls).not.toHaveBeenCalledWith("getFile", expect.anything());

    await directed(bot, "@openclaw_bot follow-up", "mention", 13);
    expect(native.harness.replySpy).toHaveBeenCalledTimes(1);
    await directed(bot, "/status", "bot_command", 7);
    expect(native.harness.replySpy.mock.calls[1]?.[0]).toMatchObject({
      CommandBody: "/status",
      CommandSource: "text",
      CommandAuthorized: true,
      CommandTurn: { kind: "text-slash", source: "text", body: "/status", authorized: true },
      ExplicitlyMentionedBot: false,
      GroupRequireMention: true,
      MessageThreadId: 99,
    });
  });

  it.each(["creation", "editing", "foreign topic"] as const)(
    "uses observed creation identity without inferring ownership from %s",
    async (source) => {
      const cfg = config({ requireMention: true, requireMentionInBotThreads: false });
      const bot = await native.createBot(false, true, cfg);
      await receive(bot, media(service(source)));
      expect(native.harness.replySpy).toHaveBeenCalledTimes(source === "creation" ? 1 : 0);
    },
  );
});
