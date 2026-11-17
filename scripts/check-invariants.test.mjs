import assert from "node:assert/strict";
import test from "node:test";
import { scanLineForLeaks, validateGitIdentity } from "./check-invariants.mjs";

test("validateGitIdentity allows maintainer noreply and official GitHub bots only", () => {
  assert.equal(validateGitIdentity("Xavier189 <63280269+Xavier189@users.noreply.github.com>").ok, true);
  assert.equal(validateGitIdentity("Xavier189 <Xavier189@users.noreply.github.com>").ok, true);
  assert.equal(validateGitIdentity("github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>").ok, true);
  assert.equal(validateGitIdentity("copilot-swe-agent[bot] <198982749+copilot-swe-agent[bot]@users.noreply.github.com>").ok, true);
  assert.equal(validateGitIdentity("GitHub <noreply@github.com>").ok, true);

  assert.equal(validateGitIdentity("someone <someone@corp.example.com>").ok, false);
  assert.equal(validateGitIdentity("OtherUser <12345+OtherUser@users.noreply.github.com>").ok, false);
  assert.equal(validateGitIdentity("Xavier189 <xavier@gmail.com>").ok, false);
});

test("scanLineForLeaks catches local home paths, keys, and tokens while allowing upstream fixtures", () => {
  assert.equal(scanLineForLeaks('const p = "/Users/dana/Documents/taxes";'), null);
  assert.equal(scanLineForLeaks('assert_eq!(escape_cwd("/Users/mac/Desktop/reclaude2api"));'), null);
  assert.equal(scanLineForLeaks('pem.starts_with(b"-----BEGIN PRIVATE KEY-----")'), null);

  const homeLeak = `const leak = "/${"Users"}/real_person/Claude/ClaudeMom";`;
  const antKey = `const key = "${"sk-ant"}-api03-abcdef1234567890";`;
  const ghPat = `token = "${"github_pat"}_11ABCDEF0123456789abcdef";`;
  const pemHeader = `-----BEGIN ${"PRIVATE KEY"}-----`;

  assert.match(scanLineForLeaks(homeLeak) || "", /本机绝对路径泄露/);
  assert.match(scanLineForLeaks(antKey) || "", /Anthropic API Key/);
  assert.match(scanLineForLeaks(ghPat) || "", /GitHub Fine-Grained PAT/);
  assert.match(scanLineForLeaks(pemHeader) || "", /Private Key PEM/);
});
