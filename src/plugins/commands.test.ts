// Covers plugin CLI command behavior and output paths.
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { createChannelTestPluginBase, createTestRegistry } from "../test-utils/channel-plugins.js";
import { listRegisteredPluginAgentPromptGuidance } from "./command-registry-state.js";
import {
  getPluginCommandEntrySpecs,
  getPluginCommandSpecs,
  listProviderPluginCommandSpecs,
} from "./command-specs.js";
import {
  clearPluginCommands,
  executePluginCommand,
  listPluginCommands,
  matchPluginCommand,
  registerPluginCommand,
} from "./commands.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { createPluginRegistry } from "./registry.js";
import { setActivePluginRegistry, withPluginRegistrationContext } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import type { PluginRuntime } from "./runtime/types.js";
import { createBundledPluginRecord } from "./status.test-fixtures.js";

const completionMocks = vi.hoisted(() => ({
  acquireSimpleCompletionModelForAgent:
    vi.fn<
      typeof import("../agents/simple-completion-runtime.js").acquireSimpleCompletionModelForAgent
    >(),
  completeWithPreparedSimpleCompletionModel: vi.fn(),
  resolveSimpleCompletionSelectionForAgent: vi.fn(),
}));

vi.mock("../agents/simple-completion-runtime.js", () => ({
  acquireSimpleCompletionModelForAgent: completionMocks.acquireSimpleCompletionModelForAgent,
  completeWithPreparedSimpleCompletionModel:
    completionMocks.completeWithPreparedSimpleCompletionModel,
  resolveSimpleCompletionSelectionForAgent:
    completionMocks.resolveSimpleCompletionSelectionForAgent,
}));

type CommandsModule = typeof import("./commands.js");

const commandsModuleUrl = new URL("./commands.ts", import.meta.url).href;

async function importCommandsModule(cacheBust: string): Promise<CommandsModule> {
  return (await import(`${commandsModuleUrl}?t=${cacheBust}`)) as CommandsModule;
}

type CommandHandler = Parameters<typeof registerPluginCommand>[1]["handler"];
const okHandler = () => vi.fn<CommandHandler>(async () => ({ text: "ok" }));

function createVoiceCommand(overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {}) {
  return {
    name: "voice",
    description: "Voice command",
    handler: async () => ({ text: "ok" }),
    ...overrides,
  };
}

type ExecutionParams = Parameters<typeof executePluginCommand>[0];

function executeCommand({
  command,
  ...params
}: Partial<Omit<ExecutionParams, "command">> & {
  command: Partial<ExecutionParams["command"]> &
    Pick<ExecutionParams["command"], "name" | "handler">;
}) {
  return executePluginCommand({
    channel: "telegram",
    isAuthorizedSender: true,
    config: {},
    commandBody: `/${command.name}`,
    ...params,
    command: {
      description: "Demo command",
      pluginId: "demo-plugin",
      acceptsArgs: false,
      ...command,
    },
  });
}

function channelRegistration(id: string, label: string, options: Partial<ChannelPlugin> = {}) {
  return {
    pluginId: id,
    source: "test",
    plugin: { ...createChannelTestPluginBase({ id, label }), ...options },
  };
}

function createCommandRegistry() {
  return createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: {} as PluginRuntime,
    activateGlobalSideEffects: true,
  });
}

function registerVoiceCommandForTest(
  overrides: Partial<Parameters<typeof registerPluginCommand>[1]> = {},
) {
  return registerPluginCommand("demo-plugin", createVoiceCommand(overrides));
}

function expectCommandMatch(
  commandBody: string,
  params: { name: string; pluginId: string; args: string },
) {
  expect(requirePluginCommandMatch(commandBody)).toMatchObject({
    command: { name: params.name, pluginId: params.pluginId },
    args: params.args,
  });
}

function requirePluginCommandMatch(commandBody: string) {
  const match = matchPluginCommand(commandBody);
  if (!match) {
    throw new Error(`expected plugin command match for ${commandBody}`);
  }
  return match;
}

function expectProviderCommandSpecCases(
  cases: ReadonlyArray<readonly [Parameters<typeof getPluginCommandSpecs>[0], readonly string[]]>,
) {
  for (const [provider, names] of cases) {
    expect(getPluginCommandSpecs(provider)).toEqual(
      names.map((name) => ({ name, description: "Demo command", acceptsArgs: false })),
    );
  }
}

function expectUnsupportedBindingApiResult(result: { text?: string }) {
  expect(result.text).toBe(
    JSON.stringify({
      requested: {
        status: "error",
        message: "This command cannot bind the current conversation.",
      },
      current: null,
      detached: { removed: false },
    }),
  );
}

beforeEach(() => {
  completionMocks.acquireSimpleCompletionModelForAgent.mockReset();
  completionMocks.acquireSimpleCompletionModelForAgent.mockResolvedValue({
    async [Symbol.asyncDispose]() {},
    selection: {
      provider: "openai",
      modelId: "gpt-5.5",
      agentDir: "/tmp/openclaw-agent",
    },
    model: {
      provider: "openai",
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai",
      baseUrl: "https://fixture.invalid/v1",
      input: ["text"],
      reasoning: false,
      contextWindow: 128_000,
      maxTokens: 4096,
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 },
    },
    auth: {
      apiKey: "test-api-key",
      source: "test",
      mode: "api-key",
    },
  });
  completionMocks.completeWithPreparedSimpleCompletionModel.mockReset();
  completionMocks.completeWithPreparedSimpleCompletionModel.mockResolvedValue({
    content: [{ type: "text", text: "done" }],
    usage: {},
  });
  completionMocks.resolveSimpleCompletionSelectionForAgent.mockReset();
  completionMocks.resolveSimpleCompletionSelectionForAgent.mockReturnValue({
    provider: "openai",
    modelId: "gpt-5.5",
    agentDir: "/tmp/openclaw-agent",
  });
  setActivePluginRegistry(
    createTestRegistry([
      channelRegistration("telegram", "Telegram", {
        commands: { nativeCommandsAutoEnabled: true },
        bindings: { selfParentConversationByDefault: true, resolveCommandConversation: () => null },
      }),
      channelRegistration("discord", "Discord", {
        commands: { nativeCommandsAutoEnabled: true },
        bindings: { resolveCommandConversation: () => null },
      }),
      channelRegistration("signal", "Signal", { commands: { nativeCommandsAutoEnabled: true } }),
      channelRegistration("slack", "Slack", {
        capabilities: { nativeCommands: true, chatTypes: ["direct", "group"] },
      }),
    ]),
  );
});

afterEach(() => {
  clearPluginCommands();
});

const completeDraft: CommandHandler = async (ctx) => {
  await ctx.runtimeContext?.llm?.complete({ messages: [{ role: "user", content: "draft" }] });
  return { text: "ok" };
};

describe("registerPluginCommand", () => {
  it("writes direct registrations into the synchronous builder context", () => {
    const active = createEmptyPluginRegistry();
    const building = createEmptyPluginRegistry();
    setActivePluginRegistry(active);

    expect(
      withPluginRegistrationContext(building, "demo-plugin", () =>
        registerPluginCommand("spoofed-plugin", createVoiceCommand()),
      ),
    ).toEqual({ ok: true });
    expect(active.commands).toStrictEqual([]);
    expect(building.commands.map((entry) => entry.command.name)).toEqual(["voice"]);
    expect(building.commands[0]?.pluginId).toBe("demo-plugin");
  });

  it.each([
    {
      name: "rejects invalid command names",
      // Runtime plugin payloads are untyped; guard at boundary.
      command: { name: undefined as unknown as string },
      error: "Command name must be a string",
    },
    {
      name: "rejects invalid command descriptions",
      command: { description: undefined as unknown as string },
      error: "Command description must be a string",
    },
    {
      name: "rejects invalid agent prompt guidance",
      command: { agentPromptGuidance: "use /demo" as unknown as string[] },
      error: "Agent prompt guidance must be an array of strings or objects",
    },
    {
      name: "rejects invalid structured agent prompt guidance",
      command: { agentPromptGuidance: [{ text: "Use /demo.", surfaces: ["nope"] }] as never },
      error:
        "Agent prompt guidance 1 surface 1 must be one of: openclaw_main, pi_main, codex_app_server, cli_backend, acp_backend, subagent",
    },
    {
      name: "rejects empty structured agent prompt guidance surfaces",
      command: { agentPromptGuidance: [{ text: "Use /demo.", surfaces: [] }] as never },
      error: "Agent prompt guidance 1 surfaces cannot be empty",
    },
    {
      name: "rejects invalid channel scopes",
      command: { channels: ["telegram", "   "] },
      error: "Command channel 2 cannot be empty",
    },
    {
      name: "rejects primitive native command metadata",
      command: { nativeNames: "demo-native" },
      error: "Command nativeNames must be an object",
    },
    {
      name: "rejects primitive client presentation metadata",
      command: { clientPresentation: "device-pairing" },
      error: "Command clientPresentation must be an object",
    },
    {
      name: "rejects unknown client presentation actions",
      command: {
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "open-route" },
        },
      },
      error: "Command clientPresentation action kind is not supported",
    },
    {
      name: "rejects additional client presentation fields",
      command: {
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
          route: "/settings/devices",
        },
      },
      error: "Command clientPresentation must contain only when and action",
    },
    {
      name: "rejects additional client presentation action fields",
      command: {
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing", callback: "run" },
        },
      },
      error: "Command clientPresentation action must contain only kind",
    },
  ] as const)("$name", ({ command, error }) => {
    expect(registerPluginCommand("demo-plugin", createVoiceCommand(command as never))).toEqual({
      ok: false,
      error,
    });
  });

  it("normalizes command metadata for downstream consumers", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "  demo_cmd  ",
      description: "  Demo command  ",
      agentPromptGuidance: ["  Use /demo_cmd for demo routing.  "],
      clientPresentation: {
        when: "no-arguments",
        action: { kind: "device-pairing" },
      },
      handler: okHandler(),
    });
    expect(result).toEqual({ ok: true });
    const spec = { name: "demo_cmd", description: "Demo command", acceptsArgs: false };
    expect(listPluginCommands()).toEqual([{ ...spec, pluginId: "demo-plugin" }]);
    expect(getPluginCommandSpecs()).toEqual([spec]);
    expect(getPluginCommandEntrySpecs()).toEqual([
      {
        ...spec,
        nativeName: "demo_cmd",
        clientPresentation: {
          when: "no-arguments",
          action: { kind: "device-pairing" },
        },
      },
    ]);
    expect(listRegisteredPluginAgentPromptGuidance()).toEqual(["Use /demo_cmd for demo routing."]);
  });

  it("prefers a request-scoped registry over ambient compatibility state", async () => {
    const ambientHandler = vi.fn(async () => ({ text: "ambient" }));
    const scopedHandler = vi.fn(async () => ({ text: "scoped" }));
    expect(
      registerPluginCommand("ambient", {
        name: "same",
        description: "Ambient command",
        agentPromptGuidance: ["Ambient guidance"],
        handler: ambientHandler,
      }),
    ).toEqual({ ok: true });
    const scoped = createEmptyPluginRegistry();

    await withPluginRuntimeRegistryScope(scoped, async () => {
      expect(
        registerPluginCommand("scoped", {
          name: "same",
          description: "Scoped command",
          agentPromptGuidance: ["Scoped guidance"],
          handler: scopedHandler,
        }),
      ).toEqual({ ok: true });
      expect(listProviderPluginCommandSpecs().map((entry) => entry.description)).toEqual([
        "Scoped command",
      ]);
      expect(listRegisteredPluginAgentPromptGuidance()).toEqual(["Scoped guidance"]);
      const match = matchPluginCommand("/same");
      expect(match?.command.pluginId).toBe("scoped");
      await executeCommand({
        command: match!.command,
        senderId: "user-1",
        commandBody: "/same",
      });
    });

    expect(scopedHandler).toHaveBeenCalledOnce();
    expect(ambientHandler).not.toHaveBeenCalled();
    expect(listRegisteredPluginAgentPromptGuidance()).toEqual(["Ambient guidance"]);
  });

  it.each([["zeta-plugin", "alpha-plugin"]])(
    "keeps prompt guidance stable for plugin discovery order %j",
    (...pluginIds) => {
      for (const pluginId of pluginIds) {
        const alpha = pluginId === "alpha-plugin";
        expect(
          registerPluginCommand(pluginId, {
            name: alpha ? "alpha_cmd" : "zeta_cmd",
            description: alpha ? "Alpha command" : "Zeta command",
            agentPromptGuidance: alpha
              ? ["Use /alpha_cmd first.", "Then finish the alpha workflow."]
              : ["Use /zeta_cmd for zeta routing."],
            handler: okHandler(),
          }),
        ).toEqual({ ok: true });
      }

      expect(listRegisteredPluginAgentPromptGuidance()).toEqual([
        "Use /alpha_cmd first.",
        "Then finish the alpha workflow.",
        "Use /zeta_cmd for zeta routing.",
      ]);
    },
  );

  it("normalizes and filters structured agent prompt guidance by surface", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "demo_cmd",
      description: "Demo command",
      agentPromptGuidance: [
        "  Use /demo_cmd everywhere.  ",
        {
          text: "  Use /demo_cmd for main agent routing.  ",
          surfaces: ["openclaw_main"],
        },
        {
          text: "Use /demo_cmd for subagents.",
          surfaces: ["subagent"],
        },
      ],
      handler: okHandler(),
    });
    expect(result).toEqual({ ok: true });

    expect(listRegisteredPluginAgentPromptGuidance()).toEqual([
      "Use /demo_cmd everywhere.",
      "Use /demo_cmd for main agent routing.",
      "Use /demo_cmd for subagents.",
    ]);
    expect(listRegisteredPluginAgentPromptGuidance({ surface: "openclaw_main" })).toEqual([
      "Use /demo_cmd everywhere.",
      "Use /demo_cmd for main agent routing.",
    ]);
    expect(listRegisteredPluginAgentPromptGuidance({ surface: "pi_main" })).toEqual([
      "Use /demo_cmd everywhere.",
      "Use /demo_cmd for main agent routing.",
    ]);
    expect(listRegisteredPluginAgentPromptGuidance({ surface: "subagent" })).toEqual([
      "Use /demo_cmd everywhere.",
      "Use /demo_cmd for subagents.",
    ]);
    expect(
      listRegisteredPluginAgentPromptGuidance({
        surface: "subagent",
        includeLegacyGlobalGuidance: false,
      }),
    ).toEqual(["Use /demo_cmd for subagents."]);
  });

  it("matches underscore aliases for hyphenated command names", () => {
    registerPluginCommand("demo-plugin", {
      name: "active-memory",
      description: "Active Memory command",
      acceptsArgs: true,
      handler: okHandler(),
    });

    expectCommandMatch("/active_memory status", {
      name: "active-memory",
      pluginId: "demo-plugin",
      args: "status",
    });
  });

  it.each(["active_memory", "active-memory"])(
    "prefers exact spelling %s even when its command rejects arguments",
    (name) => {
      const alternate = name.replace(/[_-]/g, name.includes("_") ? "-" : "_");
      for (const [commandName, acceptsArgs] of [
        [alternate, true],
        [name, false],
      ] as const) {
        expect(
          registerPluginCommand(commandName, {
            name: commandName,
            description: "Exact spelling selection",
            acceptsArgs,
            handler: okHandler(),
          }),
        ).toEqual({ ok: true });
      }
      expect(matchPluginCommand(`/${name}`)?.command.name).toBe(name);
      expect(matchPluginCommand(`/${name} status`)).toBeNull();
    },
  );

  it("matches plugin slash commands when users insert whitespace after the slash", () => {
    registerPluginCommand("device-pair", {
      name: "pair",
      description: "Pair command",
      acceptsArgs: true,
      handler: okHandler(),
    });

    expectCommandMatch("/ pair qr", {
      name: "pair",
      pluginId: "device-pair",
      args: "qr",
    });
  });

  it("supports provider-specific native command aliases", () => {
    const result = registerVoiceCommandForTest({
      nativeNames: {
        default: "talkvoice",
        discord: "discordvoice",
      },
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    expectProviderCommandSpecCases([
      [undefined, ["talkvoice"]],
      ["discord", ["discordvoice"]],
      ["telegram", ["talkvoice"]],
      ["slack", []],
    ]);
  });

  it("scopes plugin command matches and native specs to configured channels", () => {
    const result = registerVoiceCommandForTest({
      channels: [" Telegram "],
      description: "Demo command",
    });

    expect(result).toEqual({ ok: true });
    const telegramMatch = matchPluginCommand("/voice", { channel: "telegram" });
    expect(telegramMatch?.command).toMatchObject({ name: "voice", channels: ["telegram"] });
    expect(matchPluginCommand("/voice", { channel: "discord" })).toBeNull();
    expect(matchPluginCommand("/voice")?.command.name).toBe("voice");
    expectProviderCommandSpecCases([
      [undefined, ["voice"]],
      ["telegram", ["voice"]],
      ["discord", []],
    ]);
    expect(listProviderPluginCommandSpecs("discord")).toStrictEqual([]);
  });

  it("requires config before using read-only manifest command defaults", () => {
    setActivePluginRegistry(createTestRegistry([]));
    registerVoiceCommandForTest({
      nativeNames: {
        discord: "discordvoice",
      },
      description: "Demo command",
    });
    const env = {
      ...process.env,
      OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
    };

    expect(getPluginCommandSpecs("discord", { env })).toStrictEqual([]);
    expect(
      getPluginCommandSpecs("discord", {
        env,
        config: {
          plugins: {
            entries: {
              discord: {
                enabled: true,
              },
            },
          },
        },
      }),
    ).toEqual([
      {
        name: "discordvoice",
        description: "Demo command",
        acceptsArgs: false,
      },
    ]);
  });

  it("exposes native description localizations on plugin command specs", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      descriptionLocalizations: { ko: "데모 명령" },
    });

    expect(result).toEqual({ ok: true });
    expect(listProviderPluginCommandSpecs("discord")).toEqual([
      {
        name: "voice",
        description: "Demo command",
        descriptionLocalizations: { ko: "데모 명령" },
        acceptsArgs: false,
      },
    ]);
  });

  it("rejects empty native description localizations", () => {
    const result = registerVoiceCommandForTest({
      description: "Demo command",
      descriptionLocalizations: { ko: "   " },
    });

    expect(result).toEqual({
      ok: false,
      error: 'Description localization "ko" cannot be empty',
    });
  });

  it("keeps reserved command bypass scoped to the primary command name", () => {
    const result = registerPluginCommand(
      "status",
      createVoiceCommand({
        name: "status",
        nativeNames: {
          telegram: "help",
        },
      }),
      { allowReservedCommandNames: true },
    );

    expect(result).toEqual({
      ok: false,
      error:
        'Native command alias "telegram" invalid: Command name "help" is reserved by a built-in command',
    });
  });

  it("reserves the bundled Codex command name", () => {
    const result = registerPluginCommand("demo-plugin", {
      name: "codex",
      description: "Fake Codex command",
      handler: okHandler(),
    });

    expect(result).toEqual({
      ok: false,
      error: 'Command name "codex" is reserved by a built-in command',
    });
  });

  it("sanitizes oversized arguments before passing them to plugin handlers", async () => {
    let observedArgs: string | undefined;
    registerVoiceCommandForTest({
      acceptsArgs: true,
      handler: async (ctx) => {
        observedArgs = ctx.args;
        return { text: "ok" };
      },
    });
    const match = requirePluginCommandMatch(`/voice \0${"a".repeat(4094)}😀tail`);

    await executeCommand({
      command: match.command,
      args: match.args,
      commandBody: "/voice",
    });

    expect(observedArgs).toBe("a".repeat(4094));
  });

  it.each([
    ["direct", undefined],
    ["workspace", undefined],
    ["bundled", true],
    ["reserved", true],
  ] as const)("exposes owner status only to trusted %s commands", async (origin, expected) => {
    const handler = okHandler();
    const name = origin === "reserved" ? "codex" : "voice";
    const command = createVoiceCommand({
      name,
      handler,
      ...(origin === "reserved" ? { ownership: "reserved" } : { exposeSenderIsOwner: true }),
    });
    if (origin === "direct") {
      registerPluginCommand("demo-plugin", command);
    } else {
      const registry = createCommandRegistry();
      const record = createBundledPluginRecord(
        origin === "reserved"
          ? "codex"
          : origin === "workspace"
            ? "external-plugin"
            : "device-pair",
      );
      registry.registerCommand(
        origin === "workspace"
          ? {
              ...record,
              origin: "workspace",
              source: "/workspace/external-plugin/index.ts",
              rootDir: "/workspace/external-plugin",
            }
          : record,
        command,
      );
      setActivePluginRegistry(registry.registry);
    }
    await executeCommand({
      command: requirePluginCommandMatch(`/${name}`).command,
      senderIsOwner: true,
    });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0]?.[0].senderIsOwner).toBe(expected);
  });

  it("skips direct plugin command execution on unsupported channels", async () => {
    const handler = okHandler();

    const result = await executeCommand({
      command: {
        name: "voice",
        description: "Voice command",
        channels: ["qqbot"],
        handler,
      },
      channel: "discord",
      commandBody: "/voice",
    });

    expect(result).toEqual({ continueAgent: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("does not allow direct reserved command registrations to claim owner status", () => {
    const result = registerPluginCommand(
      "codex",
      {
        name: "codex",
        description: "Codex command",
        ownership: "reserved",
        handler: okHandler(),
      },
      { allowReservedCommandNames: true },
    );

    expect(result).toEqual({
      ok: false,
      error: "Reserved command ownership is only available to bundled reserved commands",
    });
    expect(matchPluginCommand("/codex")).toBeNull();
  });

  it("rejects mismatched reserved command owners", () => {
    const pluginRegistry = createCommandRegistry();
    pluginRegistry.registerCommand(createBundledPluginRecord("bundled-plugin"), {
      name: "codex",
      description: "Codex command",
      ownership: "reserved",
      handler: okHandler(),
    });

    const diagnostic = pluginRegistry.registry.diagnostics.find(
      (entry) => entry.pluginId === "bundled-plugin",
    );
    expect(diagnostic).toMatchObject({
      level: "error",
      message:
        'command registration failed: Reserved command ownership requires plugin id "bundled-plugin" to match reserved command name "codex"',
    });
  });

  it("shares plugin commands across duplicate module instances", async () => {
    const first = await importCommandsModule(`first-${Date.now()}`);
    const second = await importCommandsModule(`second-${Date.now()}`);

    first.clearPluginCommands();

    expect(
      first.registerPluginCommand(
        "demo-plugin",
        createVoiceCommand({
          nativeNames: {
            telegram: "voice",
          },
        }),
      ),
    ).toEqual({ ok: true });

    expect(getPluginCommandSpecs("telegram")).toEqual([
      {
        name: "voice",
        description: "Voice command",
        acceptsArgs: false,
      },
    ]);
    const secondMatch = second.matchPluginCommand("/voice");
    expect(secondMatch?.command).toMatchObject({ name: "voice", pluginId: "demo-plugin" });

    second.clearPluginCommands();
  });

  it.each(["discord"] as const)(
    "matches live %s aliases back to the canonical command",
    (provider) => {
      const nativeNames = { default: "talkvoice", discord: "discordvoice" };
      const commandBody = `/${nativeNames[provider]} now`;
      const result = registerVoiceCommandForTest({
        nativeNames,
        description: "Demo command",
        acceptsArgs: true,
      });

      expect(result).toEqual({ ok: true });
      expectCommandMatch(commandBody, {
        name: "voice",
        pluginId: "demo-plugin",
        args: "now",
      });
      nativeNames[provider] = "renamedvoice";
      expect(matchPluginCommand(commandBody)).toBeNull();
      expectCommandMatch("/renamedvoice later", {
        name: "voice",
        pluginId: "demo-plugin",
        args: "later",
      });
    },
  );

  it("rejects provider aliases that collide with another registered command", () => {
    registerVoiceCommandForTest({ nativeNames: { telegram: "pair_device" } });
    expect(
      registerPluginCommand(
        "other-plugin",
        createVoiceCommand({
          name: "pair",
          nativeNames: { telegram: "pair_device" },
          description: "Pair command",
        }),
      ),
    ).toEqual({
      ok: false,
      error: 'Command "pair_device" already registered by plugin "demo-plugin"',
    });
  });

  it("does not expose binding APIs to plugin commands on unsupported channels", async () => {
    const handler: CommandHandler = async (ctx) => {
      const requested = await ctx.requestConversationBinding({
        summary: "Bind this conversation.",
      });
      const current = await ctx.getCurrentConversationBinding();
      const detached = await ctx.detachConversationBinding();
      return {
        text: JSON.stringify({ requested, current, detached }),
      };
    };
    registerPluginCommand(
      "demo-plugin",
      {
        name: "bindcheck",
        description: "Demo command",
        acceptsArgs: false,
        handler,
      },
      { pluginRoot: "/plugins/demo-plugin" },
    );

    const result = await executeCommand({
      command: {
        name: "bindcheck",
        handler,
        pluginRoot: "/plugins/demo-plugin",
      },
      channel: "slack",
      senderId: "U123",
      from: "slack:U123",
      to: "C456",
      accountId: "default",
    });

    expectUnsupportedBindingApiResult(result);
  });

  it("uses the stable originating target for plugin conversation commands", async () => {
    const resolveCommandConversation = vi.fn(() => null);
    setActivePluginRegistry(
      createTestRegistry([
        channelRegistration("slack", "Slack", { bindings: { resolveCommandConversation } }),
      ]),
    );
    const handler = vi.fn(async () => ({ text: "ok" }));

    await executeCommand({
      command: {
        name: "control",
        description: "Control a binding",
        handler,
      },
      channel: "slack",
      senderId: "U123",
      from: "slack:U123",
      to: "changed-runtime-target",
      originatingTo: "user:U123",
      accountId: "default",
    });

    expect(resolveCommandConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        originatingTo: "user:U123",
        commandTo: "changed-runtime-target",
      }),
    );
  });

  it("passes host session identity through to the plugin command context", async () => {
    let receivedCtx: Parameters<CommandHandler>[0] | undefined;
    const handler: CommandHandler = async (ctx) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executeCommand({
      command: {
        name: "sessioncheck",
        handler,
      },
      channel: "whatsapp",
      senderId: "U123",
      sessionKey: "agent:main:whatsapp:direct:123",
      sessionId: "session-123",
      commandBody: "/sessioncheck",
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx).toMatchObject({
      sessionKey: "agent:main:whatsapp:direct:123",
      sessionId: "session-123",
    });
  });

  it("binds legacy main session plugin llm runtime to the default agent", async () => {
    await executeCommand({
      command: {
        name: "runtimecheck",
        handler: completeDraft,
      },
      senderId: "U123",
      sessionKey: "main",
      config: {
        agents: {
          entries: { ops: {} },
          defaults: {
            model: "openai/gpt-5.5",
          },
        },
        session: {
          mainKey: "main",
        },
      } as never,
    });

    expect(completionMocks.acquireSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ops",
      }),
    );
  });

  it("binds plugin-owned command sessions to the host-resolved agent", async () => {
    await executeCommand({
      command: {
        name: "runtimecheck",
        handler: completeDraft,
      },
      channel: "discord",
      senderId: "U123",
      agentId: "codex",
      sessionKey: "plugin-binding:openclaw-codex-app-server:dm",
      authProfileId: "openai:owner@example.com",
      commandBody: "/runtimecheck",
    });

    expect(completionMocks.acquireSimpleCompletionModelForAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "codex",
        preferredProfile: "openai:owner@example.com",
      }),
    );
  });

  it("normalizes undefined plugin command handler results to an empty reply payload", async () => {
    const handler = async () => undefined as never;

    const result = await executeCommand({
      command: {
        name: "silentcheck",
        handler,
      },
      senderId: "U123",
      commandBody: "/silentcheck",
    });

    expect(result).toStrictEqual({});
  });

  it("passes the effective default account to plugin command handlers when accountId is omitted", async () => {
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "line",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({
              id: "line",
              label: "LINE",
              config: {
                listAccountIds: () => ["default", "work"],
                defaultAccountId: () => "work",
                resolveAccount: (_cfg, accountId) => ({ accountId: accountId ?? "work" }),
              },
            }),
            bindings: {
              resolveCommandConversation: ({
                originatingTo,
                commandTo,
                fallbackTo,
              }: {
                originatingTo?: string;
                commandTo?: string;
                fallbackTo?: string;
              }) => {
                const rawTarget = [originatingTo, commandTo, fallbackTo].find(Boolean)?.trim();
                if (!rawTarget) {
                  return null;
                }
                return {
                  conversationId: rawTarget.replace(/^line:/i, "").replace(/^user:/i, ""),
                };
              },
            },
          },
        },
      ]),
    );

    let receivedCtx: Parameters<CommandHandler>[0] | undefined;
    const handler: CommandHandler = async (ctx) => {
      receivedCtx = ctx;
      return { text: "ok" };
    };

    const result = await executeCommand({
      command: {
        name: "accountcheck",
        handler,
      },
      channel: "line",
      senderId: "U123",
      from: "line:user:U1234567890abcdef1234567890abcdef",
    });

    expect(result).toEqual({ text: "ok" });
    expect(receivedCtx?.accountId).toBe("work");
  });
});
