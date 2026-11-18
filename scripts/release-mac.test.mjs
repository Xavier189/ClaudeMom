import assert from "node:assert/strict";
import test from "node:test";
import { buildReleaseNotes, parseReleaseMacArgs, validateMacReleaseTag } from "./release-mac.mjs";

test("parseReleaseMacArgs parses release options and rejects bad flags", () => {
  assert.deepEqual(parseReleaseMacArgs(["--draft", "--install", "--tag", "mac-v0.1.8-abc1234"]), {
    tag: "mac-v0.1.8-abc1234",
    draft: true,
    install: true,
    skipChecks: false,
    dryRun: false,
    help: false,
  });
  assert.deepEqual(parseReleaseMacArgs(["--tag=mac-v0.1.8-test", "--skip-checks", "--dry-run"]), {
    tag: "mac-v0.1.8-test",
    draft: false,
    install: false,
    skipChecks: true,
    dryRun: true,
    help: false,
  });
  assert.throws(() => parseReleaseMacArgs(["--tag"]), /--tag 需要提供/);
  assert.throws(() => parseReleaseMacArgs(["--bogus"]), /未知参数/);
});

test("validateMacReleaseTag avoids upstream v* namespace and enforces safe names", () => {
  assert.equal(validateMacReleaseTag(null, "0.1.8", "60c7b42"), "mac-v0.1.8-60c7b42");
  assert.equal(validateMacReleaseTag("mac-v0.1.8-r1", "0.1.8", "60c7b42"), "mac-v0.1.8-r1");
  assert.throws(() => validateMacReleaseTag("v0.1.8", "0.1.8", "60c7b42"), /不能以 v 开头/);
  assert.throws(() => validateMacReleaseTag("local/verified-123", "0.1.8", "60c7b42"), /local\//);
  assert.throws(() => validateMacReleaseTag("bad tag!", "0.1.8", "60c7b42"), /非法的 Release 标签名/);
});

test("buildReleaseNotes includes macOS metadata, commits, and SHA256 sums", () => {
  const notes = buildReleaseNotes({
    version: "0.1.8",
    tag: "mac-v0.1.8-60c7b42",
    revision: "60c7b427761e382d04e97bab05b9f8ef5d7733f6",
    upstreamSha: "32214b099999",
    commits: ["60c7b42 Merge PR #5"],
    changelogNotes: "- 修复 11-17 模型锁",
    checksumsText: "deadbeef  ClaudeMom_0.1.8_arm64.dmg",
    arch: "arm64",
  });
  assert.match(notes, /ClaudeMom macOS v0\.1\.8/);
  assert.match(notes, /不包含 Windows 安装包/);
  assert.match(notes, /32214b0/);
  assert.match(notes, /ClaudeMom_0\.1\.8_arm64\.dmg/);
});
