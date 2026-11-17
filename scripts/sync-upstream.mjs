#!/usr/bin/env node
/**
 * 上游仓库自动同步与预合并 PR 生成脚本（同时支持 GitHub Actions 云端定时与本机终端/launchd 运行）
 *
 * 用法：
 *   node scripts/sync-upstream.mjs [--dry-run] [--force-resync]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_UPSTREAM_URL = "https://github.com/BigPizzaV3/ClaudeMom.git";

export const HOT_CUSTOMIZED_FILES = [
  "apps/claude-mom/src-tauri/src/upstreams.rs",
  "apps/claude-mom/src/ClaudeMomApp.tsx",
  "apps/claude-mom/src/model.ts",
  "apps/claude-mom/src-tauri/tauri.conf.json",
  "crates/claude-local/runtime/proxy.mjs",
  "crates/claude-local/src/backend.rs",
];

export function parseSyncArgs(argv) {
  let dryRun = false;
  let forceResync = false;
  let help = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--force-resync") forceResync = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else throw new Error(`未知参数 "${arg}"；使用 --help 查看用法`);
  }
  return { dryRun, forceResync, help };
}

export function formatOverlapSection(hotFiles) {
  if (hotFiles.length === 0) {
    return "### ✅ 定制文件重叠检查\n上游本次未直接修改核心个人定制文件。";
  }
  return [
    "### ⚠️ 个人定制高敏感文件重叠提醒",
    "上游本次修改触碰了以下含个人定制的文件（即使无 Git 冲突也请重点核查语义兼容）：",
    ...hotFiles.map((f) => `- \`${f}\``),
  ].join("\n");
}

function capture(cmd, args, cwd = REPO_ROOT) {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryExec(cmd, args, cwd = REPO_ROOT, extraEnv = {}) {
  try {
    const out = execFileSync(cmd, args, {
      cwd,
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: String(err.stderr || err.message || "").trim() };
  }
}

function writeGithubOutputs(values) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const lines = Object.entries(values).map(([k, v]) => `${k}=${v}`);
  fs.appendFileSync(outPath, `${lines.join("\n")}\n`);
}

export function parseOriginRepoSlug(remoteUrl) {
  const match = remoteUrl.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`无法从 origin URL 解析 GitHub 仓库名：${remoteUrl}`);
  }
  return match[1];
}

function getRepoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  return parseOriginRepoSlug(capture("git", ["remote", "get-url", "origin"]));
}

function main() {
  const opts = parseSyncArgs(process.argv.slice(2));
  if (opts.help) {
    console.log("用法：node scripts/sync-upstream.mjs [--dry-run] [--force-resync]\n自动同步 BigPizzaV3/ClaudeMom:main 至 origin/upstream-main，并在有未合入更新时创建/更新 sync/upstream-main -> main 的预合并 PR。");
    return;
  }

  const upstreamUrl = process.env.UPSTREAM_REPO_URL || DEFAULT_UPSTREAM_URL;
  const repo = getRepoSlug();
  const inActions = process.env.GITHUB_ACTIONS === "true";
  const runUrl =
    inActions && process.env.GITHUB_SERVER_URL && process.env.GITHUB_RUN_ID
      ? `${process.env.GITHUB_SERVER_URL}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : "";

  if (!tryExec("git", ["remote", "get-url", "upstream"]).ok) {
    capture("git", ["remote", "add", "upstream", upstreamUrl]);
    capture("git", ["remote", "set-url", "--push", "upstream", "no_push"]);
  }

  capture("git", ["fetch", "upstream", "main", "--no-tags"]);
  capture("git", ["fetch", "origin", "main", "upstream-main"]);

  const upstreamSha = capture("git", ["rev-parse", "upstream/main"]);
  const upstreamShort = upstreamSha.slice(0, 7);
  const mirrorSha = capture("git", ["rev-parse", "origin/upstream-main"]);
  const mainSha = capture("git", ["rev-parse", "origin/main"]);

  console.log(`• 上游最新提交 (upstream/main)      : ${upstreamSha}`);
  console.log(`• 镜像当前提交 (origin/upstream-main): ${mirrorSha}`);
  console.log(`• 个人主线提交 (origin/main)         : ${mainSha}`);

  // 1. 快进更新镜像分支 origin/upstream-main
  if (mirrorSha !== upstreamSha) {
    if (!tryExec("git", ["merge-base", "--is-ancestor", mirrorSha, upstreamSha]).ok) {
      throw new Error(`上游 main 发生了非快进历史改写 (${mirrorSha.slice(0, 7)} -> ${upstreamShort})，拒绝自动覆盖 upstream-main，请人工核查。`);
    }
    if (opts.dryRun) {
      console.log(`[dry-run] 将快进推送 origin/upstream-main: ${mirrorSha.slice(0, 7)} -> ${upstreamShort}`);
    } else {
      capture("git", ["push", "origin", `${upstreamSha}:refs/heads/upstream-main`]);
      console.log(`✓ 已快进更新 origin/upstream-main -> ${upstreamShort}`);
    }
  } else {
    console.log(`✓ origin/upstream-main 已与上游保持一致 (${upstreamShort})`);
  }

  // 2. 若 main 已包含最新上游提交，直接结束
  if (tryExec("git", ["merge-base", "--is-ancestor", upstreamSha, mainSha]).ok) {
    console.log(`✓ origin/main 已包含上游最新提交 (${upstreamShort})，无需创建同步 PR。`);
    if (!opts.dryRun) {
      const existingRaw = capture("gh", ["pr", "list", "--repo", repo, "--head", "sync/upstream-main", "--base", "main", "--state", "open", "--json", "number"]);
      const existing = JSON.parse(existingRaw || "[]");
      if (existing.length > 0) {
        capture("gh", [
          "pr",
          "close",
          String(existing[0].number),
          "--repo",
          repo,
          "--comment",
          `上游提交 \`${upstreamShort}\` 已包含在 \`main\` 中，自动关闭已过期的同步 PR。`,
          "--delete-branch",
        ]);
      }
    }
    writeGithubOutputs({ needs_ci: "false" });
    return;
  }

  // 3. 幂等保护：若已有包含该上游提交的打开 PR，默认不覆盖（保护正在进行的 Agent 修复）
  const openPrs = JSON.parse(
    capture("gh", ["pr", "list", "--repo", repo, "--head", "sync/upstream-main", "--base", "main", "--state", "open", "--json", "number,headRefOid,isDraft"]) || "[]",
  );
  const existingPr = openPrs[0] || null;
  if (existingPr && !opts.forceResync) {
    tryExec("git", ["fetch", "origin", "refs/heads/sync/upstream-main"]);
    if (tryExec("git", ["merge-base", "--is-ancestor", upstreamSha, existingPr.headRefOid]).ok) {
      console.log(`• PR #${existingPr.number} 已包含上游提交 ${upstreamShort} (${existingPr.headRefOid.slice(0, 7)})，跳过重建以保护现有同步分支。`);
      writeGithubOutputs({
        needs_ci: "false",
        pr_number: String(existingPr.number),
        pr_head_sha: existingPr.headRefOid,
      });
      return;
    }
  }

  const commitLog = capture("git", ["log", "--oneline", "-n", "40", `${mainSha}..${upstreamSha}`]);
  const mergeBase = capture("git", ["merge-base", mainSha, upstreamSha]);
  const hotFiles = capture("git", ["diff", "--name-only", `${mergeBase}..${upstreamSha}`, "--", ...HOT_CUSTOMIZED_FILES])
    .split("\n")
    .filter(Boolean);
  const overlapSection = formatOverlapSection(hotFiles);

  // 4. 在隔离临时 worktree 中执行合并试探，绝不污染本机当前工作区
  const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "claudemom-upstream-sync-"));
  let worktreeAdded = false;
  try {
    capture("git", ["worktree", "add", "--detach", worktreeDir, mainSha]);
    worktreeAdded = true;

    const mergeEnv = inActions
      ? {
          ALLOW_MAIN_COMMIT: "1",
          GIT_AUTHOR_NAME: "github-actions[bot]",
          GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
          GIT_COMMITTER_NAME: "github-actions[bot]",
          GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
        }
      : { ALLOW_MAIN_COMMIT: "1" };

    const mergeAttempt = tryExec(
      "git",
      ["merge", "--no-edit", "-m", `chore(sync): merge upstream/main (${upstreamShort}) into main`, upstreamSha],
      worktreeDir,
      mergeEnv,
    );

    if (opts.dryRun) {
      if (mergeAttempt.ok) {
        console.log(`[dry-run] 预合并无冲突！将推送 sync/upstream-main 并创建/更新指向 main 的同步 PR。`);
      } else {
        const conflicts = capture("git", ["diff", "--name-only", "--diff-filter=U"], worktreeDir);
        tryExec("git", ["merge", "--abort"], worktreeDir);
        console.log(`[dry-run] 预合并存在冲突，将创建 [CONFLICT] 草稿 PR。冲突文件：\n${conflicts}`);
      }
      return;
    }

    const bodyFile = path.join(worktreeDir, ".sync-pr-body.md");
    if (mergeAttempt.ok) {
      const prHeadSha = capture("git", ["rev-parse", "HEAD"], worktreeDir);
      capture("git", ["push", "--force", "origin", `${prHeadSha}:refs/heads/sync/upstream-main`], worktreeDir);

      const title = `chore(sync): 同步上游 main (${upstreamShort})`;
      const body = [
        `## 自动上游同步预合并 (\`${upstreamShort}\`)`,
        "",
        `- **上游源提交**：[\`${upstreamShort}\`](https://github.com/BigPizzaV3/ClaudeMom/commit/${upstreamSha})`,
        `- **合并状态**：✅ Git 自动合并无冲突`,
        "",
        "### 本次纳入的上游提交",
        "```text",
        commitLog,
        "```",
        "",
        overlapSection,
        "",
        "### 本机实测与合入门禁",
        "确认检查通过后，在本机终端执行以下命令完成打包、Claude Desktop 真机实测并自动合入 `main`：",
        "```bash",
        "node scripts/verify-pr.mjs <PR编号>",
        "```",
      ].join("\n");
      fs.writeFileSync(bodyFile, body);

      let prNum;
      if (existingPr) {
        capture("gh", ["pr", "edit", String(existingPr.number), "--repo", repo, "--title", title, "--body-file", bodyFile]);
        tryExec("gh", ["pr", "ready", String(existingPr.number), "--repo", repo]);
        prNum = existingPr.number;
      } else {
        const prUrl = capture("gh", ["pr", "create", "--repo", repo, "--base", "main", "--head", "sync/upstream-main", "--title", title, "--body-file", bodyFile]);
        prNum = Number(prUrl.split("/").pop());
      }

      if (inActions) {
        const statusArgs = [
          "api",
          "-X",
          "POST",
          `repos/${repo}/statuses/${prHeadSha}`,
          "-f",
          "state=pending",
          "-f",
          "context=ci-gate",
          "-f",
          "description=Running cross-platform CI and personal invariants check...",
        ];
        if (runUrl) statusArgs.push("-f", `target_url=${runUrl}`);
        capture("gh", statusArgs);
      }

      writeGithubOutputs({
        needs_ci: "true",
        pr_head_sha: prHeadSha,
        pr_number: String(prNum),
      });
      console.log(`✓ 已创建/更新无冲突同步 PR #${prNum} (${prHeadSha.slice(0, 7)})`);
    } else {
      const conflictFiles = capture("git", ["diff", "--name-only", "--diff-filter=U"], worktreeDir)
        .split("\n")
        .filter(Boolean);
      tryExec("git", ["merge", "--abort"], worktreeDir);
      capture("git", ["push", "--force", "origin", `${upstreamSha}:refs/heads/sync/upstream-main`], worktreeDir);

      const title = `chore(sync): [CONFLICT] 同步上游 main (${upstreamShort}) 存在合并冲突`;
      const body = [
        `## ⚠️ 自动上游同步检测到 Git 合并冲突 (\`${upstreamShort}\`)`,
        "",
        `- **上游源提交**：[\`${upstreamShort}\`](https://github.com/BigPizzaV3/ClaudeMom/commit/${upstreamSha})`,
        `- **合并状态**：❌ 存在代码冲突，已拦截合并并转为草稿 PR`,
        "",
        "### 冲突文件清单",
        ...conflictFiles.map((f) => `- \`${f}\``),
        "",
        "### 本次上游提交",
        "```text",
        commitLog,
        "```",
        "",
        overlapSection,
        "",
        "### 🤖 可直接复制给任意 Coding Agent（Antigravity / Codex / Cursor / grokbot）的修复指令",
        "```text",
        "请阅读仓库根目录 AGENTS.md，修复上游同步 PR 分支 sync/upstream-main 与 origin/main 的合并冲突：",
        "1. git fetch origin --prune && git switch -C sync/upstream-main origin/main",
        `2. git merge origin/upstream-main（冲突文件：${conflictFiles.join(" ")}）`,
        "3. 对照 AGENTS.md 第 3 节保留全部个人定制逻辑与测试，解决冲突并完成 merge commit（确保提交身份符合 AGENTS.md 脱敏规范）",
        "4. 运行 node scripts/check-invariants.mjs 与 node scripts/build-local.mjs --check-only 全部通过后，执行 git push --force-with-lease origin sync/upstream-main",
        "```",
      ].join("\n");
      fs.writeFileSync(bodyFile, body);

      let prNum;
      if (existingPr) {
        capture("gh", ["pr", "edit", String(existingPr.number), "--repo", repo, "--title", title, "--body-file", bodyFile]);
        tryExec("gh", ["pr", "ready", "--undo", String(existingPr.number), "--repo", repo]);
        prNum = existingPr.number;
      } else {
        const prUrl = capture("gh", ["pr", "create", "--draft", "--repo", repo, "--base", "main", "--head", "sync/upstream-main", "--title", title, "--body-file", bodyFile]);
        prNum = Number(prUrl.split("/").pop());
      }

      if (inActions) {
        const statusArgs = [
          "api",
          "-X",
          "POST",
          `repos/${repo}/statuses/${upstreamSha}`,
          "-f",
          "state=failure",
          "-f",
          "context=ci-gate",
          "-f",
          "description=Merge conflict with main — resolve on sync/upstream-main",
        ];
        if (runUrl) statusArgs.push("-f", `target_url=${runUrl}`);
        capture("gh", statusArgs);
      }

      writeGithubOutputs({
        needs_ci: "false",
        pr_head_sha: upstreamSha,
        pr_number: String(prNum),
      });
      console.log(`⚠️ 已创建/更新冲突草稿 PR #${prNum}`);
    }
  } finally {
    if (worktreeAdded) {
      tryExec("git", ["worktree", "remove", "--force", worktreeDir]);
    } else {
      fs.rmSync(worktreeDir, { recursive: true, force: true });
    }
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
