#!/usr/bin/env node
/**
 * macOS 本地安装、备份归档与防重复 Bundle 清理辅助模块。
 *
 * 目的：
 * 1. 安装 /Applications/ClaudeMom.app 前完成签名校验与受保护备份（归档为 .app.zip 并注销 LaunchServices）。
 * 2. 安装后清理 target/release/bundle/ 下未打包的 ClaudeMom.app，避免 Spotlight / Raycast 索引出两个 ClaudeMom。
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_TARGET_APP = "/Applications/ClaudeMom.app";
export const LSREGISTER_PATH =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

export function stampNow(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export function buildCleanAppEnv(baseEnv = process.env) {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(
      ([name]) => !/^(?:CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|(?:HTTPS?|ALL|NO)_PROXY$)/i.test(name),
    ),
  );
}

/**
 * 解析 `ps -axo pid=,command=` 输出，仅匹配实际运行中的 Claude Desktop 或 ClaudeMom 主进程，
 * 避免命令行里路径恰好包含 "Claude" 的构建/终端进程误报。
 */
export function findRunningClaudeAppProcesses(psOutput) {
  const matches = [];
  for (const rawLine of psOutput.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const command = match[2];
    if (/(?:^|\/)(?:Claude\.app\/Contents\/MacOS\/Claude|[^/\s]+\.app\/Contents\/MacOS\/claude-mom)(?:\s|$)/.test(command)) {
      matches.push({ pid, command });
    }
  }
  return matches;
}

export function listRunningClaudeAppProcesses() {
  try {
    const out = execFileSync("ps", ["-axo", "pid=,command="], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return findRunningClaudeAppProcesses(out);
  } catch {
    return [];
  }
}

export function assertNoRunningClaudeApps() {
  const running = listRunningClaudeAppProcesses();
  if (running.length > 0) {
    const summary = running.map((item) => `  - PID ${item.pid}: ${item.command}`).join("\n");
    throw new Error(`检测到以下 Claude / ClaudeMom 进程仍在运行，请先完全退出后再安装：\n${summary}`);
  }
}

export function unregisterBundle(bundlePath) {
  if (!bundlePath || !fs.existsSync(LSREGISTER_PATH) || !fs.existsSync(bundlePath)) return;
  try {
    execFileSync(LSREGISTER_PATH, ["-u", bundlePath], { stdio: "ignore" });
  } catch {
    // LaunchServices 未记录该路径时忽略
  }
}

export function registerBundle(bundlePath) {
  if (!bundlePath || !fs.existsSync(LSREGISTER_PATH) || !fs.existsSync(bundlePath)) return;
  try {
    execFileSync(LSREGISTER_PATH, ["-f", bundlePath], { stdio: "ignore" });
  } catch {
    // best-effort 刷新注册
  }
}

export function unregisterBackupAppBundles(backupsDir) {
  if (!fs.existsSync(backupsDir)) return;
  for (const entry of fs.readdirSync(backupsDir, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.endsWith(".app")) {
      unregisterBundle(path.join(backupsDir, entry.name));
    }
  }
}

export function cleanupTargetBundles(repoRoot, { removeDmg = true } = {}) {
  const macosApp = path.join(repoRoot, "target", "release", "bundle", "macos", "ClaudeMom.app");
  if (fs.existsSync(macosApp)) {
    unregisterBundle(macosApp);
    fs.rmSync(macosApp, { recursive: true, force: true });
  }
  if (removeDmg) {
    const dmgDir = path.join(repoRoot, "target", "release", "bundle", "dmg");
    if (fs.existsSync(dmgDir)) {
      for (const entry of fs.readdirSync(dmgDir)) {
        if (entry.endsWith(".dmg")) {
          fs.rmSync(path.join(dmgDir, entry), { force: true });
        }
      }
    }
  }
}

function moveOrCopyBundle(src, dest) {
  try {
    fs.renameSync(src, dest);
  } catch (err) {
    if (err && err.code === "EXDEV") {
      execFileSync("/usr/bin/ditto", [src, dest], { stdio: "inherit" });
      fs.rmSync(src, { recursive: true, force: true });
    } else {
      throw err;
    }
  }
}

function archiveAppToZip(appDir, zipPath) {
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appDir, zipPath], {
    stdio: "inherit",
  });
  if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size === 0) {
    throw new Error(`备份压缩归档失败：${zipPath}`);
  }
}

/**
 * 校验待安装 .app 签名、备份配置快照及旧应用（压缩归档并注销 LaunchServices），
 * 随后原子替换 /Applications/ClaudeMom.app，并按需清理 staged 构建产物以防重复检索。
 */
export function backupAndInstallApp(stagedBundle, options = {}) {
  const {
    backupPrefix = "local",
    stamp = stampNow(),
    stateBackupName = stamp,
    targetApp = DEFAULT_TARGET_APP,
    claudeHome = path.join(os.homedir(), ".claude-mom"),
    snapshotsDir = path.join(os.homedir(), ".claude-mom-snapshots"),
    requireAppQuit = false,
    cleanupStagedBundle = false,
    repoRoot = null,
  } = options;

  if (!fs.existsSync(stagedBundle)) {
    throw new Error(`找不到待安装应用包：${stagedBundle}`);
  }
  if (requireAppQuit) {
    assertNoRunningClaudeApps();
  }

  console.log(`$ /usr/bin/codesign --verify --deep --strict ${stagedBundle}`);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedBundle], { stdio: "inherit" });

  const backupsDir = path.join(claudeHome, "backups");
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(snapshotsDir, 0o700);
  unregisterBackupAppBundles(backupsDir);

  let stateBackupPath = null;
  if (fs.existsSync(claudeHome)) {
    stateBackupPath = path.join(snapshotsDir, stateBackupName);
    execFileSync("/usr/bin/ditto", [claudeHome, stateBackupPath], { stdio: "inherit" });
  }

  const tempStage = fs.mkdtempSync(path.join(path.dirname(targetApp), ".claudemom-install."));
  const stagedCopy = path.join(tempStage, "ClaudeMom.app");
  let appBackupArchive = null;

  try {
    execFileSync("/usr/bin/ditto", [stagedBundle, stagedCopy], { stdio: "inherit" });
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedCopy], { stdio: "inherit" });

    if (fs.existsSync(targetApp)) {
      unregisterBundle(targetApp);
      const rawBackupApp = path.join(backupsDir, `ClaudeMom-before-${backupPrefix}-${stamp}.app`);
      appBackupArchive = `${rawBackupApp}.zip`;
      moveOrCopyBundle(targetApp, rawBackupApp);
      unregisterBundle(rawBackupApp);
      archiveAppToZip(rawBackupApp, appBackupArchive);
      fs.rmSync(rawBackupApp, { recursive: true, force: true });
      console.log(`• 已归档备份旧版应用至：${appBackupArchive}`);
    }

    fs.renameSync(stagedCopy, targetApp);
    registerBundle(targetApp);
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", targetApp], { stdio: "inherit" });
    console.log(`✓ 已替换安装：${targetApp}`);
  } finally {
    fs.rmSync(tempStage, { recursive: true, force: true });
  }

  if (cleanupStagedBundle) {
    if (repoRoot) {
      cleanupTargetBundles(repoRoot);
    } else if (fs.existsSync(stagedBundle) && path.resolve(stagedBundle) !== path.resolve(targetApp)) {
      unregisterBundle(stagedBundle);
      fs.rmSync(stagedBundle, { recursive: true, force: true });
    }
  }

  return {
    targetApp,
    appBackupArchive,
    stateBackupPath,
  };
}

export function launchCleanApp(bundlePath = DEFAULT_TARGET_APP) {
  spawn("open", ["-n", bundlePath], {
    detached: true,
    stdio: "ignore",
    env: buildCleanAppEnv(),
  }).unref();
}

export function stopBundleProcess(bundlePath) {
  try {
    execFileSync("pkill", ["-f", `${bundlePath}/Contents/MacOS/claude-mom`], { stdio: "ignore" });
    execFileSync("sleep", ["1"]);
  } catch {
    // not running
  }
}
