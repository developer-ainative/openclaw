import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withEnv } from "../test-utils/env.js";
import { clearPluginRegistryLoadCache, loadOpenClawPlugins } from "./loader.js";
import { resetPluginLoaderTestStateForTest } from "./loader.test-fixtures.js";
import { fingerprintPluginRuntimeArtifact } from "./plugin-runtime-artifact-identity.js";
import {
  clearPluginRuntimeArtifactResolutionMemo,
  resolvePluginRuntimeArtifact,
} from "./plugin-runtime-artifact-resolution.js";
import { resolvePluginRuntimeExecutionArtifact } from "./plugin-runtime-artifact-selection.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getActivePluginChannelRegistry } from "./runtime.js";
import { withPluginRuntimeRegistryScope } from "./runtime/gateway-request-scope.js";
import { setPluginRuntimeLoadContext } from "./runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "./runtime/load-context.resolve.js";

const tempDirs: string[] = [];

const fixtureConfig = { plugins: { allow: ["fixture"], entries: { fixture: { enabled: true } } } };

function write(file: string, content: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function createBundledPluginFixture(builtExtension = ".js") {
  const packageRoot = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-artifact-")),
  );
  tempDirs.push(packageRoot);
  const rootDir = path.join(packageRoot, "extensions", "fixture");
  const source = path.join(rootDir, "index.ts");
  const builtSource = path.join(packageRoot, "dist/extensions/fixture", `index${builtExtension}`);
  write(source, "export default { register() {} };\n");
  write(builtSource, 'module.exports = { id: "fixture", register() {} };\n');
  write(
    path.join(path.dirname(builtSource), "package.json"),
    JSON.stringify({
      openclaw: { extensions: [`./index${builtExtension}`], build: { runtimeFormat: "cjs" } },
    }),
  );
  write(
    path.join(rootDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "fixture",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  return {
    rootDir: fs.realpathSync(rootDir),
    source: fs.realpathSync(source),
    builtSource: fs.realpathSync(builtSource),
    withEnv<T>(run: () => T, extra: Record<string, string | undefined> = {}) {
      return withEnv(
        {
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.dirname(rootDir),
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: "1",
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          ...extra,
        },
        run,
      );
    },
  };
}

function resolveFixture(
  params: Omit<
    Parameters<typeof resolvePluginRuntimeArtifact>[0],
    "pluginId" | "entryKind" | "origin"
  > &
    Partial<Pick<Parameters<typeof resolvePluginRuntimeArtifact>[0], "entryKind" | "origin">>,
) {
  return resolvePluginRuntimeArtifact({
    pluginId: "fixture",
    entryKind: "runtime",
    origin: "bundled",
    ...params,
  });
}

function loadFixture(options: Partial<Parameters<typeof loadOpenClawPlugins>[0]> = {}) {
  return loadOpenClawPlugins({
    cache: false,
    config: fixtureConfig,
    onlyPluginIds: ["fixture"],
    ...options,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  resetPluginLoaderTestStateForTest();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolvePluginRuntimeArtifact", () => {
  it.each(["disabled", "metadata-only"])(
    "does not inspect built runtime files for %s plugins",
    (mode) => {
      const fixture = createBundledPluginFixture();
      const open = vi.spyOn(fs, "openSync");
      const registry = fixture.withEnv(() =>
        loadFixture({
          config: {
            plugins: {
              allow: ["fixture"],
              entries: { fixture: { enabled: mode !== "disabled" } },
            },
          },
          loadModules: mode !== "metadata-only",
          preferBuiltPluginArtifacts: true,
        }),
      );
      expect(registry.plugins).toMatchObject([{ id: "fixture", enabled: mode !== "disabled" }]);
      const builtRoot = path.dirname(fixture.builtSource);
      expect(
        open.mock.calls.filter(
          ([file]) => typeof file === "string" && file.startsWith(`${builtRoot}${path.sep}`),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    { layout: "source default", preferBuiltPluginArtifacts: undefined },
    { layout: "package-local", preferBuiltPluginArtifacts: true },
    { layout: "root-bundled", preferBuiltPluginArtifacts: true },
  ])(
    "exposes and fingerprints the selected $layout runtime entry",
    ({ layout, preferBuiltPluginArtifacts }) => {
      const fixture = createBundledPluginFixture();
      const entry = !preferBuiltPluginArtifacts
        ? fixture.source
        : layout === "package-local"
          ? path.join(fixture.rootDir, "dist", "index.js")
          : fixture.builtSource;
      const name = preferBuiltPluginArtifacts ? "fixture-built" : "fixture-source";
      write(
        entry,
        `export default {
          id: "fixture", name: ${JSON.stringify(name)},
          register(api) {
            api.registerService({ id: api.runtimeSource ?? "missing runtime source", start() {} });
          }
        };`,
      );
      fixture.withEnv(() => {
        const record = { pluginId: "fixture", origin: "bundled" as const, ...fixture };
        const stagingRegistry = createEmptyPluginRegistry();
        setPluginRuntimeLoadContext(
          stagingRegistry,
          resolvePluginRuntimeLoadContext({ config: fixtureConfig, preferBuiltPluginArtifacts }),
        );
        const before = withPluginRuntimeRegistryScope(stagingRegistry, () =>
          fingerprintPluginRuntimeArtifact(record),
        );
        const registry = loadFixture({ preferBuiltPluginArtifacts });
        expect(registry.services.map(({ service }) => service.id)).toEqual([entry]);
        expect(registry.plugins[0]?.source).toBe(fixture.source);
        expect(registry.plugins).toContainEqual(
          expect.objectContaining({ id: "fixture", name, status: "loaded" }),
        );
        expect(fingerprintPluginRuntimeArtifact(record)).toBe(before);
        fs.appendFileSync(entry, "\n// Runtime artifact replaced.\n");
        expect(fingerprintPluginRuntimeArtifact(record)).not.toBe(before);
      });
    },
  );

  it.each(["missing", "present", "staging-symlink", "canonical-directory-symlink"])(
    "keeps the execution entry and boundary together for a %s canonical entry",
    (layout) => {
      const fixture = createBundledPluginFixture();
      const packageRoot = path.dirname(path.dirname(fixture.rootDir));
      const stagingRoot = path.join(packageRoot, "dist-runtime", "extensions", "fixture");
      const stagingSource = path.join(stagingRoot, "setup-entry.js");
      const builtRoot = path.dirname(fixture.builtSource);
      const builtSource = path.join(builtRoot, "setup-entry.js");
      if (layout === "canonical-directory-symlink") {
        const outputRoot = path.join(packageRoot, "outputs");
        fs.renameSync(builtRoot, outputRoot);
        fs.symlinkSync(outputRoot, builtRoot, "junction");
      }
      fs.mkdirSync(stagingRoot, { recursive: true });
      const canonicalEntryExists = layout !== "missing";
      if (canonicalEntryExists) {
        fs.writeFileSync(builtSource, "module.exports = {};\n");
      }
      if (layout === "staging-symlink" || layout === "canonical-directory-symlink") {
        fs.symlinkSync(builtSource, stagingSource);
      } else {
        fs.writeFileSync(stagingSource, "module.exports = {};\n");
      }
      const selected = { source: stagingSource, rootDir: stagingRoot };
      const expected = canonicalEntryExists
        ? { source: fs.realpathSync(builtSource), rootDir: builtRoot }
        : selected;

      expect(
        resolvePluginRuntimeExecutionArtifact({
          ...selected,
          source: fs.realpathSync(stagingSource),
        }),
      ).toEqual(expected);
      expect(
        resolvePluginRuntimeArtifact({
          ...selected,
          pluginId: "fixture",
          entryKind: "setup",
          origin: "bundled",
          preferBuiltPluginArtifacts: false,
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    { extension: ".cjs", neighbor: "built", missing: false },
    { extension: ".js", neighbor: "built", missing: false },
    { extension: ".cjs", neighbor: "built", missing: true },
    { extension: ".js", neighbor: "source", missing: false },
    { extension: ".js", neighbor: "package-local", missing: false },
  ])(
    "selects declared $extension output over a stale $neighbor neighbor (missing: $missing)",
    ({ extension, neighbor, missing }) => {
      const fixture = createBundledPluginFixture(extension);
      const staleExtension = extension === ".js" ? ".cjs" : ".js";
      const stale =
        neighbor === "built"
          ? path.join(path.dirname(fixture.builtSource), `index${staleExtension}`)
          : path.join(fixture.rootDir, neighbor === "source" ? "index.js" : "dist/index.js");
      fs.mkdirSync(path.dirname(stale), { recursive: true });
      fs.writeFileSync(stale, 'throw new Error("stale build output");\n');
      if (missing) {
        fs.rmSync(fixture.builtSource);
      }
      const resolved = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: true,
        packageManifest:
          neighbor === "package-local" ? { build: { bundledDist: false } } : undefined,
      });
      expect(resolved.source).toBe(missing ? fixture.source : fixture.builtSource);
      expect(resolved.source).not.toBe(fs.realpathSync(stale));
    },
  );

  it("never borrows a checkout root build for an installed package", () => {
    const fixture = createBundledPluginFixture();
    expect(
      resolveFixture({
        ...fixture,
        origin: "global",
        preferBuiltPluginArtifacts: true,
      }).source,
    ).toBe(fixture.source);
  });

  it("pins the first built path so one plugin instance registers once", () => {
    const fixture = createBundledPluginFixture();
    const first = resolveFixture({ ...fixture, preferBuiltPluginArtifacts: true });
    const second = resolveFixture({ ...fixture, preferBuiltPluginArtifacts: false });

    expect(first.source).toBe(fixture.builtSource);
    expect(second).toEqual(first);
    expect(
      resolveFixture({ ...fixture, source: fixture.source, preferBuiltPluginArtifacts: false }),
    ).toEqual(first);
  });

  it.each([
    { entryKind: "runtime" as const, sourceName: "index.ts", artifactName: "index.js" },
    {
      entryKind: "setup" as const,
      sourceName: "setup-entry.ts",
      artifactName: "setup-entry.js",
    },
    {
      entryKind: "provider-discovery" as const,
      sourceName: "provider-discovery.ts",
      artifactName: "provider-discovery.js",
    },
  ])(
    "keeps source-external $entryKind entries inside their selected root after packaging",
    ({ entryKind, sourceName, artifactName }) => {
      const fixture = createBundledPluginFixture();
      const packageRoot = path.dirname(path.dirname(fixture.rootDir));
      const source = path.join(fixture.rootDir, sourceName);
      if (source !== fixture.source) {
        fs.writeFileSync(source, "export default { register() {} };\n");
      }
      const stagingSource = path.join(
        packageRoot,
        "dist-runtime",
        "extensions",
        "fixture",
        artifactName,
      );
      write(stagingSource, `export * from "../../../dist/extensions/fixture/${artifactName}";\n`);
      fs.rmSync(path.dirname(fixture.builtSource), { recursive: true });
      const packagedSource = path.join(
        packageRoot,
        "dist",
        "extensions",
        "fixture",
        "dist",
        artifactName,
      );
      write(packagedSource, 'module.exports = { id: "packed" };\n');
      write(
        path.join(packageRoot, "dist", "extensions", "fixture", "package.json"),
        JSON.stringify({
          openclaw: { extensions: ["./index.ts"], runtimeExtensions: ["./dist/index.js"] },
        }),
      );

      const resolved = resolveFixture({
        entryKind,
        rootDir: fixture.rootDir,
        source,
        preferBuiltPluginArtifacts: true,
        packageManifest: { build: { bundledDist: false } },
      });

      expect(resolved).toEqual({ source: fs.realpathSync(source), rootDir: fixture.rootDir });
    },
  );

  it.each(["setup", "provider-discovery"] as const)(
    "keeps runtime and %s entries distinct within one plugin root",
    (entryKind) => {
      const fixture = createBundledPluginFixture();
      const setupSource = path.join(fixture.rootDir, "setup-entry.ts");
      fs.writeFileSync(setupSource, "export default { register() {} };\n");
      const runtime = resolveFixture({
        ...fixture,
        preferBuiltPluginArtifacts: false,
      });
      const setup = resolveFixture({
        entryKind,
        rootDir: fixture.rootDir,
        source: fs.realpathSync(setupSource),
        preferBuiltPluginArtifacts: false,
      });

      expect(runtime.source).toBe(fixture.source);
      expect(setup.source).toBe(fs.realpathSync(setupSource));
    },
  );

  it("re-resolves after the registry load cache is cleared", () => {
    const fixture = createBundledPluginFixture();
    const sourceResolution = resolveFixture({ ...fixture, preferBuiltPluginArtifacts: false });

    clearPluginRegistryLoadCache();

    const builtResolution = resolveFixture({ ...fixture, preferBuiltPluginArtifacts: true });
    expect(sourceResolution.source).toBe(fixture.source);
    expect(builtResolution.source).toBe(fixture.builtSource);
  });

  it("resolves replacement artifacts independently while pinned consumers keep their registry", () => {
    const fixture = createBundledPluginFixture();
    const [first, second] = fixture.withEnv(() => [
      loadFixture({ preferBuiltPluginArtifacts: false }),
      loadFixture({ preferBuiltPluginArtifacts: true }),
    ]);

    expect([...first.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.source,
    ]);
    expect([...second.pluginRuntimeArtifacts.values()].map((entry) => entry.source)).toEqual([
      fixture.builtSource,
    ]);
    expect(getActivePluginChannelRegistry()).toBe(second);
  });

  it("binds explicit bundled source selection before a built-preferred runtime loads", async () => {
    const { captureSystemAgentOwnerPluginArtifacts } =
      await import("../system-agent/verified-inference.js");
    const fixture = createBundledPluginFixture();
    const packageRoot = path.dirname(path.dirname(fixture.rootDir));
    fs.writeFileSync(fixture.source, 'export default { name: "fixture-source", register() {} };\n');
    fs.writeFileSync(
      fixture.builtSource,
      'module.exports = { name: "fixture-built", register() {} };\n',
    );
    fs.writeFileSync(
      path.join(fixture.rootDir, "openclaw.plugin.json"),
      JSON.stringify({
        id: "fixture",
        providers: ["fixture"],
        configSchema: { type: "object", additionalProperties: false, properties: {} },
      }),
    );
    fixture.withEnv(
      () => {
        const workspaceDir = path.join(packageRoot, "workspace");
        const config: OpenClawConfig = {
          agents: {
            defaults: { workspace: workspaceDir },
            entries: { main: {} },
          },
          plugins: {
            allow: ["fixture"],
            entries: { fixture: { enabled: true } },
            load: { paths: [fixture.rootDir] },
          },
        };
        const capture = () =>
          captureSystemAgentOwnerPluginArtifacts({
            config,
            executionRoute: {
              sourceConfig: config,
              runConfig: config,
              modelLabel: "fixture/model",
              provider: "fixture",
              model: "model",
              agentDir: path.join(packageRoot, "agent"),
              agentId: "main",
              runner: "embedded",
              agentHarnessRuntimeOverride: "openclaw",
            },
          });
        const stagingRegistry = createEmptyPluginRegistry();
        setPluginRuntimeLoadContext(
          stagingRegistry,
          resolvePluginRuntimeLoadContext({ config, preferBuiltPluginArtifacts: true }),
        );
        const before = withPluginRuntimeRegistryScope(stagingRegistry, capture);
        expect(before.ownerPluginIds).toEqual(["fixture"]);
        const registry = loadFixture({ config, preferBuiltPluginArtifacts: true });
        expect(registry.plugins).toContainEqual(
          expect.objectContaining({ id: "fixture", name: "fixture-source", status: "loaded" }),
        );
        expect(capture()).toEqual(before);
        fs.appendFileSync(fixture.source, "\n// Runtime artifact replaced.\n");
        expect(capture()).not.toEqual(before);
      },
      { OPENCLAW_STATE_DIR: path.join(packageRoot, "state") },
    );
  });

  it("leaves dist-only installs unchanged because both preferences resolve the built entry", () => {
    const packageRoot = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-runtime-dist-only-")),
    );
    tempDirs.push(packageRoot);
    const rootDir = path.join(packageRoot, "dist", "extensions", "fixture");
    const source = path.join(rootDir, "index.js");
    fs.mkdirSync(rootDir, { recursive: true });
    fs.writeFileSync(source, "export default { register() {} };\n");
    const canonicalRootDir = fs.realpathSync(rootDir);
    const canonicalSource = fs.realpathSync(source);

    const sourcePreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: false,
    });
    clearPluginRuntimeArtifactResolutionMemo();
    const builtPreferred = resolveFixture({
      rootDir: canonicalRootDir,
      source: canonicalSource,
      preferBuiltPluginArtifacts: true,
    });

    expect(sourcePreferred).toEqual({ source: canonicalSource, rootDir: canonicalRootDir });
    expect(builtPreferred).toEqual(sourcePreferred);
  });
});
