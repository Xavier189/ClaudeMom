#!/usr/bin/env node
/**
 * PR 隔离预合并验证与合入门禁脚本（支持 grokbot 无人值守验证合并 & 本机 macOS 真机实测签收）
 *
 * 用法：
 *   1. grokbot / Agent 自动验证并合入 main（预合并 + 不变量守卫 + 前端/Rust/Node 全量测试，通过后自动 Merge，失败转草稿并留言）：
 *      node scripts/verify-pr.mjs <PR编号> --auto
 *
 *   2. 仅拉取预合并跑全量检查，不执行合并：
 *      node scripts/verify-pr.mjs <PR编号> --check-only
 *
 *   3. 本机 macOS 打包 .app + Claude Desktop 交互式真机实测签收合入（默认模式）：
 *      node scripts/verify-pr.mjs <PR编号> [--no-install] [--tag]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import {
  backupAndInstallApp,
  launchCleanApp,
  stampNow,
  stopBundleProcess,
} from "./macos-install.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseOriginRepoSlug(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`无法从 origin URL 解析 GitHub 仓库名：${remoteUrl}`);
  }
  return match[1];
}

export function parseVerifyArgs(argv) {
  const flags = new Set();
  let prNumber = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      flags.add("help");
    } else if (arg === "--auto") {
      flags.add("auto");
    } else if (arg === "--check-only") {
      flags.add("checkOnly");
    } else if (arg === "--no-install") {
      flags.add("noInstall");
    } else if (arg === "--tag") {
      flags.add("tag");
    } else if (/^#?\d+$/.test(arg) && prNumber === null) {
      prNumber = Number(arg.replace(/^#/, ""));
    } else {
      throw new Error(`未知参数 "${arg}"；使用 --help 查看用法`);
    }
  }
  if (flags.has("auto") && flags.has("checkOnly")) {
    throw new Error("--auto 与 --check-only 不能同时指定");
  }
  return {
    prNumber,
    help: flags.has("help"),
    auto: flags.has("auto"),
    checkOnly: flags.has("checkOnly"),
    noInstall: flags.has("noInstall"),
    pushTag: flags.has("tag"),
  };
}

function runCapture(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryCapture(cmd, args, cwd = REPO_ROOT, extraEnv = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.stdout || err.message || "").trim() };
  }
}

function runInherit(cmd, args, cwd = REPO_ROOT, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
}

function getRepoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return parseOriginRepoSlug(runCapture("git", ["remote", "get-url", "origin"]));
}

function getPrInfo(repo, prNumber) {
  const raw = runCapture("gh", [
    "pr",
    "view",
    String(prNumber),
    "--repo",
    repo,
    "--json",
    "number,title,state,isDraft,baseRefName,headRefName,headRefOid,url",
  ]);
  return JSON.parse(raw);
}

function reportFailureToPr(repo, pr, stamp, stageTitle, detail) {
  if (!pr.isDraft) {
    tryCapture("gh", ["pr", "ready", "--undo", String(pr.number), "--repo", repo]);
  }
  const snippet = detail.length > 3000 ? `${detail.slice(-3000)}` : detail;
  const body = [
    `### ❌ PR 自动验证未通过：${stageTitle} (${stamp})`,
    "",
    `- **提交**：\`${pr.headRefOid.slice(0, 12)}\` (\`${pr.headRefName}\`)`,
    "",
    "```text",
    snippet || "(详见终端日志)",
    "```",
    "",
    `请对照根目录 \`AGENTS.md\` 在 \`${pr.headRefName}\` 分支修复后重新推送，再重新执行验证。`,
  ].join("\n");
  tryCapture("gh", ["pr", "comment", String(pr.number), "--repo", repo, "--body", body]);
}

async function main() {
  const opts = parseVerifyArgs(process.argv.slice(2));
  if (opts.help || !opts.prNumber) {
    console.log(
      [
        "用法：",
        "  node scripts/verify-pr.mjs <PR编号> --auto                  # grokbot / Agent 无人值守预合并验证 + 通过后自动合入 main",
        "  node scripts/verify-pr.mjs <PR编号> --check-only            # 仅预合并验证全套检查，不执行合并",
        "  node scripts/verify-pr.mjs <PR编号> [--no-install] [--tag]  # 本机打包 .app + Claude Desktop 真机实测后合入 main",
      ].join("\n"),
    );
    process.exit(opts.help ? 0 : 1);
  }

  const repo = getRepoSlug();
  const pr = getPrInfo(repo, opts.prNumber);
  if (pr.state !== "OPEN") {
    throw new Error(`PR #${pr.number} 当前状态为 ${pr.state}（非 OPEN）`);
  }
  if (pr.baseRefName !== "main") {
    throw new Error(`PR #${pr.number} 目标分支为 ${pr.baseRefName}，本脚本只验证合入 main 的 PR`);
  }

  console.log(`• 开始验证 PR #${pr.number}: ${pr.title}`);
  console.log(`  分支：${pr.headRefName} @ ${pr.headRefOid.slice(0, 12)} -> ${pr.baseRefName}`);

  runInherit("git", ["fetch", "origin", "main", "upstream-main", `pull/${pr.number}/head`]);
  const latestPr = getPrInfo(repo, opts.prNumber);
  if (latestPr.headRefOid !== pr.headRefOid) {
    throw new Error(`PR #${pr.number} 在拉取期间产生新提交 (${latestPr.headRefOid.slice(0, 7)})，请重新执行`);
  }

  const stamp = stampNow();
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `claudemom-verify-pr${pr.number}-`));
  let worktreeAdded = false;

  try {
    runInherit("git", ["worktree", "add", "--detach", worktreeDir, "origin/main"]);
    worktreeAdded = true;

    const mergeRes = tryCapture("git", ["merge", "--no-ff", "--no-edit", pr.headRefOid], worktreeDir, { ALLOW_MAIN_COMMIT: "1" });
    if (!mergeRes.ok) {
      const conflicts = tryCapture("git", ["diff", "--name-only", "--diff-filter=U"], worktreeDir).out;
      tryCapture("git", ["merge", "--abort"], worktreeDir);
      if (opts.auto) {
        reportFailureToPr(repo, pr, stamp, "与最新 main 存在合并冲突", `冲突文件：\n${conflicts}\n\n${mergeRes.out}`);
      }
      throw new Error(`PR #${pr.number} 与最新 origin/main 存在合并冲突：\n${conflicts}`);
    }

    try {
      runInherit(process.execPath, ["scripts/check-invariants.mjs"], worktreeDir);
      const scriptTests = fs
        .readdirSync(path.join(worktreeDir, "scripts"))
        .filter((file) => file.endsWith(".test.mjs"))
        .map((file) => path.join("scripts", file));
      runInherit(process.execPath, ["--test", ...scriptTests], worktreeDir);
      if (opts.auto || opts.checkOnly) {
        runInherit(process.execPath, ["scripts/build-local.mjs", "--check-only"], worktreeDir);
      } else {
        runInherit(process.execPath, ["scripts/build-local.mjs"], worktreeDir);
      }
    } catch (checkErr) {
      if (opts.auto) {
        reportFailureToPr(repo, pr, stamp, "不变量或构建测试失败", String(checkErr.message || checkErr));
      }
      throw checkErr;
    }

    if (opts.checkOnly) {
      console.log(`✓ PR #${pr.number} 预合并与全量检查全部通过（--check-only 模式未执行合并）。`);
      return;
    }

    if (!opts.auto) {
      const stagedBundle = path.join(worktreeDir, "target", "release", "bundle", "macos", "ClaudeMom.app");
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        await rl.question("\n请先完全退出正在运行的 Claude Desktop 与 ClaudeMom，准备好后按回车启动待测实例… ");
        launchCleanApp(stagedBundle);
        console.log("\n=== 真机实测清单 ===");
        console.log("  1. 从待测 ClaudeMom 启动 Claude Desktop，普通对话连续发送两轮消息均正常回复，重开会话记录可读");
        console.log("  2. 在 Code 页签空目录发送最小提示，确认正常收到模型回复");
        console.log("  3. 检查模型展示名、主题及上游通道符合预期");
        const verdict = (await rl.question("\n请输入验收结论 [pass / fail <原因> / abort]: ")).trim();

        stopBundleProcess(stagedBundle);

        if (verdict === "abort" || !verdict) {
          console.log("已中止验收，远端状态与已安装应用均未修改。");
          return;
        }
        if (verdict.startsWith("fail")) {
          const reason = verdict.slice(4).trim() || "本机 Claude Desktop 真机实测未通过";
          reportFailureToPr(repo, pr, stamp, "本机 Claude Desktop 真机实测未通过", reason);
          if (fs.existsSync("/Applications/ClaudeMom.app")) {
            launchCleanApp("/Applications/ClaudeMom.app");
          }
          console.log(`✗ 已记录实测失败并转回草稿 PR：${pr.url}`);
          process.exit(1);
        }
        if (verdict !== "pass") {
          throw new Error(`无法识别的输入 "${verdict}"（仅支持 pass / fail <原因> / abort）`);
        }

        if (!opts.noInstall) {
          backupAndInstallApp(stagedBundle, {
            backupPrefix: `pr${pr.number}`,
            stamp,
            stateBackupName: `pr${pr.number}-${stamp}`,
            cleanupStagedBundle: true,
          });
          launchCleanApp("/Applications/ClaudeMom.app");
        }
      } finally {
        rl.close();
      }
    }

    if (pr.isDraft) {
      runInherit("gh", ["pr", "ready", String(pr.number), "--repo", repo]);
    }
    runInherit("gh", ["pr", "merge", String(pr.number), "--repo", repo, "--merge", "--delete-branch"]);
    runInherit("git", ["fetch", "origin", "main", "--prune"]);

    const currentBranch = runCapture("git", ["branch", "--show-current"]);
    const dirty = runCapture("git", ["status", "--porcelain"]);
    if (currentBranch === "main" && !dirty) {
      runInherit("git", ["merge", "--ff-only", "origin/main"]);
    }

    if (!opts.auto && opts.pushTag) {
      const verifiedTag = `local/verified-${stamp}`;
      runInherit("git", ["tag", verifiedTag, "origin/main"]);
      runInherit("git", ["push", "origin", `refs/tags/${verifiedTag}`]);
      console.log(`✓ 已创建并推送实测回滚锚点标签：${verifiedTag}`);
    }

    console.log(`✓ PR #${pr.number} 已验证通过并合入 main！`);
  } finally {
    if (worktreeAdded) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", worktreeDir], { cwd: REPO_ROOT, stdio: "ignore" });
      } catch {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      }
    } else {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`\n✗ ${err.message || err}`);
    process.exit(1);
  });
}
