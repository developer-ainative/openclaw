import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerWebhooksCli } from "./webhooks-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    runGmailSetup: vi.fn(),
    runGmailService: vi.fn(),
  };
});

vi.mock("../hooks/gmail-ops.js", () => ({
  runGmailSetup: mocks.runGmailSetup,
  runGmailService: mocks.runGmailService,
}));

vi.mock("../runtime.js", () => ({
  defaultRuntime: mocks.defaultRuntime,
}));

function createProgram() {
  const program = new Command();
  program.exitOverride();
  registerWebhooksCli(program);
  return program;
}

function runtimeErrors(): string[] {
  return mocks.defaultRuntime.error.mock.calls.map(([message]) => String(message));
}

function parse(command: string, args: string[] = []) {
  return createProgram().parseAsync(["webhooks", "gmail", command, ...args], { from: "user" });
}

function expectNoRuntimeOutput() {
  expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
  expect(mocks.defaultRuntime.error).not.toHaveBeenCalled();
  expect(mocks.defaultRuntime.exit).not.toHaveBeenCalled();
}

describe("webhooks cli", () => {
  beforeEach(() => {
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    vi.clearAllMocks();
  });

  it.each([
    ["setup", "--port", "8080x", true],
    ["run", "--max-bytes", "10mb"],
    ["run", "--renew-minutes", "30m"],
  ])("rejects partial gmail %s %s", async (command, flag, value, json = false) => {
    const args = command === "setup" ? ["--account", "default", flag, value] : [flag, value];
    if (json) {
      args.push("--json");
    }

    if (json) {
      await expect(parse(command, args)).rejects.toThrow(`${flag} must be a positive integer.`);
      expectNoRuntimeOutput();
    } else {
      await expect(parse(command, args)).rejects.toThrow("__exit__:1");
      expect(runtimeErrors().join("\n")).toContain(`${flag} must be a positive integer.`);
    }
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });

  it.each([
    { command: "setup", mode: "human", json: false },
    { command: "setup", mode: "JSON", json: true },
    { command: "run", mode: "human", json: false },
  ])("renders named gmail $command errors safely in $mode mode", async ({ command, json }) => {
    const secret = "sk-abcdefghijklmnopqrstuv";
    const error = new Error(`Gmail failed: Authorization: Bearer ${secret}`);
    error.name = "GmailCredentialError";
    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    runner.mockRejectedValueOnce(error);
    const args = command === "setup" ? ["--account", "default"] : [];
    if (json) {
      args.push("--json");
    }

    if (json) {
      await expect(parse(command, args)).rejects.toThrow("Gmail failed: Authorization: Bearer");
      expectNoRuntimeOutput();
    } else {
      await expect(parse(command, args)).rejects.toThrow("__exit__:1");
      expect(runtimeErrors()).toEqual([
        expect.stringContaining("Gmail failed: Authorization: Bearer"),
      ]);
      expect(mocks.defaultRuntime.writeJson).not.toHaveBeenCalled();
      expect(mocks.defaultRuntime.exit).toHaveBeenCalledWith(1);
    }
    expect(runner).toHaveBeenCalledOnce();
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(error.name);
    expect([...mocks.runtimeLogs, ...runtimeErrors()].join("\n")).not.toContain(secret);
  });

  it.each([
    ["setup", ""],
    ["run", "offf"],
  ])("rejects invalid gmail %s --tailscale mode %j", async (command, mode) => {
    const args =
      command === "setup" ? ["--account", "default", "--tailscale", mode] : ["--tailscale", mode];

    await expect(parse(command, args)).rejects.toThrow("__exit__:1");

    expect(runtimeErrors().join("\n")).toContain(
      "Invalid --tailscale (must be funnel, serve, or off).",
    );
    expect(mocks.runGmailSetup).not.toHaveBeenCalled();
    expect(mocks.runGmailService).not.toHaveBeenCalled();
  });

  it("accepts an explicitly disabled Gmail exposure mode", async () => {
    await parse("run", ["--tailscale", "off"]);

    expect(mocks.runGmailService).toHaveBeenCalledWith(
      expect.objectContaining({ tailscale: "off" }),
    );
  });

  // Inputs and expected normalized values are independent; defaults/omissions share only keys.
  const commonOptions: [string, string, string | undefined, string | number | boolean][] = [
    ["--topic", "topic", " projects/fixture/topics/custom ", "projects/fixture/topics/custom"],
    ["--subscription", "subscription", " custom-subscription ", "custom-subscription"],
    ["--label", "label", " CUSTOM ", "CUSTOM"],
    [
      "--hook-url",
      "hookUrl",
      " https://fixture.invalid/hooks/gmail ",
      "https://fixture.invalid/hooks/gmail",
    ],
    ["--hook-token", "hookToken", " fixture-hook ", "fixture-hook"],
    ["--push-token", "pushToken", " fixture-push ", "fixture-push"],
    ["--bind", "bind", " 127.0.0.2 ", "127.0.0.2"],
    ["--port", "port", "9807", 9807],
    ["--path", "path", " /custom-push ", "/custom-push"],
    ["--include-body", "includeBody", undefined, true],
    ["--max-bytes", "maxBytes", "54321", 54321],
    ["--renew-minutes", "renewEveryMinutes", "29", 29],
    ["--tailscale", "tailscale", " serve ", "serve"],
    ["--tailscale-path", "tailscalePath", " /public-gmail ", "/public-gmail"],
    ["--tailscale-target", "tailscaleTarget", " http://127.0.0.3:8789 ", "http://127.0.0.3:8789"],
  ];
  const explicitCommonArgs = commonOptions.flatMap(([flag, , value]) =>
    value === undefined ? [flag] : [flag, value],
  );
  const explicitCommonOptions = Object.fromEntries(
    commonOptions.map(([, key, , value]) => [key, value]),
  );
  const omittedCommonOptions = Object.fromEntries(commonOptions.map(([, key]) => [key, undefined]));

  it.each([
    {
      name: "setup defaults",
      command: "setup",
      args: ["--account", "fixture@example.invalid"],
      expected: {
        ...omittedCommonOptions,
        account: "fixture@example.invalid",
        project: undefined,
        topic: "gog-gmail-watch",
        subscription: "gog-gmail-watch-push",
        label: "INBOX",
        bind: "127.0.0.1",
        port: 8788,
        path: "/gmail-pubsub",
        includeBody: true,
        maxBytes: 20_000,
        renewEveryMinutes: 720,
        tailscale: "funnel",
        pushEndpoint: undefined,
        json: false,
      },
    },
    {
      name: "run omissions",
      command: "run",
      args: [],
      expected: { account: undefined, ...omittedCommonOptions },
    },
    {
      name: "setup explicit options",
      command: "setup",
      args: [
        "--account",
        " fixture@example.invalid ",
        "--project",
        " fixture-project ",
        "--push-endpoint",
        " https://fixture.invalid/push ",
        "--json",
        ...explicitCommonArgs,
      ],
      expected: {
        account: "fixture@example.invalid",
        project: "fixture-project",
        ...explicitCommonOptions,
        pushEndpoint: "https://fixture.invalid/push",
        json: true,
      },
    },
    {
      name: "run explicit options",
      command: "run",
      args: ["--account", " fixture@example.invalid ", ...explicitCommonArgs],
      expected: { account: "fixture@example.invalid", ...explicitCommonOptions },
    },
  ])("passes $name to the Gmail command owner", async ({ command, args, expected }) => {
    await parse(command, args);

    const runner = command === "setup" ? mocks.runGmailSetup : mocks.runGmailService;
    expect(runner).toHaveBeenCalledOnce();
    const actual = runner.mock.calls[0]?.[0];
    expect(actual).toStrictEqual(expected);
  });
});
