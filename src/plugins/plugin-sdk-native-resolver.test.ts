import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import {
  installOpenClawInternalCorePackageNativeResolver,
  installOpenClawPluginSdkNativeResolver,
} from "./plugin-sdk-native-resolver.js";

type NativeEsmLazyImportProbe = {
  status: number | null;
  stderr: string;
  stdout: string;
};
let nativeEsmLazyImportProbe: NativeEsmLazyImportProbe;

function writeJsonFile(targetPath: string, value: unknown): void {
  writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(targetPath: string, content = "export default {};\n") {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
  return targetPath;
}

function writeFakeOpenClawPackage(root: string): { distRoot: string; loaderModulePath: string } {
  writeJsonFile(path.join(root, "package.json"), {
    name: "openclaw",
    type: "module",
    bin: { openclaw: "./openclaw.mjs" },
    exports: {
      "./cli-entry": "./dist/cli-entry.js",
      "./plugin-sdk/agent-runtime": "./dist/plugin-sdk/agent-runtime.js",
      "./plugin-sdk/channel-inbound": "./dist/plugin-sdk/channel-inbound.js",
      "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",
      "./plugin-sdk/source-only": "./dist/plugin-sdk/source-only.js",
    },
  });
  writeFile(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\n");
  const distRoot = path.join(root, "dist");
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  for (const [file, content] of Object.entries({
    "agent-runtime": "export const agentRuntimeSource = import.meta.url;\n",
    "channel-inbound": 'export * from "./channel-outbound.js";\n',
    "channel-outbound": 'export const defineChannelMessageAdapter = () => "adapter";\n',
  })) {
    writeFile(path.join(pluginSdkDir, `${file}.js`), content);
  }
  const loaderModulePath = writeFile(path.join(distRoot, "plugins", "loader.js"));
  return { distRoot, loaderModulePath };
}

function writeExternalPluginEntry(root: string): string {
  writeJsonFile(path.join(root, "package.json"), {
    name: "external-plugin",
    type: "module",
  });
  return writeFile(path.join(root, "dist", "runtime-api.js"));
}

function writeInternalCorePackageSource(
  root: string,
  packageDir: string,
  sourceFile: string,
): string {
  return writeFile(path.join(root, "packages", packageDir, "src", sourceFile), "export {};\n");
}

function writeInternalCorePackageExports(
  root: string,
  packageDir: string,
  subpaths: readonly string[],
): void {
  writeJsonFile(path.join(root, "packages", packageDir, "package.json"), {
    name: `@openclaw/${packageDir}`,
    exports: Object.fromEntries(
      subpaths.map((subpath) => {
        const exportKey = subpath ? `./${subpath}` : ".";
        const distFile = `./dist/${subpath || "index"}.mjs`;
        return [exportKey, { import: distFile, default: distFile }];
      }),
    ),
  });
}

function addFakePluginSdkDistExport(root: string, subpath: string): string {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
    exports: Record<string, string>;
  };
  const distPath = path.join(root, "dist", "plugin-sdk", `${subpath}.js`);
  packageJson.exports[`./plugin-sdk/${subpath}`] = `./dist/plugin-sdk/${subpath}.js`;
  writeJsonFile(packageJsonPath, packageJson);
  fs.writeFileSync(distPath, `export const ${subpath.replaceAll("-", "_")} = true;\n`, "utf8");
  return distPath;
}

function createInternalCoreAliasFixture(prefix: string) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  const { loaderModulePath } = writeFakeOpenClawPackage(root);
  const sourcePath = writeInternalCorePackageSource(root, "markdown-core", "code-spans.ts");
  const coreSourceParent = writeFile(path.join(root, "src", "host-probe.js"));
  return {
    coreSourceParent,
    loaderModulePath,
    moduleUrl: pathToFileURL(loaderModulePath).href,
    root,
    sourcePath,
  };
}

function sdkFixture(
  prefix = "openclaw-sdk-native-",
  root = fs.mkdtempSync(path.join(os.tmpdir(), prefix)),
) {
  const host = writeFakeOpenClawPackage(root);
  const externalPluginEntry = writeExternalPluginEntry(path.join(root, "external-plugin"));
  return {
    ...host,
    root,
    externalPluginEntry,
    requireFromPlugin: createRequire(externalPluginEntry),
    options: { modulePath: host.loaderModulePath, pluginModulePath: externalPluginEntry },
  };
}

function devFixture() {
  const stable = sdkFixture("openclaw-sdk-native-stable-");
  const devRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-dev-source-"));
  writeFakeOpenClawPackage(devRoot);
  fs.mkdirSync(path.join(devRoot, "src"), { recursive: true });
  fs.mkdirSync(path.join(devRoot, "extensions"), { recursive: true });
  return { ...stable, devRoot };
}

function expectResolved(parent: string, specifier: string, target: string) {
  expect(fs.realpathSync(createRequire(parent).resolve(specifier))).toBe(fs.realpathSync(target));
}

describe("installOpenClawInternalCorePackageNativeResolver", () => {
  it("keeps internal core alias registration isolated between host modules", () => {
    const first = createInternalCoreAliasFixture("openclaw-sdk-native-core-host-a-");
    const second = createInternalCoreAliasFixture("openclaw-sdk-native-core-host-b-");
    const existsSync = vi.spyOn(fs, "existsSync");

    try {
      installOpenClawInternalCorePackageNativeResolver({ moduleUrl: first.moduleUrl });
      existsSync.mockClear();

      installOpenClawInternalCorePackageNativeResolver({ moduleUrl: second.moduleUrl });

      expect(existsSync).toHaveBeenCalledWith(second.sourcePath);
      expectResolved(
        first.coreSourceParent,
        "@openclaw/markdown-core/code-spans",
        first.sourcePath,
      );
      expectResolved(
        second.coreSourceParent,
        "@openclaw/markdown-core/code-spans",
        second.sourcePath,
      );
    } finally {
      existsSync.mockRestore();
    }
  });

  it("rescans internal core aliases after plugin metadata lifecycle invalidation", () => {
    const fixture = createInternalCoreAliasFixture("openclaw-sdk-native-core-invalidation-");
    const existsSync = vi.spyOn(fs, "existsSync");

    try {
      installOpenClawInternalCorePackageNativeResolver({ moduleUrl: fixture.moduleUrl });
      existsSync.mockClear();

      installOpenClawInternalCorePackageNativeResolver({ moduleUrl: fixture.moduleUrl });
      expect(existsSync).not.toHaveBeenCalled();

      clearPluginMetadataLifecycleCaches();
      existsSync.mockClear();
      installOpenClawInternalCorePackageNativeResolver({ moduleUrl: fixture.moduleUrl });

      expect(existsSync).toHaveBeenCalledWith(fixture.sourcePath);
    } finally {
      existsSync.mockRestore();
    }
  });
});

describe("installOpenClawPluginSdkNativeResolver", () => {
  it("resolves installed plugin SDK imports to the dev source root", () => {
    const { options, externalPluginEntry, devRoot } = devFixture();
    const previousDevSourceRoot = process.env.OPENCLAW_DEV_SOURCE_ROOT;
    process.env.OPENCLAW_DEV_SOURCE_ROOT = devRoot;

    try {
      installOpenClawPluginSdkNativeResolver(options);
      expectResolved(
        externalPluginEntry,
        "openclaw/plugin-sdk/agent-runtime",
        path.join(devRoot, "dist/plugin-sdk/agent-runtime.js"),
      );
    } finally {
      if (previousDevSourceRoot === undefined) {
        delete process.env.OPENCLAW_DEV_SOURCE_ROOT;
      } else {
        process.env.OPENCLAW_DEV_SOURCE_ROOT = previousDevSourceRoot;
      }
    }
  });

  it("updates native SDK aliases when the same plugin parent switches dev source roots", () => {
    const { root, options, externalPluginEntry, devRoot } = devFixture();
    installOpenClawPluginSdkNativeResolver(options);
    expectResolved(
      externalPluginEntry,
      "openclaw/plugin-sdk/agent-runtime",
      path.join(root, "dist/plugin-sdk/agent-runtime.js"),
    );
    installOpenClawPluginSdkNativeResolver({ ...options, devSourceRoot: devRoot });
    expectResolved(
      externalPluginEntry,
      "openclaw/plugin-sdk/agent-runtime",
      path.join(devRoot, "dist/plugin-sdk/agent-runtime.js"),
    );
  });

  it("removes stale native SDK aliases when a later dev root omits a subpath", () => {
    const { root, options, externalPluginEntry, requireFromPlugin, devRoot } = devFixture();
    const stableExtraPath = addFakePluginSdkDistExport(root, "stable-extra");
    installOpenClawPluginSdkNativeResolver(options);
    expectResolved(externalPluginEntry, "openclaw/plugin-sdk/stable-extra", stableExtraPath);
    installOpenClawPluginSdkNativeResolver({ ...options, devSourceRoot: devRoot });

    expect(() => requireFromPlugin.resolve("openclaw/plugin-sdk/stable-extra")).toThrow();
  });

  it("keeps overlapping parent precedence across first demand and reinstallation", () => {
    const broadHost = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-broad-host-"));
    const narrowHost = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-narrow-host-"));
    const broad = writeFakeOpenClawPackage(broadHost);
    const narrow = writeFakeOpenClawPackage(narrowHost);
    const broadEntry = writeExternalPluginEntry(path.join(broadHost, "external-plugin"));
    const narrowEntry = writeExternalPluginEntry(path.join(broadHost, "external-plugin", "nested"));
    const narrowOptions = {
      modulePath: narrow.loaderModulePath,
      pluginModulePath: narrowEntry,
      devSourceRoot: narrowHost,
    };
    const broadOptions = {
      modulePath: broad.loaderModulePath,
      pluginModulePath: broadEntry,
      devSourceRoot: broadHost,
    };
    installOpenClawPluginSdkNativeResolver(narrowOptions);
    installOpenClawPluginSdkNativeResolver(broadOptions);
    const fromBroad = createRequire(broadEntry);
    const fromNarrow = createRequire(narrowEntry);
    const expected = (host: string, subpath: string) =>
      fs.realpathSync(path.join(host, "dist", "plugin-sdk", `${subpath}.js`));

    // A demand outside the nested root gives the broad host precedence even
    // though it was installed second; the later path was not demanded yet.
    expect(fs.realpathSync(fromBroad.resolve("openclaw/plugin-sdk/agent-runtime"))).toBe(
      expected(broadHost, "agent-runtime"),
    );
    expect(fs.realpathSync(fromNarrow.resolve("openclaw/plugin-sdk/channel-outbound.js"))).toBe(
      expected(broadHost, "channel-outbound"),
    );

    installOpenClawPluginSdkNativeResolver(broadOptions);
    expect(fs.realpathSync(fromNarrow.resolve("openclaw/plugin-sdk/channel-inbound"))).toBe(
      expected(narrowHost, "channel-inbound"),
    );
    expect(fs.realpathSync(fromBroad.resolve("openclaw/plugin-sdk/channel-inbound"))).toBe(
      expected(broadHost, "channel-inbound"),
    );
  });

  it("honors the selected source SDK for native imports", () => {
    const { root, options, externalPluginEntry } = sdkFixture();
    const source = writeFile(
      path.join(root, "src/plugin-sdk/channel-outbound.ts"),
      "export const sourceOnly = true;\n",
    );
    installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "src" });
    expectResolved(externalPluginEntry, "openclaw/plugin-sdk/channel-outbound", source);
  });

  it("lets built external plugins resolve OpenClaw SDK subpaths with createRequire", () => {
    const { root, distRoot, options, externalPluginEntry, requireFromPlugin } = sdkFixture();

    const distMode = fs.statSync(distRoot).mode;
    if (process.platform !== "win32") {
      fs.chmodSync(distRoot, 0o555);
    }

    try {
      installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "dist" });

      expect(fs.existsSync(path.join(distRoot, "extensions"))).toBe(false);
      expectResolved(
        externalPluginEntry,
        "openclaw/plugin-sdk/channel-outbound",
        path.join(root, "dist/plugin-sdk/channel-outbound.js"),
      );
      const sdk = requireFromPlugin("openclaw/plugin-sdk/channel-outbound") as {
        defineChannelMessageAdapter?: () => string;
      };

      expect(sdk.defineChannelMessageAdapter?.()).toBe("adapter");
      expect(() => requireFromPlugin.resolve("openclaw/not-plugin-sdk/channel-outbound")).toThrow();
    } finally {
      if (process.platform !== "win32") {
        fs.chmodSync(distRoot, distMode);
      }
    }
  });

  beforeAll(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-esm-resolver-"));
    const probePath = path.join(root, "probe.mjs");
    const resolverModuleUrl = pathToFileURL(
      path.join(process.cwd(), "src", "plugins", "plugin-sdk-native-resolver.ts"),
    ).href;
    fs.writeFileSync(
      probePath,
      [
        'import fs from "node:fs";',
        'import Module from "node:module";',
        'import path from "node:path";',
        'import { pathToFileURL } from "node:url";',
        `import { installOpenClawInternalCorePackageNativeResolver, installOpenClawPluginSdkNativeResolver } from ${JSON.stringify(resolverModuleUrl)};`,
        `const root = ${JSON.stringify(root)};`,
        "const writeJson = (targetPath, value) => {",
        "  fs.mkdirSync(path.dirname(targetPath), { recursive: true });",
        '  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\\n`, "utf8");',
        "};",
        'writeJson(path.join(root, "package.json"), {',
        '  name: "openclaw",',
        '  type: "module",',
        '  bin: { openclaw: "./openclaw.mjs" },',
        "  exports: {",
        '    "./plugin-sdk/channel-outbound": "./dist/plugin-sdk/channel-outbound.js",',
        '    "./plugin-sdk/late-entry": "./dist/plugin-sdk/late-entry.js",',
        '    "./plugin-sdk/process-runtime": "./dist/plugin-sdk/process-runtime.js",',
        "  },",
        "});",
        'fs.writeFileSync(path.join(root, "openclaw.mjs"), "#!/usr/bin/env node\\n", "utf8");',
        'fs.mkdirSync(path.join(root, "dist", "plugin-sdk"), { recursive: true });',
        'fs.writeFileSync(path.join(root, "dist", "plugin-sdk", "late-entry.js"), "export const late = \\"late-adapter\\";\\n", "utf8");',
        'fs.writeFileSync(path.join(root, "dist", "plugin-sdk", "channel-outbound.js"), "export const defineChannelMessageAdapter = () => \\"adapter\\";\\n", "utf8");',
        'const loaderModulePath = path.join(root, "dist", "plugins", "loader.js");',
        "fs.mkdirSync(path.dirname(loaderModulePath), { recursive: true });",
        'fs.writeFileSync(loaderModulePath, "export default {};\\n", "utf8");',
        // Internal alias scans are host snapshots; keep the alias-free host separate.
        'const aliasFreeRoot = path.join(root, "alias-free-host");',
        'writeJson(path.join(aliasFreeRoot, "package.json"), { name: "openclaw", type: "module" });',
        'const aliasFreeLoaderPath = path.join(aliasFreeRoot, "loader.js");',
        'fs.writeFileSync(aliasFreeLoaderPath, "export default {};\\n", "utf8");',
        "const originalResolver = Module._resolveFilename;",
        "installOpenClawInternalCorePackageNativeResolver({ moduleUrl: pathToFileURL(aliasFreeLoaderPath).href });",
        "installOpenClawPluginSdkNativeResolver({ modulePath: aliasFreeLoaderPath });",
        "const aliasFreeUnchanged = Module._resolveFilename === originalResolver;",
        'const aiToolSchemaPath = path.join(root, "packages", "ai", "src", "internal", "tool-schema.ts");',
        "fs.mkdirSync(path.dirname(aiToolSchemaPath), { recursive: true });",
        'fs.writeFileSync(aiToolSchemaPath, "export const schemaSource = import.meta.url;\\n", "utf8");',
        'const coreEntryPath = path.join(root, "src", "schema-probe.mjs");',
        "fs.mkdirSync(path.dirname(coreEntryPath), { recursive: true });",
        'fs.writeFileSync(coreEntryPath, \'export { schemaSource } from "@openclaw/ai/internal/tool-schema";\\n\', "utf8");',
        'writeJson(path.join(root, "packages", "worker-runtime", "package.json"), { name: "@openclaw/worker-runtime", type: "module", exports: { ".": { import: "./dist/index.mjs" }, "./worker": { import: "./dist/worker.mjs" }, "./lifecycle": { import: "./dist/lifecycle.mjs" } } });',
        'for (const entry of ["index", "worker", "lifecycle"]) {',
        '  const target = path.join(root, "packages", "worker-runtime", "src", `${entry}.ts`);',
        "  fs.mkdirSync(path.dirname(target), { recursive: true });",
        '  fs.writeFileSync(target, "export const source = import.meta.url;\\n", "utf8");',
        "}",
        'const processRuntimePath = path.join(root, "src", "plugin-sdk", "process-runtime.ts");',
        "fs.mkdirSync(path.dirname(processRuntimePath), { recursive: true });",
        'fs.writeFileSync(processRuntimePath, \'export { source as poolSource } from "@openclaw/worker-runtime"; export { source as workerSource } from "@openclaw/worker-runtime/worker"; export { source as lifecycleSource } from "@openclaw/worker-runtime/lifecycle";\\n\', "utf8");',
        'const pluginRoot = path.join(root, "external-plugin");',
        'writeJson(path.join(pluginRoot, "package.json"), { name: "external-plugin", type: "module" });',
        'const entryPath = path.join(pluginRoot, "dist", "runtime-api.js");',
        'const lazyPath = path.join(pluginRoot, "dist", "lazy.js");',
        "fs.mkdirSync(path.dirname(entryPath), { recursive: true });",
        "fs.writeFileSync(",
        "  entryPath,",
        '  "import { defineChannelMessageAdapter } from \\"openclaw/plugin-sdk/channel-outbound\\"; export * as workerRuntime from \\"openclaw/plugin-sdk/process-runtime\\"; export const eager = defineChannelMessageAdapter(); export const loadLazy = () => import(\\"./lazy.js\\");\\n",',
        '  "utf8",',
        ");",
        "fs.writeFileSync(",
        "  lazyPath,",
        '  "export { late as lazy } from \\"openclaw/plugin-sdk/late-entry.js\\";\\n",',
        '  "utf8",',
        ");",
        "installOpenClawPluginSdkNativeResolver({",
        "  modulePath: loaderModulePath,",
        "  pluginModulePath: entryPath,",
        '  pluginSdkResolution: "dist",',
        "});",
        "const module = await import(pathToFileURL(entryPath).href);",
        "const lazy = await module.loadLazy();",
        "const core = await import(pathToFileURL(coreEntryPath).href);",
        "const workerRuntime = module.workerRuntime;",
        'for (const [key, entry] of [["poolSource", "index"], ["workerSource", "worker"], ["lifecycleSource", "lifecycle"]]) {',
        '  if (workerRuntime[key] !== pathToFileURL(fs.realpathSync(path.join(root, "packages", "worker-runtime", "src", `${entry}.ts`))).href) {',
        '    throw new Error("Worker runtime alias did not resolve to host source");',
        "  }",
        "}",
        "if (core.schemaSource !== pathToFileURL(fs.realpathSync(aiToolSchemaPath)).href) {",
        '  throw new Error("Internal AI tool-schema alias did not resolve to host source");',
        "}",
        "console.log(JSON.stringify({ aliasFreeUnchanged, eager: module.eager, lazy: lazy.lazy }));",
        "",
      ].join("\n"),
      "utf8",
    );

    // Under Bun, tsx's Node hooks redirect SDK aliases before the native plugin can resolve them.
    const probeArgs = process.versions.bun ? [probePath] : ["--import", "tsx", probePath];
    const result = spawnSync(process.execPath, probeArgs, {
      cwd: process.cwd(),
      encoding: "utf8",
    });
    fs.rmSync(root, { recursive: true, force: true });
    nativeEsmLazyImportProbe = {
      status: result.status,
      stderr: result.stderr,
      stdout: result.stdout,
    };
  });

  it("keeps SDK and internal schema aliases available for native ESM lazy imports", () => {
    expect(nativeEsmLazyImportProbe.stderr).toBe("");
    expect(nativeEsmLazyImportProbe.status).toBe(0);
    expect(JSON.parse(nativeEsmLazyImportProbe.stdout)).toMatchObject({
      aliasFreeUnchanged: true,
      eager: "adapter",
      lazy: "late-adapter",
    });
  });

  it("does not resolve SDK aliases for parents outside registered plugin roots", () => {
    const { options, requireFromPlugin } = sdkFixture();
    const unrelatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-outside-"));
    const unrelatedEntry = writeFile(path.join(unrelatedRoot, "runtime-api.js"));
    installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "dist" });
    const requireFromOutside = createRequire(unrelatedEntry);
    expect(requireFromPlugin.resolve("openclaw/plugin-sdk/channel-outbound")).toBeTruthy();
    expect(() => requireFromOutside.resolve("openclaw/plugin-sdk/channel-outbound")).toThrow();
  });

  it("resolves internal core packages only for OpenClaw-owned source parents", () => {
    const { root, options, requireFromPlugin } = sdkFixture();
    const sources = (
      [
        ["normalization-core", "string-coerce.ts"],
        ["normalization-core", "boolean-coercion.ts"],
        ["normalization-core", "result.ts"],
        ["normalization-core", "agent-id.ts"],
        ["media-core", "mime.ts"],
        ["media-core", "attachment-classify.ts"],
        ["markdown-core", "code-spans.ts"],
        ["ai", "transports.ts"],
        ["ai", "internal/tool-schema.ts"],
        ["ai", "internal/runtime.ts"],
        ["ai", "internal/openai-responses-payload-policy.ts"],
        ["ai", "internal/google-model-family.ts"],
        ["ai", "internal/retry-after.ts"],
        ["acp-core", "runtime/types.ts"],
        ["llm-core", "index.ts"],
        ["llm-core", "model-contracts/anthropic.ts"],
      ] as const
    ).map(([packageDir, sourceFile]) => ({
      specifier: `@openclaw/${packageDir}${sourceFile === "index.ts" ? "" : `/${sourceFile.slice(0, -3)}`}`,
      sourcePath: writeInternalCorePackageSource(root, packageDir, sourceFile),
    }));
    writeInternalCorePackageExports(root, "normalization-core", [
      "agent-id",
      "boolean-coercion",
      "result",
      "string-coerce",
    ]);
    writeInternalCorePackageExports(root, "media-core", ["attachment-classify", "mime"]);
    writeInternalCorePackageExports(root, "acp-core", ["runtime/types"]);
    const coreSourceParent = writeFile(path.join(root, "src/config/plugin-web-search-config.ts"));
    installOpenClawPluginSdkNativeResolver({ ...options, pluginSdkResolution: "dist" });
    for (const { specifier, sourcePath } of sources) {
      expectResolved(coreSourceParent, specifier, sourcePath);
      expect(() => requireFromPlugin.resolve(specifier)).toThrow();
    }
  });

  it("scopes private SSRF SDK aliases to bundled local IPC native parents", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-sdk-native-ssrf-"));
    const { loaderModulePath } = writeFakeOpenClawPackage(root);
    const internalPath = path.join(root, "dist", "plugin-sdk", "ssrf-runtime-internal.js");
    fs.writeFileSync(internalPath, "export const ssrfInternal = true;\n", "utf8");
    const owners = (
      [
        ["dist", "ollama"],
        ["dist-runtime", "ollama"],
        ["dist", "browser"],
        ["dist-runtime", "browser"],
        ["dist", "demo"],
      ] as const
    ).map(([dist, plugin]) => {
      const entry = path.join(root, dist, "extensions", plugin, "index.js");
      fs.mkdirSync(path.dirname(entry), { recursive: true });
      fs.writeFileSync(entry, "export default {};\n", "utf8");
      return { entry, allowed: plugin !== "demo" };
    });
    for (const { entry } of owners) {
      installOpenClawPluginSdkNativeResolver({
        modulePath: loaderModulePath,
        pluginModulePath: entry,
        pluginSdkResolution: "dist",
      });
    }
    for (const { entry, allowed } of owners) {
      const resolve = () =>
        createRequire(entry).resolve("openclaw/plugin-sdk/ssrf-runtime-internal");
      if (allowed) {
        expect(fs.realpathSync(resolve())).toBe(fs.realpathSync(internalPath));
      } else {
        expect(resolve).toThrow();
      }
    }
  });
});
