import assert from "node:assert/strict";
import test from "node:test";
import { parseOriginRepoSlug, parseVerifyArgs } from "./verify-pr.mjs";

test("parseVerifyArgs parses PR numbers and modes strictly", () => {
  assert.deepEqual(parseVerifyArgs(["#12", "--auto"]), {
    prNumber: 12,
    help: false,
    auto: true,
    checkOnly: false,
    noInstall: false,
  });
  assert.deepEqual(parseVerifyArgs(["15", "--check-only"]), {
    prNumber: 15,
    help: false,
    auto: false,
    checkOnly: true,
    noInstall: false,
  });
  assert.throws(() => parseVerifyArgs(["12", "--auto", "--check-only"]), /不能同时指定/);
  assert.throws(() => parseVerifyArgs(["12", "--bogus"]), /未知参数/);
});

test("parseOriginRepoSlug extracts owner/repo from SSH and HTTPS URLs", () => {
  assert.equal(parseOriginRepoSlug("git@github.com:Xavier189/ClaudeMom.git"), "Xavier189/ClaudeMom");
  assert.equal(parseOriginRepoSlug("https://github.com/Xavier189/ClaudeMom"), "Xavier189/ClaudeMom");
});
