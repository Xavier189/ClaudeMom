#!/usr/bin/env node
/**
 * PR 本机实测签收与合并门禁脚本（macOS）
 *
 * 用法：
 *   node scripts/verify-pr.mjs <PR编号> [--wait-ci] [--no-install]
 *   node scripts/verify-pr.mjs <PR编号> --non-runtime [--wait-ci]
 *
 * 流程：
 *   1. 校验目标 PR 指向 main，且云端必过状态 ci-gate 已成功（--wait-ci 可轮询等待）
 *   2. 在临时 git worktree 将 PR 合入最新 origin/main，运行 check-invariants 与全套构建/测试
 *   3. 运行期代码变更默认启动预构建的 ClaudeMom.app 供真机交互验收：
 *        输入 pass   -> 备份并替换 /Applications/ClaudeMom.app，上报 local-verified=success，Merge 合入 main 并打 local/verified-* 标签
 *        输入 fail   -> 不动已安装 App，上报 local-verified=failure，转为草稿 PR 并留言供 Agent 修复
 *        输入 abort  -> 仅清理临时目录，不改远端状态
 *   4. 纯文档/工作流/脚本治理变更可使用 --non-runtime（一旦触碰 apps/、crates/、Cargo.* 立即拒绝跳过实测）
 */
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const RUNTIME_PATH_PREFIXES = [
  "apps/",
  "crates/",
  "Cargo.toml",
  "Cargo.lock",
  "scripts/build-local.mjs",
  "scripts/relaunch-local.mjs",
];

export function classifyChangedFiles(files) {
  const runtimeFiles = files.filter((file) =>
    RUNTIME_PATH_PREFIXES.some((prefix) => (prefix.endsWith("/") ? file.startsWith(prefix) : file === prefix)),
  );
  return {
    requiresLiveAppTest: runtimeFiles.length > 0,
    runtimeFiles,
  };
}

export function parseVerifyArgs(argv) {
  const flags = new Set();
  let prNumber = null;
  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      flags.add("help");
    } else if (arg === "--wait-ci") {
      flags.add("waitCi");
    } else if (arg === "--local-ci") {
      flags.add("localCi");
    } else if (arg === "--non-runtime") {
      flags.add("nonRuntime");
    } else if (arg === "--no-install") {
      flags.add("noInstall");
    } else if (/^#?\d+$/.test(arg) && prNumber === null) {
      prNumber = Number(arg.replace(/^#/, ""));
    } else {
      throw new Error(`未知参数 "${arg}"；使用 --help 查看用法`);
    }
  }
  return {
    prNumber,
    help: flags.has("help"),
    waitCi: flags.has("waitCi"),
    localCi: flags.has("localCi"),
    nonRuntime: flags.has("nonRuntime"),
    noInstall: flags.has("noInstall"),
  };
}

function runCapture(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function runInherit(cmd, args, cwd = REPO_ROOT, extraEnv = {}) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { cwd, env: { ...process.env, ...extraEnv }, stdio: "inherit" });
}

function stampNow() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function getRepoSlug() {
  return runCapture("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"]);
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

function getCommitStatusState(repo, sha, contextName) {
  const raw = runCapture("gh", ["api", `repos/${repo}/commits/${sha}/status`]);
  const data = JSON.parse(raw);
  const match = (data.statuses || []).find((s) => s.context === contextName);
  return match ? match.state : null;
}

async function ensureCiGatePassed(repo, pr, waitCi) {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (true) {
    const state = getCommitStatusState(repo, pr.headRefOid, "ci-gate");
    if (state === "success") {
      console.log(`✓ 云端门禁 ci-gate 已通过 (${pr.headRefOid.slice(0, 7)})`);
      return;
    }
    if (state === "failure" || state === "error") {
      throw new Error(`PR #${pr.number} 的云端 ci-gate 状态为 ${state}，请先修复云端 CI 后再实测签收：${pr.url}`);
    }
    if (!waitCi) {
      throw new Error(
        `PR #${pr.number} 的 ci-gate 当前状态为 ${state || "pending/未上报"}；可追加 --wait-ci 自动等待云端检查完成：${pr.url}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 PR #${pr.number} 云端 ci-gate 超时（30 分钟）`);
    }
    console.log(`⏳ 等待云端 ci-gate 完成（当前：${state || "pending"}），15 秒后重试…`);
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

function postCommitStatus(repo, sha, state, description, context = "local-verified") {
  runCapture("gh", [
    "api",
    "-X",
    "POST",
    `repos/${repo}/statuses/${sha}`,
    "-f",
    `state=${state}`,
    "-f",
    `context=${context}`,
    "-f",
    `description=${description.slice(0, 135)}`,
  ]);
}

function launchCleanApp(bundlePath) {
  const cleanEnv = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !/^(CLAUDE_CODE_|CLAUDECODE$|ANTHROPIC_|(HTTPS?|ALL|NO)_PROXY$)/i.test(name)),
  );
  spawn("open", ["-n", bundlePath], { detached: true, stdio: "ignore", env: cleanEnv }).unref();
}

function stopBundleProcess(bundlePath) {
  try {
    execFileSync("pkill", ["-f", `${bundlePath}/Contents/MacOS/claude-mom`], { stdio: "ignore" });
    execFileSync("sleep", ["1"]);
  } catch {
    // not running
  }
}

function backupAndInstallApp(stagedBundle, prNumber, stamp) {
  const targetApp = "/Applications/ClaudeMom.app";
  const backupsDir = path.join(os.homedir(), ".claude-mom", "backups");
  const snapshotsDir = path.join(os.homedir(), ".claude-mom-snapshots");
  fs.mkdirSync(backupsDir, { recursive: true });
  fs.mkdirSync(snapshotsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(snapshotsDir, 0o700);

  runInherit("/usr/bin/codesign", ["--verify", "--deep", "--strict", stagedBundle]);

  const stateDir = path.join(os.homedir(), ".claude-mom");
  const stateBackup = path.join(snapshotsDir, `pr${prNumber}-${stamp}`);
  if (fs.existsSync(stateDir)) {
    execFileSync("ditto", [stateDir, stateBackup]);
  }

  const appBackup = path.join(backupsDir, `ClaudeMom-before-pr${prNumber}-${stamp}.app`);
  const tempStage = fs.mkdtempSync("/Applications/.claudemom-verify-stage.");
  const tempApp = path.join(tempStage, "ClaudeMom.app");
  try {
    execFileSync("ditto", [stagedBundle, tempApp]);
    runInherit("/usr/bin/codesign", ["--verify", "--deep", "--strict", tempApp]);
    if (fs.existsSync(targetApp)) {
      fs.renameSync(targetApp, appBackup);
      console.log(`• 已备份旧版应用至：${appBackup}`);
    }
    fs.renameSync(tempApp, targetApp);
    console.log(`✓ 已替换安装：${targetApp}`);
  } finally {
    fs.rmSync(tempStage, { recursive: true, force: true });
  }
}

async function main() {
  const opts = parseVerifyArgs(process.argv.slice(2));
  if (opts.help || !opts.prNumber) {
    console.log(
      [
        "用法：",
        "  node scripts/verify-pr.mjs <PR编号> [--wait-ci] [--no-install]",
        "  node scripts/verify-pr.mjs <PR编号> --non-runtime [--wait-ci]",
        "",
        "说明：",
        "  • 默认在隔离 worktree 合并最新 origin/main 并构建 ClaudeMom.app，交互式完成 Claude Desktop 实测后签收合入 main。",
        "  • --non-runtime 仅允许在 PR 未触碰 apps/、crates/、Cargo.* 等运行期文件时使用（仍强制跑完全量本地测试）。",
        "  • --wait-ci 自动轮询等待云端 ci-gate 完成后再开始本地验证。",
        "  • --no-install 实测通过后只签收合并 PR，不替换 /Applications/ClaudeMom.app。",
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
    throw new Error(`PR #${pr.number} 目标分支为 ${pr.baseRefName}，本脚本只签收合入 main 的 PR`);
  }

  console.log(`• 准备验收 PR #${pr.number}: ${pr.title}`);
  console.log(`  分支：${pr.headRefName} @ ${pr.headRefOid.slice(0, 12)} -> ${pr.baseRefName}`);

  if (!opts.localCi) {
    await ensureCiGatePassed(repo, pr, opts.waitCi);
  } else {
    console.log("• 已启用 --local-ci：将在隔离 worktree 中完整执行本地不变量与全量测试以替代云端 Actions Runner");
  }

  runInherit("git", ["fetch", "origin", "main", "upstream-main", `pull/${pr.number}/head`]);
  const latestPr = getPrInfo(repo, opts.prNumber);
  if (latestPr.headRefOid !== pr.headRefOid) {
    throw new Error(`PR #${pr.number} 在拉取期间有新提交 (${latestPr.headRefOid.slice(0, 7)})，请重新运行验收`);
  }

  const changedFiles = runCapture("git", ["diff", "--name-only", `origin/main...${pr.headRefOid}`])
    .split("\n")
    .filter(Boolean);
  const { requiresLiveAppTest, runtimeFiles } = classifyChangedFiles(changedFiles);

  if (opts.nonRuntime && requiresLiveAppTest) {
    throw new Error(
      `该 PR 修改了运行期/构建关键文件，禁止使用 --non-runtime 跳过真机实测：\n  - ${runtimeFiles.join("\n  - ")}`,
    );
  }

  const stamp = stampNow();
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), `claudemom-verify-pr${pr.number}-`));
  let worktreeAdded = false;

  try {
    runInherit("git", ["worktree", "add", "--detach", worktreeDir, "origin/main"]);
    worktreeAdded = true;

    // 在临时 worktree 预合并 PR，确保检验的是合入最新 main 后的真实产物
    runInherit(
      "git",
      ["merge", "--no-ff", "--no-edit", pr.headRefOid],
      worktreeDir,
      { ALLOW_MAIN_COMMIT: "1" },
    );

    runInherit(process.execPath, ["scripts/check-invariants.mjs"], worktreeDir);
    runInherit(process.execPath, ["--test", "scripts/check-invariants.test.mjs", "scripts/verify-pr.test.mjs", "scripts/sync-upstream.test.mjs"], worktreeDir);

    if (opts.nonRuntime) {
      runInherit(process.execPath, ["scripts/build-local.mjs", "--check-only"], worktreeDir);
      if (opts.localCi) {
        postCommitStatus(repo, pr.headRefOid, "success", `Local CI checks passed on macOS (${stamp})`, "ci-gate");
      }
      postCommitStatus(repo, pr.headRefOid, "success", `Non-runtime PR verified locally (${stamp})`);
    } else {
      runInherit(process.execPath, ["scripts/build-local.mjs"], worktreeDir);
      if (opts.localCi) {
        postCommitStatus(repo, pr.headRefOid, "success", `Local CI & release build passed on macOS (${stamp})`, "ci-gate");
      }
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
          postCommitStatus(repo, pr.headRefOid, "failure", `Local E2E failed: ${reason}`);
          if (!pr.isDraft) {
            runCapture("gh", ["pr", "ready", "--undo", String(pr.number), "--repo", repo]);
          }
          runCapture("gh", [
            "pr",
            "comment",
            String(pr.number),
            "--repo",
            repo,
            "--body",
            `### ❌ 本机真机实测未通过 (${stamp})\n\n- **提交**：\`${pr.headRefOid.slice(0, 12)}\`\n- **现象与原因**：${reason}\n\n请检出 \`${pr.headRefName}\` 分支修复并通过 \`node scripts/check-invariants.mjs\` 与 \`node scripts/build-local.mjs --check-only\` 后重新推送。`,
          ]);
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
          backupAndInstallApp(stagedBundle, pr.number, stamp);
          launchCleanApp("/Applications/ClaudeMom.app");
        }
        postCommitStatus(repo, pr.headRefOid, "success", `Local E2E verified on macOS (${stamp})`);
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

    if (!opts.nonRuntime) {
      const verifiedTag = `local/verified-${stamp}`;
      runInherit("git", ["tag", verifiedTag, "origin/main"]);
      runInherit("git", ["push", "origin", `refs/tags/${verifiedTag}`]);
      console.log(`✓ 已创建并推送实测回滚锚点标签：${verifiedTag}`);
    }

    console.log(`✓ PR #${pr.number} 已完成签收并合入 main！`);
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
