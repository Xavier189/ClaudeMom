#!/usr/bin/env node
/**
 * 个人 Fork（Xavier189/ClaudeMom）macOS 专用本地打包与 GitHub Release 发布脚本。
 *
 * 特点：
 *   1. 只构建并发布 macOS 安装包（.dmg + .app.zip + SHA256SUMS.txt），完全不涉及 Windows 产物。
 *   2. 使用 mac-v<version>-<shortsha> 标签并绑定当前 main 提交，避开服务端对 v* 上游标签的 Ruleset 封禁。
 *   3. 发布并按需安装完成后自动清理 target/release/bundle/ 下的临时 .app/.dmg，避免 Spotlight 检索出重复应用。
 *
 * 用法：
 *   node scripts/release-mac.mjs [--tag <tag>] [--draft] [--install] [--skip-checks] [--dry-run]
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPO_ROOT,
  assertCleanWorktree,
  buildMacBundles,
  prepareBuildEnv,
  runFullVerification,
} from "./build-local.mjs";
import {
  assertNoRunningClaudeApps,
  backupAndInstallApp,
  cleanupTargetBundles,
  launchCleanApp,
  stampNow,
} from "./macos-install.mjs";
import { changelogSection } from "./release-meta.mjs";
import { parseOriginRepoSlug } from "./verify-pr.mjs";

export function parseReleaseMacArgs(argv) {
  let tag = null;
  let draft = false;
  let install = false;
  let skipChecks = false;
  let dryRun = false;
  let help = false;

  for (let idx = 0; idx < argv.length; idx += 1) {
    const arg = argv[idx];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--draft") {
      draft = true;
    } else if (arg === "--install") {
      install = true;
    } else if (arg === "--skip-checks") {
      skipChecks = true;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--tag") {
      const next = argv[idx + 1];
      if (!next || next.startsWith("--")) throw new Error("--tag 需要提供标签名，例如 mac-v0.1.8-60c7b42");
      tag = next;
      idx += 1;
    } else if (arg.startsWith("--tag=")) {
      tag = arg.slice("--tag=".length);
    } else {
      throw new Error(`未知参数 "${arg}"；使用 --help 查看用法`);
    }
  }

  return { tag, draft, install, skipChecks, dryRun, help };
}

export function validateMacReleaseTag(tagInput, version, shortSha) {
  const tag = (tagInput && tagInput.trim()) || `mac-v${version}-${shortSha}`;
  if (/^[vV]/.test(tag)) {
    throw new Error(`个人 Fork Release 标签不能以 v 开头（${tag} 与上游发版标签及服务端 Ruleset 冲突），请使用如 mac-v${version}-${shortSha}`);
  }
  if (/^local\//i.test(tag)) {
    throw new Error(`Release 标签不能以 local/ 开头（${tag} 为本地回滚标签命名空间），请使用如 mac-v${version}-${shortSha}`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(tag)) {
    throw new Error(`非法的 Release 标签名 "${tag}"（仅允许字母、数字、点、下划线与连字符，长度 2-64）`);
  }
  return tag;
}

export function buildReleaseNotes({
  version,
  tag,
  revision,
  upstreamSha,
  commits = [],
  changelogNotes = "",
  checksumsText = "",
  arch = process.arch,
}) {
  const shortSha = revision.slice(0, 7);
  const lines = [
    `## ClaudeMom macOS v${version} (\`${shortSha}\`)`,
    "",
    `- **Release 标签**：\`${tag}\``,
    `- **构建提交**：\`${revision}\`（\`main\`）`,
    ...(upstreamSha ? [`- **对应上游基线**：\`${upstreamSha.slice(0, 7)}\`（\`BigPizzaV3/ClaudeMom\`）`] : []),
    `- **适用平台**：macOS (${arch})，ad-hoc 本地签名（不包含 Windows 安装包）`,
    "",
  ];

  if (commits.length > 0) {
    lines.push("### 包含提交", "", ...commits.map((entry) => `- ${entry}`), "");
  }

  if (changelogNotes.trim()) {
    lines.push(`### 上游 ${version} 变更说明`, "", changelogNotes.trim(), "");
  }

  if (checksumsText.trim()) {
    lines.push("### SHA-256 校验值", "", "```text", checksumsText.trim(), "```", "");
  }

  lines.push(
    "### 安装提示",
    "",
    "本包为个人 Fork 在本机生成的 ad-hoc 签名包（未走 Apple 账号公证），首次从网页下载安装若遇系统拦截，请在终端执行：",
    "",
    "```bash",
    "xattr -cr /Applications/ClaudeMom.app",
    "```",
  );
  return `${lines.join("\n")}\n`;
}

function capture(cmd, args, cwd = REPO_ROOT, env = process.env) {
  return execFileSync(cmd, args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryCapture(cmd, args, cwd = REPO_ROOT, env = process.env) {
  try {
    return { ok: true, out: capture(cmd, args, cwd, env) };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.stdout || err.message || "").trim() };
  }
}

function sha256File(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function main() {
  const opts = parseReleaseMacArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "用法：node scripts/release-mac.mjs [--tag <tag>] [--draft] [--install] [--skip-checks] [--dry-run]",
        "仅构建并发布当前 main 分支的 macOS 安装包（.dmg / .app.zip / SHA256SUMS.txt）到个人 Fork GitHub Release。",
        "  --tag <tag>     自定义 Release 标签（默认 mac-v<version>-<shortsha>，禁止以 v 或 local/ 开头）",
        "  --draft         创建草稿 Release 而非立即公开发布",
        "  --install       同步安装替换 /Applications/ClaudeMom.app（要求先退出 Claude 与 ClaudeMom）",
        "  --skip-checks   跳过测试直接构建发布（仅当刚在同一提交上跑完全套检查时使用）",
        "  --dry-run       仅校验环境并打印计划，不构建不上传",
      ].join("\n"),
    );
    return;
  }

  if (opts.install && !opts.dryRun) {
    assertNoRunningClaudeApps();
  }

  const env = prepareBuildEnv(REPO_ROOT);
  assertCleanWorktree(REPO_ROOT, env);

  const originUrl = capture("git", ["remote", "get-url", "origin"], REPO_ROOT, env);
  const repoSlug = parseOriginRepoSlug(originUrl);
  if (/^BigPizzaV3\/ClaudeMom$/i.test(repoSlug)) {
    throw new Error(`当前 origin 为原作者仓库 ${repoSlug}；此脚本仅用于个人 Fork 发布 macOS Release`);
  }

  const branch = capture("git", ["branch", "--show-current"], REPO_ROOT, env);
  if (branch !== "main") {
    throw new Error(`当前位于分支 ${branch || "(detached)"}；请切回 main 并确保已通过 PR 合入后再发布 Release`);
  }

  console.log("• 同步远端引用检查最新 main...");
  execFileSync("git", ["fetch", "origin", "main", "upstream-main", "--tags", "--prune", "--quiet"], {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
  });

  const revision = capture("git", ["rev-parse", "HEAD"], REPO_ROOT, env);
  const originMainSha = capture("git", ["rev-parse", "origin/main"], REPO_ROOT, env);
  if (revision !== originMainSha) {
    throw new Error(`本地 main (${revision.slice(0, 7)}) 与 origin/main (${originMainSha.slice(0, 7)}) 不一致；请先快进/拉取最新 main`);
  }

  const shortSha = revision.slice(0, 7);
  const version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "apps/claude-mom/src-tauri/tauri.conf.json"), "utf8")).version;
  const tag = validateMacReleaseTag(opts.tag, version, shortSha);

  const existingRemoteTag = capture("git", ["ls-remote", "--tags", "origin", `refs/tags/${tag}`], REPO_ROOT, env);
  if (existingRemoteTag) {
    throw new Error(`远端已存在标签 ${tag}；如要重新发布请使用新标签（--tag）或先清理旧 Release/标签`);
  }
  if (tryCapture("gh", ["release", "view", tag, "--repo", repoSlug], REPO_ROOT, env).ok) {
    throw new Error(`远端已存在 Release ${tag}`);
  }

  const upstreamRes = tryCapture("git", ["rev-parse", "origin/upstream-main"], REPO_ROOT, env);
  const upstreamSha = upstreamRes.ok ? upstreamRes.out : "";
  const commitRange = upstreamSha ? `${upstreamSha}..${revision}` : `${revision}~10..${revision}`;
  const commitsOut = tryCapture("git", ["log", "--no-merges", "--format=%h %s", commitRange], REPO_ROOT, env);
  const commits = commitsOut.ok ? commitsOut.out.split("\n").filter(Boolean).slice(0, 20) : [];

  console.log(`• 目标仓库：${repoSlug}`);
  console.log(`• Release 标签：${tag} -> main @ ${shortSha} (v${version}, ${process.arch})`);

  if (opts.dryRun) {
    console.log("✓ [dry-run] 检查通过；将运行全量检查、构建 .app/.dmg 并创建仅含 macOS 产物的 Release。");
    return;
  }

  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudemom-mac-release-"));
  try {
    if (!opts.skipChecks) {
      console.log("• 执行仓库不变量与脚本单测...");
      execFileSync(process.execPath, ["scripts/check-invariants.mjs"], { cwd: REPO_ROOT, env, stdio: "inherit" });
      const scriptTests = fs
        .readdirSync(path.join(REPO_ROOT, "scripts"))
        .filter((file) => file.endsWith(".test.mjs"))
        .map((file) => path.join("scripts", file));
      execFileSync(process.execPath, ["--test", ...scriptTests], { cwd: REPO_ROOT, env, stdio: "inherit" });
      runFullVerification({ cwd: REPO_ROOT, env });
    }

    console.log("• 构建 macOS .app 与 .dmg（忽略 Windows 产物）...");
    const built = buildMacBundles({ cwd: REPO_ROOT, env, bundles: ["app", "dmg"] });
    if (!built || !built.dmgPath) {
      throw new Error("未找到构建生成的 .app 或 .dmg 产物");
    }

    const dmgAsset = path.join(stageDir, `ClaudeMom_${version}_${process.arch}.dmg`);
    const zipAsset = path.join(stageDir, `ClaudeMom_${version}_${process.arch}.app.zip`);
    fs.copyFileSync(built.dmgPath, dmgAsset);
    execFileSync("/usr/bin/ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", built.bundleAbs, zipAsset], {
      stdio: "inherit",
    });

    const checksumLines = [dmgAsset, zipAsset]
      .map((file) => `${sha256File(file)}  ${path.basename(file)}`)
      .join("\n");
    const checksumsAsset = path.join(stageDir, "SHA256SUMS.txt");
    fs.writeFileSync(checksumsAsset, `${checksumLines}\n`);

    const notesPath = path.join(stageDir, "release-notes.md");
    const notesBody = buildReleaseNotes({
      version,
      tag,
      revision,
      upstreamSha,
      commits,
      changelogNotes: changelogSection(version),
      checksumsText: checksumLines,
      arch: process.arch,
    });
    fs.writeFileSync(notesPath, notesBody);

    if (opts.install) {
      const stamp = stampNow();
      const installed = backupAndInstallApp(built.bundleAbs, {
        backupPrefix: "release",
        stamp,
        stateBackupName: `release-${stamp}`,
        requireAppQuit: true,
        cleanupStagedBundle: false,
      });
      launchCleanApp(installed.targetApp);
    }

    const ghArgs = [
      "release",
      "create",
      tag,
      dmgAsset,
      zipAsset,
      checksumsAsset,
      "--repo",
      repoSlug,
      "--target",
      revision,
      "--title",
      `ClaudeMom macOS v${version} (${shortSha})`,
      "--notes-file",
      notesPath,
    ];
    if (opts.draft) {
      ghArgs.push("--draft");
    } else {
      ghArgs.push("--latest");
    }

    console.log(`$ gh ${ghArgs.join(" ")}`);
    const releaseUrl = capture("gh", ghArgs, REPO_ROOT, env);
    console.log(`✓ 已发布个人 macOS Release：${releaseUrl}`);
  } finally {
    cleanupTargetBundles(REPO_ROOT, { removeDmg: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`\n✗ ${err.message || err}`);
    process.exit(1);
  }
}
