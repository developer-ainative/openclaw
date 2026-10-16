import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, test } from "vitest";
import {
  checkChangelogLayout,
  findChangelogSection,
  findReleaseChangelog,
  isReleaseChangelogPath,
  loadChangelogCollection,
  loadReleaseChangelog,
  splitChangelog,
  writeReleaseChangelog,
} from "../../scripts/lib/release-changelog.mjs";
import {
  checkReleaseDocsMirrors,
  flattenReleaseDocs,
  parseReleaseDocsMirror,
  releaseDocsNavigation,
  renderReleaseDocsMirror,
} from "../../scripts/lib/release-docs-mirror.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const current =
  "## 2026.9.4\n\n### Highlights\n\nText.\n\n```md\n## 2099.1.1\n```\n\n### Complete contribution record\n\nAudited range abc..def.\n- **PR #12** Thanks @human.\n\n";
const old = "## 2026.8.1\n\nOld notes without a contribution record.\n";
const entry = "CHANGELOG/2026.9.4.md";
const recordFile = "CHANGELOG/records/2026.9.4.md";
function files() {
  const rootDir = tempDirs.make("release-changelog-test-");
  const file = (name: string) => path.join(rootDir, name);
  return {
    rootDir,
    file,
    read: (name: string) => fs.readFileSync(file(name), "utf8"),
    write: (name: string, text: string) => fs.writeFileSync(file(name), text),
    load: (version = "2026.9.4", ref?: string) => loadReleaseChangelog({ rootDir, version, ref }),
    save: (section: string, version = "2026.9.4") =>
      writeReleaseChangelog({ rootDir, version, section }),
  };
}
function fixture(content = `# Changelog\n\n${current}${old}`, split = false) {
  const f = files();
  f.write("CHANGELOG.md", content);
  if (split) {
    splitChangelog(f);
  }
  return f;
}
test("mechanical split preserves every section and authentic record, including CRLF", () => {
  const counts = { sections: 2, releases: 2, records: 1, duplicates: 0 };
  for (const section of [current, current.replaceAll("\n", "\r\n")]) {
    const f = fixture(`# Changelog\n\n${section}${old}`);
    const before = f.read("CHANGELOG.md");
    assert.deepEqual(splitChangelog({ ...f, check: true }), counts);
    assert.equal(f.read("CHANGELOG.md"), before);
    splitChangelog(f);
    const release = f.load("v2026.9.4");
    assert.equal(release.section, section);
    assert.equal(
      release.record?.slice(release.record.indexOf("### Complete")),
      section.slice(section.indexOf("### Complete")),
    );
    assert.equal(f.load("2026.8.1").record, null);
    assert.deepEqual(checkChangelogLayout(f), { releases: 2, records: 1 });
  }
});

test("legacy and split immutable Git reads are independent of working-tree changes", () => {
  const f = fixture();
  const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.invalid"];
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", f.rootDir, ...identity, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  git("init", "-q");
  git("add", "CHANGELOG.md");
  git("commit", "-qm", "legacy");
  const legacy = git("rev-parse", "HEAD");
  splitChangelog(f);
  git("add", "CHANGELOG.md", "CHANGELOG");
  git("commit", "-qm", "split");
  const split = git("rev-parse", "HEAD");
  f.write(entry, "broken");
  assert.equal(f.load("2026.9.4", legacy).layout, "legacy");
  assert.equal(f.load("2026.9.4", split).section, current);
  assert.throws(() => f.load(), /mismatched/u);
});

test("duplicate historical sections are retained together but never silently selected", () => {
  const f = fixture(`# Changelog\n\n${old}${old}`);
  assert.throws(() => f.load("2026.8.1"), /Ambiguous/u);
  assert.equal(splitChangelog(f).duplicates, 1);
  assert.equal(f.read("CHANGELOG/2026.8.1.md"), old + old);
  assert.equal((loadChangelogCollection(f).match(/^## /gmu) ?? []).length, 2);
  assert.throws(() => findReleaseChangelog({ ...f, version: "2026.8.1" }), /Ambiguous/u);
  assert.throws(() => f.save(old, "2026.8.1"), /Ambiguous/u);
  checkChangelogLayout(f);
});

test("initial generation updates its record, protects mirrors and refuses legacy writes", () => {
  const f = fixture();
  assert.throws(() => f.save(current), /require split/u);
  splitChangelog(f);
  const updated = current.replace("PR #12", "PR #13");
  f.save(updated);
  assert.match(f.load().record ?? "", /PR #13/u);
  assert.equal(f.read("CHANGELOG/2026.8.1.md"), old);
  const frozenRecord = f.read(recordFile);
  f.write(
    entry,
    '<!-- openclaw-docs-mirror-v1 {"version":"2026.9.4"} -->\n## 2026.9.4\n\nDocs prose.\n',
  );
  assert.equal(f.load().format, "docs-mirror");
  checkChangelogLayout(f);
  assert.throws(() => f.save(current), /cannot overwrite/u);
  assert.equal(f.read(recordFile), frozenRecord);
});

test("missing entries, conflicts, path traversal and symlinks fail at the owner", () => {
  const damageCases: ((f: ReturnType<typeof fixture>, record: string) => void)[] = [
    (f) => fs.unlinkSync(f.file(recordFile)),
    (f, record) => f.write(recordFile, record.replace("PR #12", "PR #99")),
    (f, record) => f.write(recordFile, record.replace("2026.9.4", "2026.1.1")),
    (f, record) => f.write("CHANGELOG/records/2026.1.1.md", record.replace("2026.9.4", "2026.1.1")),
    (f) => {
      fs.unlinkSync(f.file(recordFile));
      f.write(entry, "<!-- openclaw-docs-mirror-v1 {} -->\n## 2026.9.4\n\nDocs prose.\n");
    },
  ];
  for (const damage of damageCases) {
    const damaged = fixture(undefined, true);
    damage(damaged, damaged.read(recordFile));
    assert.throws(
      () => loadChangelogCollection({ ...damaged, recordsOnly: true }),
      /contribution record|Contribution record|mismatched/u,
    );
  }
  const f = fixture(undefined, true);
  assert.equal(findReleaseChangelog({ ...f, version: "2026.1.1" }), null);
  assert.throws(() => f.load("2026.1.1"), /Missing/u);
  assert.throws(() => f.load("../2026.9.4"), /Invalid/u);
  f.write("CHANGELOG.md", current);
  assert.throws(() => f.load(), /Conflicting/u);
  f.write("CHANGELOG.md", "# Changelog\n");
  fs.symlinkSync(f.file("CHANGELOG.md"), f.file("CHANGELOG/2026.1.1.md"));
  assert.throws(() => findReleaseChangelog({ ...f, version: "2026.9.4" }), /symlink/u);
});

test("Unreleased fallback and path classification preserve candidate boundaries", () => {
  const section = "## 2026.9.5 (Unreleased)\n\nUpcoming notes.\n";
  const f = fixture(`# Changelog\n\n${section}${old}`);
  assert.equal(findChangelogSection(section, "Unreleased"), section);
  splitChangelog(f);
  assert.equal(f.load("Unreleased").version, "2026.9.5");
  assert.equal(isReleaseChangelogPath(recordFile, { version: "v2026.9.4" }), true);
  assert.equal(isReleaseChangelogPath("CHANGELOG/2026.9.3.md", { version: "2026.9.4" }), false);
  assert.equal(isReleaseChangelogPath("CHANGELOG/arbitrary.md"), false);
});

describe("release docs mirrors", () => {
  const mirrorCli = fileURLToPath(
    new URL("../../scripts/render-release-changelog.mjs", import.meta.url),
  );
  const version = "2026.9.4";
  const source = `docs/releases/${version}.md`;

  function mirrorFixture() {
    const f = files();
    for (const dir of ["docs/releases", "CHANGELOG/records"]) {
      fs.mkdirSync(f.file(dir), { recursive: true });
    }
    f.write(
      source,
      `---\ntitle: "Release title"\n---\n\n# Release title\n\n${releaseDocsNavigation(version).docs}\n\nExact prose.\n`,
    );
    const options = { ...f, version, sources: [source] };
    return {
      ...options,
      render: (sources = options.sources) => renderReleaseDocsMirror({ ...options, sources }),
      check: () => checkReleaseDocsMirrors(options),
      cli: (...args: string[]) =>
        spawnSync(process.execPath, [mirrorCli, "--root", f.rootDir, ...args], {
          encoding: "utf8",
        }),
    };
  }

  it("retains prose, credits, tables, images and code while flattening wrappers and links", () => {
    const code = '```md\n<Accordion title="example">\n[local](/do-not-change)\n```';
    const preserved = [
      "- Exact credit [#42](https://github.com/openclaw/openclaw/pull/42). Thanks @alice, @steipete.",
      "| A | B |\n| --- | --- |\n| exact | cells |",
      code,
      "`<Widget> [inline](/unchanged)` and `<Note>\n[split](/unchanged) </Note>`.",
    ];
    const input = [
      '# A release\n\n## Messaging\n\n<AccordionGroup>\n<Accordion title="Keep **this** wording">\n',
      "Exact prose: [install](/install/node#help), [relative](../guide.md), [section](#source).\n",
      '<details class="release-source-toggle">\n<summary>Sources and complete change list</summary>\n',
      preserved[0] + "\n",
      preserved[1] + "\n",
      "![original alt](/images/example.png)\n",
      preserved[2] + "\n",
      preserved[3] + "\n",
      "</details>\n</Accordion>\n</AccordionGroup>\n<Warning>\nKeep the warning.\n</Warning>\n",
      '[ref]: /install/node "Keep title"',
    ];
    const result = flattenReleaseDocs(input.join("\n"), source);
    for (const text of [
      ...preserved,
      "##### Keep **this** wording",
      "###### Sources and complete change list",
      "![original alt](https://docs.openclaw.ai/images/example.png)",
      "[install](https://docs.openclaw.ai/install/node#help)",
      "[relative](https://docs.openclaw.ai/guide)",
      "[section](https://docs.openclaw.ai/releases/2026.9.4#source)",
      "> **Warning**\n> \n> Keep the warning.",
      '[ref]: https://docs.openclaw.ai/install/node "Keep title"',
    ]) {
      expect(result).toContain(text);
    }
  });

  it("binds source bytes and explicit multi-page order, preserving landing navigation", () => {
    const f = mirrorFixture();
    const other = "docs/releases/part.md";
    f.write(source, "---\ntitle: Landing\n---\n\n[Part](./part.md) - Exact navigation.\n");
    f.write(other, "---\ntitle: Part\n---\n\nFinal complete list.\n");
    const result = f.render([source, other]);
    expect(result).toContain("[Part](https://docs.openclaw.ai/releases/part) - Exact navigation.");
    expect(result.indexOf("### Landing")).toBeLessThan(result.indexOf("### Part"));
    expect(result).toContain("Final complete list.");
    const metadata = parseReleaseDocsMirror(result);
    expect(metadata?.sources).toEqual([source, other]);
    const reversed = f.render([other, source]);
    expect(parseReleaseDocsMirror(reversed)?.sourceDigest).not.toEqual(metadata?.sourceDigest);
    fs.appendFileSync(f.file(source), "\n");
    expect(parseReleaseDocsMirror(f.render([source, other]))?.sourceDigest).not.toEqual(
      metadata?.sourceDigest,
    );
  });

  it("checks only marked entries and rejects byte drift, invalid markers and missing sources", () => {
    const f = mirrorFixture();
    const output = f.file(`CHANGELOG/${version}.md`);
    fs.writeFileSync(output, f.render());
    f.write("CHANGELOG/2026.8.1.md", "## 2026.8.1\n\nHistorical prose.\n");
    expect(f.check()).toEqual([version]);
    fs.appendFileSync(output, "Edited independently.\n");
    expect(() => f.check()).toThrow(/stale or differs/);
    fs.writeFileSync(output, f.render().replace("mirror-v1", "mirror-v2"));
    expect(() => f.check()).toThrow(/Unknown or invalid/);
    fs.writeFileSync(output, f.render());
    fs.unlinkSync(f.file(source));
    expect(() => f.check()).toThrow(/ENOENT/);
  });

  it("rejects unsafe paths, duplicate sources, malformed wrappers and unsupported constructs", () => {
    const f = mirrorFixture();
    expect(() => f.render(["docs/../private.md"])).toThrow(/Invalid docs source/);
    expect(() => f.render([source, source])).toThrow(/without duplicates/);
    for (const body of [
      '<Widget title="do not lose me" />',
      '<Accordion title="Open">',
      "</details>",
      '<Note title="custom text">\nBody\n</Note>',
    ]) {
      expect(() => flattenReleaseDocs(`# Title\n\n${body}`, source)).toThrow();
    }
    fs.symlinkSync(f.file("../outside.md"), f.file("docs/escape.md"));
    expect(() => f.render(["docs/escape.md"])).toThrow();
  });

  it("runs the rendering and checking CLI without touching frozen records or docs", () => {
    const f = mirrorFixture();
    const record = f.file(`CHANGELOG/records/${version}.md`);
    fs.writeFileSync(record, "Frozen original record.\n");
    const original = f.read(source);
    const output = f.file(`CHANGELOG/${version}.md`);
    const render = (destination: string) =>
      f.cli("--version", version, "--source", source, "--output", destination);
    expect(render(output).status).toBe(0);
    const rendered = fs.readFileSync(output, "utf8");
    expect(rendered.slice(rendered.indexOf("\n\n") + 2)).toBe(
      `## ${version}\n\n\n### Release title\n\nFor formatted release notes, [read this release on the docs site](https://docs.openclaw.ai/releases/${version}).\n\nExact prose.\n\n`,
    );
    expect(rendered).not.toContain("raw.githubusercontent.com");
    const check = f.cli("--check");
    expect(check.status, check.stderr).toBe(0);
    expect(check.stdout).toContain("Checked 1 docs mirror(s)");
    expect(render(record).status).toBe(1);
    expect(fs.readFileSync(record, "utf8")).toBe("Frozen original record.\n");
    expect(f.read(source)).toEqual(original);
    fs.appendFileSync(f.file(source), "Approved docs revision.\n");
    expect(f.cli("--check").status).toBe(1);
  });
});
