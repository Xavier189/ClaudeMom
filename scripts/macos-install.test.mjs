import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildCleanAppEnv, cleanupTargetBundles, findRunningClaudeAppProcesses } from "./macos-install.mjs";

test("findRunningClaudeAppProcesses matches real Claude / ClaudeMom app binaries only", () => {
  const samplePs = [
    "  101 zsh -c cd /tmp/Claude/ClaudeMom && node scripts/build-local.mjs",
    "  202 /Applications/Claude.app/Contents/MacOS/Claude",
    "  303 /Applications/ClaudeMom.app/Contents/MacOS/claude-mom",
    "  404 /tmp/worktree/target/release/bundle/macos/ClaudeMom.app/Contents/MacOS/claude-mom --flag",
    "  505 rg -i claude",
  ].join("\n");

  const found = findRunningClaudeAppProcesses(samplePs);
  assert.deepEqual(
    found.map((item) => item.pid),
    [202, 303, 404],
  );
});

test("buildCleanAppEnv strips proxy and Claude/Anthropic overrides", () => {
  const clean = buildCleanAppEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDECODE: "1",
    ANTHROPIC_BASE_URL: "https://example.invalid",
    HTTPS_PROXY: "http://127.0.0.1:7890",
    http_proxy: "http://127.0.0.1:7890",
    ALL_PROXY: "socks5://127.0.0.1:7890",
  });
  assert.deepEqual(clean, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
  });
});

test("cleanupTargetBundles removes staged macOS app and dmg artifacts", () => {
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "claudemom-clean-test-"));
  try {
    const appDir = path.join(fakeRoot, "target", "release", "bundle", "macos", "ClaudeMom.app", "Contents");
    const dmgDir = path.join(fakeRoot, "target", "release", "bundle", "dmg");
    fs.mkdirSync(appDir, { recursive: true });
    fs.mkdirSync(dmgDir, { recursive: true });
    const dmgFile = path.join(dmgDir, "ClaudeMom_0.1.8_aarch64.dmg");
    fs.writeFileSync(dmgFile, "dmg-stub");

    cleanupTargetBundles(fakeRoot, { removeDmg: true });
    assert.equal(fs.existsSync(path.join(fakeRoot, "target", "release", "bundle", "macos", "ClaudeMom.app")), false);
    assert.equal(fs.existsSync(dmgFile), false);
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});
