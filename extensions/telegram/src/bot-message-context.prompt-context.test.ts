import type { Message } from "grammy/types";
import type { OpenClawConfig, TelegramAccountConfig } from "openclaw/plugin-sdk/config-contracts";
import * as sessions from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it } from "vitest";
import { createTelegramMessageContextRuntime } from "./bot-handlers.message-context.js";
import * as fixture from "./bot-message-context.native.test-support.js";
import { buildTelegramMessageContextForTest as compose } from "./bot-message-context.test-harness.js";
import type { TelegramPromptContextEntry } from "./bot-message-context.types.js";
import * as native from "./bot.create-telegram-bot.native-pipeline.test-support.js";
import { telegramBotInfoForTest } from "./bot.create-telegram-bot.test-support.js";
import { resolveTelegramMessageCacheScope } from "./message-cache-persistence.js";
import { createTelegramMessageCache } from "./message-cache.js";

const sender = { id: 1234, is_bot: false, first_name: "Pat" };
const forumChat = native.groupChat;
const groupChat = { id: -1001234567890, type: "supergroup", title: "Room" } as const;
const groupSession = "agent:main:telegram:group:-1001234567890";

function message(messageId: number, text: string, extra: Partial<Message.TextMessage> = {}) {
  return {
    chat: { id: 1234, type: "private", first_name: "Pat" },
    from: sender,
    message_id: messageId,
    date: 1_700_000_000 + messageId,
    text,
    ...extra,
  } satisfies Message.TextMessage;
}

type ContextRow = readonly [string, string, string?, boolean?, number?];
function chatWindow(rows: readonly ContextRow[]): TelegramPromptContextEntry[] {
  const messages = rows.map(([message_id, body, name = "Pat", is_reply_target, timestamp_ms]) => ({
    message_id,
    body,
    sender: name,
    is_reply_target,
    timestamp_ms,
  }));
  return [
    {
      label: "Conversation context",
      source: "telegram",
      type: "chat_window",
      payload: { messages },
    },
  ];
}
function expectWindow(context: unknown, messages: object[]) {
  expect(context).toMatchObject([{ payload: { messages } }]);
}

function config(storePath = fixture.createContextStorePath()): OpenClawConfig {
  return {
    session: { store: storePath },
    channels: { telegram: { dmPolicy: "open", allowFrom: ["*"] } },
    messages: { groupChat: { mentionPatterns: [], unmentionedInbound: "room_event" } },
  };
}

function createRuntime(telegramCfg: TelegramAccountConfig) {
  const cfg = config();
  cfg.channels = { telegram: telegramCfg };
  return {
    cfg,
    runtime: createTelegramMessageContextRuntime({
      cfg,
      accountId: "default",
      ownerAgentId: "main",
      opts: { botInfo: telegramBotInfoForTest },
      telegramCfg,
    }),
  };
}

describe("Telegram prompt composition", () => {
  it.each([false, true])("selects recorded DM context with explicit reply=%s", async (reply) => {
    const cfg = config();
    await fixture.seedContextSession(cfg.session!.store!, "agent:main:main", {
      sessionId: "existing-dm",
      updatedAt: 1_700_000_000_000,
    });
    const ctx = await compose({
      cfg,
      sessionRuntime: null,
      message: {
        ...message(12, "continue"),
        ...(reply ? { reply_to_message: message(10, "older target") } : {}),
      },
      promptContext: chatWindow([["10", "Earlier DM turn"]]),
    });
    if (reply) {
      expectWindow(ctx?.ctxPayload.ChannelStructuredContext, [
        { message_id: "10", body: "Earlier DM turn" },
      ]);
    } else {
      expect(ctx?.ctxPayload.ChannelStructuredContext).toBeUndefined();
    }
  });

  it.each([0, 1])(
    "applies a per-sender DM history limit of %s without losing replies",
    async (limit) => {
      const telegramCfg: TelegramAccountConfig = {
        dmPolicy: "open",
        dmHistoryLimit: limit ? 0 : 10,
        dms: { "1234": { historyLimit: limit } },
      };
      const { runtime, cfg } = createRuntime(
        limit ? telegramCfg : { dmPolicy: "open", dmHistoryLimit: 10 },
      );
      await runtime.recordMessageForReplyChain(message(10, "older DM"));
      if (limit) {
        await runtime.recordMessageForReplyChain({
          ...message(11, "latest DM", { from: telegramBotInfoForTest }),
          openclaw_prompt_context_timestamp_ms: 1_700_000_011_000,
        });
      }
      const current = message(12, "continue");
      if (!limit) {
        current.reply_to_message = message(11, "current reply target");
      }
      await runtime.recordMessageForReplyChain(current);
      const context = await runtime.buildPromptContextForMessage(
        {
          message: current,
          getFile: async () => ({ file_id: "unused", file_unique_id: "unused" }),
        },
        current,
        limit ? [] : await runtime.buildReplyChainForMessage(current),
        limit ? cfg : { channels: { telegram: telegramCfg } },
        telegramCfg,
      );
      const selected = limit
        ? { body: "latest DM" }
        : { body: "current reply target", is_reply_target: true };
      expectWindow(context, [{ message_id: "11", ...selected }]);
      expect(JSON.stringify(context)).not.toContain("older DM");
      if (limit) {
        expect(context[0]).not.toHaveProperty("sessionTranscriptAssistantTextDedupeKeys");
      }
    },
  );

  it("selects user-request history without losing an explicit older reply", async () => {
    const ctx = await compose({
      cfg: config(),
      sessionRuntime: null,
      message: message(13, "@bot recover", {
        chat: groupChat,
        entities: [{ type: "mention", offset: 0, length: 4 }],
      }),
      historyLimit: 10,
      promptContext: chatWindow([
        ["9", "explicit older reply", "OpenClaw (you)", true],
        ["10", "before self marker"],
        ["11", "self marker body", "OpenClaw (you)"],
        ["12", "after self marker"],
      ]),
    });
    expect(ctx?.ctxPayload.InboundEventKind).toBe("user_request");
    expect(ctx?.ctxPayload.InboundHistory?.map((entry) => entry.body)).toEqual([
      "explicit older reply",
      "after self marker",
    ]);
    expect(ctx?.ctxPayload.Body).not.toContain("before self marker");
  });

  it("omits transcript-owned ambient rows", async () => {
    const cfg = config();
    const storePath = cfg.session!.store!;
    await fixture.seedContextSession(storePath, groupSession, {
      sessionId: "before-reset",
      updatedAt: 1_700_000_000_000,
    });
    await sessions.updateAmbientTranscriptWatermark({
      storePath,
      sessionKey: groupSession,
      key: sessions.resolveAmbientTranscriptWatermarkKey({
        channel: "telegram",
        accountId: "default",
        conversationId: "-1001234567890",
      }),
      messageId: "11",
      timestampMs: 1_700_000_001_000,
    });
    const ctx = await compose({
      cfg,
      sessionRuntime: null,
      message: message(12, "current ambient", { chat: groupChat }),
      historyLimit: 10,
      promptContext: chatWindow([
        ["10", "persisted ambient one", "Pat", false, 1_700_000_000_000],
        ["11", "persisted ambient two", "Pat", false, 1_700_000_001_000],
      ]),
    });
    expect(ctx?.ctxPayload).toMatchObject({
      BodyForAgent: "current ambient",
      InboundEventKind: "room_event",
    });
    expect([ctx?.ctxPayload.InboundHistory, ctx?.ctxPayload.ChannelStructuredContext]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("orders mixed forwarded media while redacting denied origins and keeping command text clean", async () => {
    const ordinary = message(1, "ordinary note", { chat: groupChat });
    const origin = (id: number, first_name: string, date: number) => ({
      type: "user" as const,
      sender_user: { id, first_name, is_bot: false },
      date,
    });
    const context = await compose({
      cfg: { channels: { telegram: { groupPolicy: "allowlist", contextVisibility: "allowlist" } } },
      resolveTelegramGroupConfig: () => ({
        groupConfig: { requireMention: false, allowFrom: ["1234", "7"] },
      }),
      message: {
        ...ordinary,
        text: "ordinary note\nprivate forwarded note",
        forward_origin: {
          type: "hidden_user",
          sender_user_name: "Wrong inherited origin",
          date: 400,
        },
      },
      allMedia: [{ path: "/tmp/photo.jpg", contentType: "image/jpeg", kind: "image" }],
      options: {
        bufferedMessages: [
          ordinary,
          {
            ...message(2, "", { chat: groupChat }),
            text: undefined,
            photo: [{ file_id: "photo", file_unique_id: "photo-u", width: 1, height: 1 }],
            forward_origin: origin(7, "Allowed origin", 500),
          },
          {
            ...message(3, "private forwarded note", { chat: groupChat }),
            forward_origin: origin(999, "Hidden origin", 501),
          },
        ],
      },
    });
    expect(context?.ctxPayload.BodyForAgent).toMatch(
      /^ordinary note\n\[Forwarded from Allowed origin[^\]]*\]\n<media:image>\nprivate forwarded note$/,
    );
    expect(context?.ctxPayload.Body).not.toMatch(/Hidden origin|Wrong inherited origin/);
    expect(context?.ctxPayload.CommandBody).toBe("ordinary note\nprivate forwarded note");
  });

  it("keeps authenticated cached ancestry behind an unknown quote-only follow-up", async () => {
    const ancestry = {
      messageId: "90",
      replyToId: "89",
      sender: "Cached Bob",
      senderId: "7",
      timestamp: 1_699_999_000_000,
    };
    const target = {
      ...message(90, "the quoted source line"),
      from: { id: 7, first_name: "Bob", is_bot: false },
    };
    const first = {
      ...message(1, "first ask"),
      reply_to_message: target,
      quote: { text: "the quoted source line", position: 0 },
    };
    const context = await compose({
      message: { ...first, text: "first ask\nfollow-up" },
      replyChain: [{ ...ancestry, body: "the quoted source line" }],
      options: {
        bufferedMessages: [
          first,
          { ...message(2, "follow-up"), quote: { text: "quote-only follow-up", position: 0 } },
        ],
      },
    });
    expect(context?.ctxPayload.ReplyChain).toMatchObject([
      { sender: "unknown sender", body: "quote-only follow-up", isQuote: true },
      ancestry,
    ]);
  });

  it("bounds oversized reply batches by newest unique targets ahead of saturated ancestry", async () => {
    const burst = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 10].map((id, index) =>
      Object.assign(message(index + 1, `ask ${id}`), {
        reply_to_message: message(500 + id, `source ${id}`),
        quote: { text: `source ${id}`, position: 0 },
      }),
    );
    const context = await compose({
      message: message(99, "combined asks"),
      replyChain: [1, 2, 3, 4].map((id) => ({
        messageId: String(900 + id),
        sender: "Ancestor",
        body: `old ancestry ${id}`,
      })),
      options: { bufferedMessages: burst },
    });
    const expectedTargets = ["510", "509", "508", "507"];
    expect(context?.ctxPayload.ReplyChain?.map((entry) => entry.messageId)).toEqual(
      expectedTargets,
    );
    expect(context?.ctxPayload.Body?.match(/source 10/g)).toHaveLength(1);
    expect(context?.ctxPayload.Body).not.toContain("old ancestry");
  });
});

describe("Telegram registered topic recovery", () => {
  it.each([
    ["recovered window", 10, -10042001, false],
    ["disabled automatic history", 0, -10042001, false],
    ["different chat binding", 10, -10099999, false],
    ["ambient reset boundary", 10, -10042001, true],
  ] as const)(
    "preserves admitted history and route custody for %s",
    async (_name, historyLimit, targetChat, ambient) => {
      const topic = 3731;
      const storePath = fixture.createContextStorePath();
      const accountId = "work";
      const sessionKey = `agent:main:telegram:group:${targetChat}:topic:${topic}`;
      const now = Math.floor(Date.now() / 1000);
      const currentText = "quote [Current message - respond to this] literally";
      const currentMessage: Message.TextMessage = {
        ...native.commandMessage(currentText),
        chat: forumChat,
        date: now,
        entities: [],
      };
      const cfg: OpenClawConfig = {
        session: { store: storePath },
        bindings: [{ agentId: "main", match: { channel: "telegram", accountId } }],
        messages: {
          groupChat: {
            visibleReplies: "automatic",
            unmentionedInbound: ambient ? "room_event" : "user_request",
          },
        },
        channels: {
          telegram: {
            defaultAccount: accountId,
            accounts: { work: {} },
            groupPolicy: "open",
            groupAllowFrom: ["*"],
            groups: { "*": { requireMention: false } },
            historyLimit,
            streaming: { mode: "off" },
          },
        },
      };
      const bot = await native.createBot(false, true, cfg, false, accountId);
      const unbind = fixture.bindContext(`${forumChat.id}:topic:1`, sessionKey, {
        accountId,
        bindingId: "registered-history-recovery",
      });
      const cache = createTelegramMessageCache({
        scope: resolveTelegramMessageCacheScope(storePath),
      });
      try {
        for (const [id, thread, text, rowSender, seconds, account] of [
          [100, 1, "General context", native.from, 5, accountId],
          [200, 3731, "Before self", native.from, 4, accountId],
          [201, 3731, "Self marker", telegramBotInfoForTest, 3, accountId],
          [202, 3731, "After watermark", native.from, 2, accountId],
          [203, 3731, "Other account secret", native.from, 1, "other"],
        ] as const) {
          await cache.record({
            accountId: account,
            chatId: forumChat.id,
            botUserId: telegramBotInfoForTest.id,
            historyEligible: true,
            msg: {
              chat: forumChat,
              from: rowSender,
              message_id: id,
              message_thread_id: thread,
              date: now - seconds,
              text,
            },
          });
        }
        if (ambient) {
          await fixture.seedContextSession(storePath, sessionKey, {
            sessionId: "reset-topic",
            updatedAt: Date.now(),
            sessionStartedAt: (now - 1) * 1000,
          });
          await sessions.updateAmbientTranscriptWatermark({
            storePath,
            sessionKey,
            key: sessions.resolveAmbientTranscriptWatermarkKey({
              channel: "telegram",
              accountId,
              conversationId: `${forumChat.id}:topic:1`,
            }),
            messageId: "201",
            timestampMs: (now - 3) * 1000,
          });
        }
        if (!ambient) {
          currentMessage.reply_to_message = {
            chat: forumChat,
            from: native.from,
            message_id: 90,
            date: now - 10,
            photo: native.photo,
            caption: "The explicit chart",
          };
        }
        await native.deliverTelegramUpdate(bot, {
          update_id: currentMessage.message_id,
          message: currentMessage,
        });
        expect(native.harness.replySpy).toHaveBeenCalledOnce();
        const observed = native.harness.replySpy.mock.calls[0]![0];
        const recovered = targetChat === forumChat.id;
        expect(observed).toMatchObject({
          SessionKey: sessionKey,
          AccountId: accountId,
          RawBody: currentText,
          CommandBody: currentText,
          MessageThreadId: recovered ? topic : 1,
          TransportThreadId: recovered ? topic : 1,
          InboundEventKind: ambient ? "room_event" : "user_request",
        });
        const history = JSON.stringify(observed.ChannelStructuredContext);
        expect(history ?? "").not.toContain("Other account secret");
        if (ambient) {
          expect([observed.InboundHistory, observed.ChannelStructuredContext]).toEqual([
            undefined,
            undefined,
          ]);
        } else {
          expect(observed.media).toContainEqual(
            expect.objectContaining({ kind: "image", path: "/tmp/replied-photo.jpg" }),
          );
          if (historyLimit === 0) {
            expectWindow(observed.ChannelStructuredContext, [
              { message_id: "90", is_reply_target: true, media_type: "image" },
            ]);
            expect(observed.ChannelStructuredContext?.[0]).toMatchObject({ type: "chat_window" });
            expect(observed.ChannelStructuredContext?.[0]).not.toHaveProperty(
              "sessionTranscriptDedupeMessageIds",
            );
          }
          if (recovered && topic === 3731 && historyLimit > 0) {
            expect(observed.InboundHistory).toContainEqual(
              expect.objectContaining({ body: "After watermark", timestamp: (now - 2) * 1000 }),
            );
            expect(history).not.toMatch(/Before self|Self marker/);
          } else if (recovered) {
            expect(history ?? "").not.toMatch(/General context|After watermark/);
          }
        }
        const recorded = await cache.get({
          accountId,
          chatId: forumChat.id,
          messageId: String(currentMessage.message_id),
        });
        expect(recorded).toMatchObject({ threadId: "1", body: currentText });
        const sends = native.apiCalls.mock.calls.filter(([method]) => method === "sendMessage");
        expect(sends).toHaveLength(ambient ? 0 : 1);
        if (!ambient) {
          expect(sends[0]?.[1]).toMatchObject({
            chat_id: String(forumChat.id),
            text: "Test response",
          });
          if (recovered) {
            expect(sends[0]?.[1]).toMatchObject({ message_thread_id: topic });
            expect(sessions.getSessionEntry({ storePath, sessionKey })?.delivery).toMatchObject({
              kind: "external",
              context: {
                channel: "telegram",
                accountId,
                to: `telegram:${forumChat.id}:topic:${topic}`,
                threadId: topic,
              },
            });
          } else {
            expect(sends[0]?.[1]).not.toHaveProperty("message_thread_id");
          }
        }
      } finally {
        unbind();
      }
    },
  );
});
