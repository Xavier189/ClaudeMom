import assert from "node:assert/strict";
import test from "node:test";
import { classifyChangedFiles, parseVerifyArgs } from "./verify-pr.mjs";

test("classifyChangedFiles distinguishes runtime/app changes from governance/docs changes", () => {
  const docsOnly = classifyChangedFiles([
    "AGENTS.md",
    "README.md",
    "docs/local-maintenance.md",
    ".github/workflows/ci.yml",
    "scripts/check-invariants.mjs",
  ]);
  assert.equal(docsOnly.requiresLiveAppTest, false);
  assert.deepEqual(docsOnly.runtimeFiles, []);

  const runtimeChange = classifyChangedFiles([
    "README.md",
    "crates/claude-local/runtime/proxy.mjs",
    "apps/claude-mom/src/model.ts",
  ]);
  assert.equal(runtimeChange.requiresLiveAppTest, true);
  assert.deepEqual(runtimeChange.runtimeFiles, [
    "crates/claude-local/runtime/proxy.mjs",
    "apps/claude-mom/src/model.ts",
  ]);
});

test("parseVerifyArgs parses PR numbers and flags strictly", () => {
  assert.deepEqual(parseVerifyArgs(["#12", "--wait-ci", "--local-ci", "--non-runtime"]), {
    prNumber: 12,
    help: false,
    waitCi: true,
    localCi: true,
    nonRuntime: true,
    noInstall: false,
  });
  assert.throws(() => parseVerifyArgs(["12", "--bogus"]), /未知参数/);
});
