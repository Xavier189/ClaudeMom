import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { listCliSkills } from "../cli-skills.mjs";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-cli-skills-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeSkill(directory, updatedAt = "2026-01-02T03:04:05.000Z") {
  fs.mkdirSync(directory, { recursive: true });
  const skill = path.join(directory, "SKILL.md");
  fs.writeFileSync(skill, "---\ninvalid yaml: [\nprivate fixture body\n");
  fs.utimesSync(skill, new Date(updatedAt), new Date(updatedAt));
  return { directoryName: path.basename(directory), updatedAt };
}

test("CLI skills list immediate skill directories by name using only file metadata", async (t) => {
  const root = fixture(t);
  const zeta = writeSkill(path.join(root, "zeta"), "2026-01-03T03:04:05.000Z");
  const alpha = writeSkill(path.join(root, "alpha"));
  writeSkill(path.join(root, "container", "nested"));
  fs.chmodSync(path.join(root, "alpha", "SKILL.md"), 0o000);

  assert.deepEqual(await listCliSkills(root), { skills: [alpha, zeta], available: true });
});

test("CLI skills include external directory symlinks using the link directory name", async (t) => {
  const root = fixture(t);
  const directory = path.join(root, "skills");
  fs.mkdirSync(directory);
  const shared = writeSkill(path.join(root, "shared-source"));
  fs.symlinkSync(path.join(root, "shared-source"), path.join(directory, "shared-link"), "dir");

  assert.deepEqual(await listCliSkills(directory), {
    skills: [{ directoryName: "shared-link", updatedAt: shared.updatedAt }],
    available: true,
  });
});

test("CLI skills ignore broken links, missing files and nonregular skill entries", async (t) => {
  const root = fixture(t);
  const good = writeSkill(path.join(root, "good"));
  fs.symlinkSync(path.join(root, "missing"), path.join(root, "broken-link"), "dir");
  fs.mkdirSync(path.join(root, "no-skill"));
  fs.writeFileSync(path.join(root, "plain-file"), "not a directory");
  fs.symlinkSync(path.join(root, "plain-file"), path.join(root, "file-link"), "file");
  fs.mkdirSync(path.join(root, "skill-is-directory", "SKILL.md"), { recursive: true });
  fs.mkdirSync(path.join(root, "broken-skill"));
  fs.symlinkSync(path.join(root, "missing.md"), path.join(root, "broken-skill", "SKILL.md"), "file");

  assert.deepEqual(await listCliSkills(root), { skills: [good], available: true });
});

test("CLI skills distinguish an unspecified directory from a missing directory", async (t) => {
  const root = fixture(t);
  for (const directory of [undefined, null, ""]) {
    assert.deepEqual(await listCliSkills(directory), { skills: [], available: false });
  }
  assert.deepEqual(await listCliSkills(path.join(root, "missing")), { skills: [], available: true });
});

test("CLI skills return a fixed path-free error when the configured directory cannot be read", async (t) => {
  const root = fixture(t);
  const file = path.join(root, "private-path");
  fs.writeFileSync(file, "not a directory");

  assert.deepEqual(await listCliSkills(file), {
    skills: [],
    available: false,
    error: "Unable to read the CLI skills directory.",
  });
});
