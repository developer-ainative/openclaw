import fs from "node:fs";
import fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as notes from "../../packages/terminal-core/src/note.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { noteLegacyPluginSourceCaptures } from "../commands/doctor-plugin-source-captures.js";
import * as temporaryDirectories from "../commands/doctor/shared/temporary-directories.js";
import { acquireGatewayStateOwner } from "../infra/gateway-state-owner.js";
import * as census from "../infra/openclaw-process-census.js";
import * as sqliteDiagnostics from "../infra/sqlite-error-diagnostics.js";
import * as stagingToken from "../infra/sqlite-staging-token.js";
import { createOpenClawDatabaseMaintenanceScope } from "../state/openclaw-state-db-async-lifecycle.js";
import { closeOpenClawStateDatabaseAsync } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { makePluginMetadataIndex } from "./current-plugin-metadata.test-support.js";
import { writePersistedInstalledPluginIndex } from "./installed-plugin-index-store-write.js";
import { capturePluginGenerationArtifact } from "./plugin-generation-artifact.js";
import { clearPluginMetadataLifecycleCaches } from "./plugin-metadata-lifecycle.js";
import { withPluginSourceCaptureStorage } from "./plugin-source-capture-context.js";
import * as captureDirectory from "./plugin-source-capture-directory.js";
import {
  createPluginNativeCaptureRoot,
  createPluginSourceCaptureRoot,
  retainPluginNativeCapturePath,
  retainPluginSourceCaptureInstance,
} from "./plugin-source-capture-directory.js";
import { sweepPluginSourceCapturesForTest } from "./plugin-source-capture-directory.test-support.js";

const temp = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    clearPluginMetadataLifecycleCaches();
    await closeOpenClawStateDatabaseAsync();
    cleanup();
  }),
);
const hour = 60 * 60 * 1_000;
const locked = Object.assign(new Error("Fixture Windows sharing violation"), { code: "EPERM" });
const sourceBytes = "module.exports = 'captured';\n";
let stateDir: string;

function advanceAge() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 2 * hour);
}

function expectExists(file: string, exists = false) {
  expect(fs.existsSync(file)).toBe(exists);
}

function nativeFixture(
  state: string,
  bytes: string,
  filename = "package/bin/native",
  commit = true,
) {
  const root = createPluginNativeCaptureRoot(state);
  const file = write(root.directory, filename, bytes);
  if (commit) {
    root.commit();
    root.dispose();
  }
  return { root, file };
}

function captureFixture() {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  const directory = instance.createDirectory();
  return { instance, directory, root: path.dirname(path.dirname(directory)) };
}

function refusePath<P, A extends unknown[], T>(
  original: (target: P, ...args: A) => T,
  matches: (target: P) => boolean,
  failure: Error = locked,
) {
  return (target: P, ...args: A): T => {
    if (matches(target)) {
      throw failure;
    }
    return original(target, ...args);
  };
}

function expectBytes(file: string, expected: string) {
  expect(fs.readFileSync(file, "utf8")).toBe(expected);
}

function write(root: string, filename: string, contents: string) {
  const file = path.join(root, filename);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  return file;
}

function expectPairedFailure(failure: unknown, primary: Error, cleanup: Error) {
  if (!(failure instanceof AggregateError)) {
    throw new Error("Expected the original failure and cleanup refusal", { cause: failure });
  }
  expect(failure.cause).toBe(primary);
  expect(failure.errors).toHaveLength(2);
  expect(failure.errors[0]).toBe(primary);
  expect(failure.errors[1]).toBe(cleanup);
}

async function duringMaintenance<T>(
  run: (scope: ReturnType<typeof createOpenClawDatabaseMaintenanceScope>) => Promise<T>,
) {
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
  const lease = acquireGatewayStateOwner({ databasePath: resolveOpenClawStateSqlitePath(env) });
  const scope = createOpenClawDatabaseMaintenanceScope({
    schemaMaintenance: true,
    assertOwnerCurrent: lease.assertCurrent,
    assertDatabaseAccess: lease.assertDatabaseAccess,
  });
  try {
    return await scope.run(() => run(scope));
  } finally {
    try {
      await scope.close();
    } finally {
      lease.release();
    }
  }
}

beforeEach(() => {
  const temporary = temp.make("capture-recovery-temp-");
  for (const key of ["TMPDIR", "TMP", "TEMP"]) {
    vi.stubEnv(key, temporary);
  }
  stateDir = temp.make("capture-recovery-state-");
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each(["failed removal", "maintenance failed removal", "identity-change return"] as const)(
  "preserves reclamation errors and closes the original token after %s",
  async (mode) => {
    const root = path.join(stateDir, "tmp", "plugin-captures", "released-producer");
    const captures = path.join(root, "captures");
    const payload = write(captures, "source.js", "retained source bytes");
    const tokenPath = path.join(root, stagingToken.SQLITE_STAGING_TOKEN_FILES[0]);
    const extraLink = path.join(stateDir, "token-hardlink.sqlite");
    stagingToken.acquireSqliteStagingToken(root, "create")();
    const old = new Date(Date.now() - 2 * hour);
    fs.utimesSync(root, old, old);
    const primary = Object.assign(new Error("Fixture capture removal refused"), { code: "EACCES" });
    const cleanup = Object.assign(new Error("Fixture token close refused once"), {
      code: mode === "identity-change return" ? "EACCES" : "SQLITE_BUSY",
    });
    let closeRefused = false;
    let original: ReturnType<typeof stagingToken.acquireSqliteStagingToken> | undefined;
    const acquire = stagingToken.acquireSqliteStagingToken;
    const acquiring = vi
      .spyOn(stagingToken, "acquireSqliteStagingToken")
      .mockImplementation((...args) => {
        const token = acquire(...args);
        if (args[0] !== root || args[1] !== "reclaim") {
          return token;
        }
        original = token;
        if (mode === "identity-change return") {
          // A second link invalidates destructive custody without opening or closing the held inode.
          fs.linkSync(tokenPath, extraLink);
        }
        return Object.assign((retiring?: boolean) => {
          if (!retiring && !closeRefused) {
            closeRefused = true;
            throw cleanup;
          }
          token(retiring);
        }, token);
      });
    const remove = fsPromises.rm.bind(fsPromises);
    const removal = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
      if (mode !== "identity-change return" && target === captures) {
        throw primary;
      }
      await remove(target, options);
    });
    const classification = vi.spyOn(sqliteDiagnostics, "isSqliteLockError");
    const warning = vi.spyOn(process, "emitWarning");
    warning.mockClear();
    const collectWarnings = async () => {
      if (mode !== "maintenance failed removal") {
        await sweepPluginSourceCapturesForTest(stateDir);
        return warning.mock.calls.map(([message]) => String(message));
      }
      return duringMaintenance(async (scope) => {
        const result = await captureDirectory.prunePluginNativeCaptureDirectories(
          stateDir,
          new Set(),
          () => scope.assertAdmission(),
        );
        return result.warnings;
      });
    };
    try {
      const messages = await collectWarnings();
      expect(closeRefused).toBe(true);
      expect(messages).toEqual([expect.stringContaining(cleanup.message)]);
      if (mode !== "identity-change return") {
        expect(messages[0]?.includes(primary.message)).toBe(true);
        const failure = classification.mock.calls.find(
          ([error]) => error instanceof AggregateError && error.cause === primary,
        )?.[0];
        expectPairedFailure(failure, primary, cleanup);
      } else {
        expect(classification.mock.calls.some(([error]) => error === cleanup)).toBe(true);
        expect(fs.lstatSync(tokenPath).nlink).toBe(2);
      }
      expectBytes(payload, "retained source bytes");
      expectExists(tokenPath, true);
    } finally {
      removal.mockRestore();
      acquiring.mockRestore();
      classification.mockRestore();
      original?.();
      fs.rmSync(extraLink, { force: true });
    }
    fs.utimesSync(root, old, old);
    const after = await collectWarnings();
    expectExists(root);
    expect(after.length).toBe(mode === "maintenance failed removal" ? 0 : 1);
  },
);

it("preserves the preparation cause when synchronous token cleanup also fails", async () => {
  const instance = retainPluginSourceCaptureInstance(stateDir);
  await sweepPluginSourceCapturesForTest(stateDir);
  const primary = new Error("Fixture first capture refused");
  const cleanup = new Error("Fixture token retirement refused once");
  let ownedRoot: string | undefined;
  let refuseCleanup = true;
  const acquire = stagingToken.acquireSqliteStagingToken;
  vi.spyOn(stagingToken, "acquireSqliteStagingToken").mockImplementation((...args) => {
    const token = acquire(...args);
    ownedRoot = args[0];
    return Object.assign((retiring?: boolean) => {
      if (retiring && refuseCleanup) {
        refuseCleanup = false;
        throw cleanup;
      }
      token(retiring);
    }, token);
  });
  const mkdtemp = fs.mkdtempSync.bind(fs);
  vi.spyOn(fs, "mkdtempSync").mockImplementation((...args) => {
    if (ownedRoot && args[0].startsWith(path.join(ownedRoot, "captures") + path.sep)) {
      throw primary;
    }
    return mkdtemp(...args);
  });
  try {
    let failure: unknown;
    try {
      instance.createDirectory();
    } catch (error) {
      failure = error;
    }
    expectPairedFailure(failure, primary, cleanup);
    expect(refuseCleanup).toBe(false);
  } finally {
    vi.restoreAllMocks();
    await instance.releaseAsync();
  }
  expect(ownedRoot !== undefined && fs.existsSync(ownedRoot)).toBe(false);
});

it("recovers a removed captures directory without releasing a live instance", async () => {
  const { instance, directory, root } = captureFixture();
  const captures = path.dirname(directory);
  await sweepPluginSourceCapturesForTest(stateDir);
  fs.rmSync(captures, { recursive: true });
  let worker: ReturnType<typeof createPluginSourceCaptureRoot> | undefined;
  try {
    worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    const payload = write(worker.directory, "source.js", "recovered capture");
    advanceAge();
    await sweepPluginSourceCapturesForTest(stateDir);
    expectBytes(payload, "recovered capture");
    await worker.release();
    expectExists(root, true);
    const next = instance.createDirectory();
    expect(fs.readdirSync(captures)).toEqual([path.basename(next)]);
  } finally {
    await worker?.release();
    await instance.releaseAsync();
  }
  expectExists(root);
});

it.each(["sync", "async"])(
  "keeps published native bytes across %s disposal and later ordinary sweeps",
  async (mode) => {
    const committed = createPluginNativeCaptureRoot(stateDir);
    const pending = createPluginNativeCaptureRoot(stateDir);
    const worker = createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-");
    const payload = write(committed.directory, "package/bin/native", "retained native bytes");
    write(pending.directory, "native", "unpublished bytes");
    committed.commit();
    if (mode === "sync") {
      committed.dispose();
      pending.dispose();
    } else {
      await committed.disposeAsync();
      await pending.disposeAsync();
    }
    await worker.release();
    expectExists(pending.directory);
    expectExists(worker.directory);
    const instance = path.dirname(path.dirname(committed.directory));
    expectExists(path.join(instance, "owner.sqlite"), true);
    advanceAge();
    await sweepPluginSourceCapturesForTest(stateDir);
    expectBytes(payload, "retained native bytes");
    expectExists(path.join(instance, "owner.sqlite"), true);
  },
);

it("preserves native bytes published after an unlocked missing-directory observation", async () => {
  const instance = path.join(stateDir, "tmp", "plugin-captures", "producer");
  const native = path.join(instance, "native");
  const payload = path.join(native, "admission", "module.node");
  fs.mkdirSync(instance, { recursive: true });
  const producer = stagingToken.acquireSqliteStagingToken(instance, "create");
  const old = new Date(Date.now() - 2 * hour);
  fs.utimesSync(instance, old, old);
  const lstat = fsPromises.lstat.bind(fsPromises);
  let published = false;
  const observe = vi.spyOn(fsPromises, "lstat").mockImplementation(async (target, options) => {
    try {
      return await lstat(target, options);
    } catch (error) {
      if (target === native && !published) {
        expect(error).toMatchObject({ code: "ENOENT" });
        write(
          path.dirname(payload),
          path.basename(payload),
          "published while the producer still held its token",
        );
        producer(true);
        published = true;
      }
      throw error;
    }
  });
  try {
    await sweepPluginSourceCapturesForTest(stateDir);
    expect(published).toBe(true);
    expectBytes(payload, "published while the producer still held its token");
  } finally {
    observe.mockRestore();
    producer();
  }
});

it.each(["sync", "async"])("preserves custody after partial %s disposal", async (mode) => {
  const instance = mode === "sync" ? retainPluginSourceCaptureInstance(stateDir) : undefined;
  const worker =
    mode === "async"
      ? createPluginSourceCaptureRoot(stateDir, "openclaw-model-catalog-")
      : undefined;
  await sweepPluginSourceCapturesForTest(stateDir);
  const directory = worker?.directory ?? instance!.createDirectory();
  const root = path.dirname(path.dirname(directory));
  const payload = write(directory, "source.js", "export default 1");
  const removeSync = fs.rmSync.bind(fs);
  const remove = fsPromises.rm.bind(fsPromises);
  const interruptRemoval = (target: fs.PathLike) => {
    if (target === root) {
      // Recursive rm can unlink the token before encountering a locked payload.
      removeSync(path.join(root, "owner.sqlite"), { force: true });
      throw locked;
    }
    if (target === directory || target === path.join(root, "captures")) {
      throw locked;
    }
  };
  vi.spyOn(fs, "rmSync").mockImplementation((target, options) => {
    interruptRemoval(target);
    removeSync(target, options);
  });
  vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    interruptRemoval(target);
    await remove(target, options);
  });
  try {
    if (instance) {
      expect(() => instance.release()).toThrow(locked);
    } else {
      await worker!.release();
    }
    expectBytes(payload, "export default 1");
    const tokenless = fs
      .readdirSync(path.dirname(root))
      .filter((name) => !fs.existsSync(path.join(path.dirname(root), name, "owner.sqlite")));
    expect(tokenless).toEqual([]);
  } finally {
    vi.restoreAllMocks();
    instance?.release();
    await worker?.release();
  }
  advanceAge();
  await sweepPluginSourceCapturesForTest(stateDir);
  expectExists(root);
});

it.each([
  { stage: "lease", code: "EPERM" },
  { stage: "canonical path", code: "EPERM" },
  { stage: "captures", code: "ENOSPC" },
  { stage: "first capture", code: "ENOSPC" },
])(
  "captures usable fallback bytes without tokenless roots after $stage fails with $code",
  async ({ stage, code }) => {
    const source = temp.make("capture-recovery-source-");
    write(source, "index.cjs", sourceBytes);
    const instance = retainPluginSourceCaptureInstance(stateDir);
    await sweepPluginSourceCapturesForTest(stateDir);
    const managed = path.join(stateDir, "tmp", "plugin-captures");
    const failure = Object.assign(new Error("Fixture capture allocation refused"), { code });
    const managedPath = (file: fs.PathLike) => String(file).startsWith(managed + path.sep);
    const acquire = stagingToken.acquireSqliteStagingToken;
    const realpath = fs.realpathSync.native;
    const mkdir = fs.mkdirSync.bind(fs);
    const mkdtemp = fs.mkdtempSync.bind(fs);
    if (stage === "lease") {
      vi.spyOn(stagingToken, "acquireSqliteStagingToken").mockImplementation(
        refusePath(acquire, managedPath, failure),
      );
    } else if (stage === "canonical path") {
      vi.spyOn(fs.realpathSync, "native").mockImplementation(
        refusePath(realpath, managedPath, failure),
      );
    } else if (stage === "captures") {
      vi.spyOn(fs, "mkdirSync").mockImplementation(
        refusePath(
          mkdir,
          (file) => managedPath(file) && path.basename(String(file)) === "captures",
          failure,
        ),
      );
    } else {
      vi.spyOn(fs, "mkdtempSync").mockImplementation(refusePath(mkdtemp, managedPath, failure));
    }
    let artifact: ReturnType<typeof capturePluginGenerationArtifact> | undefined;
    try {
      artifact = withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
        capturePluginGenerationArtifact(source),
      );
      const directory = artifact.boundaryRoot;
      expectBytes(artifact.resolve(path.join(source, "index.cjs")), sourceBytes);
      expect(directory.startsWith(stateDir + path.sep)).toBe(false);
      expect(fs.readdirSync(managed)).toEqual([]);
      expectExists(path.join(path.dirname(path.dirname(directory)), "owner.sqlite"), true);
      await artifact.disposeAsync();
      expectExists(directory);
    } finally {
      vi.restoreAllMocks();
      try {
        await artifact?.disposeAsync();
      } finally {
        await instance.releaseAsync();
      }
    }
    expect(
      fs.readdirSync(tmpdir()).filter((name) => name.startsWith("openclaw-plugin-captures-")),
    ).toEqual([]);
  },
);

it("reclaims aged tokenless roots and retries locked roots", async () => {
  const stateTemp = path.join(stateDir, "tmp");
  fs.mkdirSync(stateTemp);
  const create = (parent: string, name: string) => {
    const directory = path.join(parent, name);
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, "source.js"), Buffer.alloc(1024));
    return directory;
  };
  const old = Array.from({ length: 87 }, (_, index) =>
    create(tmpdir(), `openclaw-plugin-build-${index}`),
  );
  const catalog = create(stateTemp, "openclaw-model-catalog-old");
  const busy = create(tmpdir(), "openclaw-plugin-build-locked");
  const tokened = create(tmpdir(), "openclaw-plugin-build-owned");
  fs.writeFileSync(path.join(tokened, "owner.sqlite"), "");
  const unrelated = create(tmpdir(), "unrelated");
  const link = path.join(tmpdir(), "openclaw-plugin-build-link");
  fs.symlinkSync(unrelated, link, "junction");
  advanceAge();
  const fresh = create(tmpdir(), "openclaw-plugin-build-fresh");
  // Filesystem timestamps use the real clock even when Date is faked.
  fs.utimesSync(fresh, new Date(), new Date());
  const remove = fsPromises.rm.bind(fsPromises);
  const probe = vi.spyOn(fsPromises, "rm").mockImplementation(async (target, options) => {
    if (target === busy) {
      throw locked;
    }
    await remove(target, options);
  });
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(old.filter((directory) => fs.existsSync(directory))).toHaveLength(0);
  expectExists(catalog);
  for (const kept of [fresh, busy, tokened, unrelated, link]) {
    expectExists(kept, true);
  }
  expect(fs.readdirSync(stateTemp)).toEqual([]);
  const retainedNames = () =>
    fs
      .readdirSync(tmpdir())
      .filter((name) => name.startsWith("openclaw-"))
      .toSorted();
  expect(retainedNames()).toEqual(
    [fresh, busy, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
  probe.mockRestore();
  await sweepPluginSourceCapturesForTest(stateDir);
  expectExists(busy);
  expect(retainedNames()).toEqual(
    [fresh, tokened, link].map((file) => path.basename(file)).toSorted(),
  );
});

it("retries partial tokenless removal without exhausting directory name limits", async () => {
  const managed = path.join(stateDir, "tmp", "plugin-captures");
  const directory = path.join(managed, "interrupted-instance");
  write(directory, "source.js", "retained payload");
  vi.useFakeTimers({ toFake: ["Date"] });
  const fault = vi.spyOn(fsPromises, "rm").mockRejectedValue(locked);
  for (let cycle = 0; cycle < 8; cycle++) {
    vi.setSystemTime(Date.now() + 2 * hour);
    await sweepPluginSourceCapturesForTest(stateDir);
  }
  fault.mockRestore();
  vi.setSystemTime(Date.now() + 2 * hour);
  await sweepPluginSourceCapturesForTest(stateDir);
  expect(fs.readdirSync(managed)).toEqual([]);
});

it.each(["managed", "fallback"] as const)(
  "reclaims only unreferenced native roots under maintenance while preserving live custody (%s)",
  async (location) => {
    const otherStateDir = temp.make("native-capture-other-state-");
    const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    if (location === "fallback") {
      const mkdir = fs.mkdirSync.bind(fs);
      const blocked = new Set(
        [stateDir, otherStateDir].map((directory) =>
          path.join(directory, "tmp", "plugin-captures"),
        ),
      );
      vi.spyOn(fs, "mkdirSync").mockImplementation(
        refusePath(mkdir, (target) => blocked.has(String(target))),
      );
    }
    const note = vi.spyOn(notes, "note").mockImplementation(() => {});
    const inspectProcesses = vi.spyOn(census, "inspectOtherOpenClawProcesses");
    vi.spyOn(temporaryDirectories, "inspectDoctorTemporaryDirectories").mockResolvedValue({
      directories: [],
      warnings: [],
    });
    const realpath = fsPromises.realpath.bind(fsPromises);
    vi.spyOn(fsPromises, "realpath").mockImplementation(async (target) =>
      realpath(String(target) === "/tmp" ? tmpdir() : target),
    );
    const runCaptureReport = async () => {
      note.mockClear();
      await noteLegacyPluginSourceCaptures(env, true);
      return note.mock.calls.map(([message]) => String(message)).join("\n");
    };
    const { root: referenced, file: captured } = nativeFixture(
      stateDir,
      "published native bytes",
      "content/bin/native",
    );
    const { root: orphan } = nativeFixture(stateDir, "superseded native bytes");
    const { root: warm, file: warmFile } = nativeFixture(stateDir, "warm generation bytes");
    const releaseWarm = retainPluginNativeCapturePath(warmFile);
    const { root: tokenless, file: tokenlessFile } = nativeFixture(stateDir, "unknown custody");
    fs.rmSync(path.join(path.dirname(path.dirname(tokenless.directory)), "owner.sqlite"));
    const { root: live, file: liveFile } = nativeFixture(
      stateDir,
      "currently in use",
      "package/bin/native",
      false,
    );
    const { file: otherFile } = nativeFixture(otherStateDir, "another state's payload");
    const unknown = path.join(tmpdir(), "openclaw-plugin-captures-legacy");
    fs.mkdirSync(unknown);
    const legacyToken = stagingToken.acquireSqliteStagingToken(unknown, "create");
    let legacyFile: string;
    try {
      legacyFile = write(unknown, "native/legacy/module.node", "unqualified legacy payload");
    } finally {
      legacyToken(true);
    }
    const index = makePluginMetadataIndex("fixture");
    index.plugins[0]!.sourceAdmissions = {
      fixture: {
        signature: "fixture",
        sourceDigest: "a".repeat(64),
        nativeArtifacts: {
          "bin/native": {
            sourceIdentity: "fixture",
            contentHash: "b".repeat(64),
            sizeBytes: 22,
            capturedPath: captured,
            namespace: referenced.directory,
            capturedIdentity: "fixture",
          },
        },
        nativeNamespaces: {
          [referenced.directory]: {
            sourceDirectory: "/fixture",
            capturedRoot: referenced.directory,
            managed: false,
            members: {},
          },
        },
      },
    };
    await writePersistedInstalledPluginIndex(index, { stateDir });
    advanceAge();
    try {
      inspectProcesses.mockReturnValue({ error: "fixture unreadable host argv" });
      const output = await duringMaintenance(runCaptureReport);
      expect(output).toContain("Removed 1 unreferenced native plugin capture root(s).");
      expectExists(orphan.directory);
      expectBytes(captured, "published native bytes");
      expectBytes(warmFile, "warm generation bytes");
      expectBytes(liveFile, "currently in use");
      expectBytes(otherFile, "another state's payload");
      expectBytes(legacyFile, "unqualified legacy payload");
      expectBytes(tokenlessFile, "unknown custody");
      expect(inspectProcesses).not.toHaveBeenCalled();
      releaseWarm();
      await duringMaintenance(runCaptureReport);
      expectExists(warm.directory);
      expectBytes(otherFile, "another state's payload");
      expectBytes(legacyFile, "unqualified legacy payload");
      expectBytes(tokenlessFile, "unknown custody");
    } finally {
      releaseWarm();
      live.dispose();
    }
  },
);

it("preserves artifact setup failure and borrowed custody when partial removal fails", async () => {
  const source = temp.make("capture-artifact-source-");
  const { instance: owner, directory: first, root } = captureFixture();
  await sweepPluginSourceCapturesForTest(stateDir);
  const primary = new Error("Fixture artifact permissions refused");
  const cleanup = new Error("Fixture partial capture removal refused");
  let borrowed: ReturnType<typeof retainPluginSourceCaptureInstance> | undefined;
  let created: string | undefined;
  const retain = captureDirectory.retainPluginSourceCaptureInstance;
  vi.spyOn(captureDirectory, "retainPluginSourceCaptureInstance").mockImplementation((...args) => {
    borrowed = retain(...args);
    return borrowed;
  });
  const chmod = fs.chmodSync.bind(fs);
  vi.spyOn(fs, "chmodSync").mockImplementation((target, mode) => {
    if (typeof target === "string" && path.dirname(target) === path.dirname(first)) {
      created = target;
      throw primary;
    }
    return chmod(target, mode);
  });
  const remove = fs.rmSync.bind(fs);
  vi.spyOn(fs, "rmSync").mockImplementation(
    refusePath(remove, (target) => target === created, cleanup),
  );
  try {
    let failure: unknown;
    try {
      withPluginSourceCaptureStorage({ stateDir, placement: "state" }, () =>
        capturePluginGenerationArtifact(source),
      );
    } catch (error) {
      failure = error;
    }
    expectPairedFailure(failure, primary, cleanup);
    if (!borrowed) {
      throw new Error("Expected the artifact to borrow its capture instance");
    }
    const releasedBorrower = borrowed;
    expect(() => releasedBorrower.createDirectory()).toThrow(
      "Plugin source instance has been released",
    );
    expect(created !== undefined && fs.existsSync(created)).toBe(true);
  } finally {
    vi.restoreAllMocks();
    try {
      await borrowed?.releaseAsync();
    } finally {
      await owner.releaseAsync();
    }
  }
  expectExists(root);
});
