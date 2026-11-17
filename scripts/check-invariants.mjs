#!/usr/bin/env node
/**
 * 仓库不变量守卫（Harness Invariants Checker）
 *
 * 用法：
 *   node scripts/check-invariants.mjs            # 全量检查（CI 与本地门禁）
 *   node scripts/check-invariants.mjs --staged   # 暂存区与当前 Git 身份快速检查（pre-commit 钩子）
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const ALLOWED_HUMAN_LOGINS = new Set(["xavier189"]);
const ALLOWED_HUMAN_NAMES = new Set(["Xavier189", "Xavier"]);
const NOREPLY_IDENTITY_RE = /^([A-Za-z0-9-]+(?:\[bot\])?) <(?:\d+\+)?([A-Za-z0-9-]+(?:\[bot\])?)@users\.noreply\.github\.com>$/;
const GITHUB_WEB_FLOW_RE = /^GitHub <noreply@github\.com>$/;

const ALLOWED_MACOS_FIXTURE_USERS = new Set(["dana", "mac", "example", "user", "yourname"]);
const SECRET_PATTERNS = [
  { id: "Anthropic API Key", regex: /\bsk-ant-[A-Za-z0-9_-]{12,}/ },
  { id: "GitHub Classic Token", regex: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { id: "GitHub Fine-Grained PAT", regex: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { id: "Private Key PEM", regex: /^\s*-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s*$/ },
];

export function validateGitIdentity(ident) {
  const trimmed = ident.trim();
  if (GITHUB_WEB_FLOW_RE.test(trimmed)) return { ok: true };
  const match = trimmed.match(NOREPLY_IDENTITY_RE);
  if (!match) {
    return {
      ok: false,
      reason: `身份 "${trimmed}" 未使用 GitHub 官方脱敏邮箱 (*@users.noreply.github.com)`,
    };
  }
  const [, name, emailLogin] = match;
  const isBot = name.endsWith("[bot]") && emailLogin.toLowerCase() === name.toLowerCase();
  if (isBot) return { ok: true };
  if (!ALLOWED_HUMAN_NAMES.has(name) || !ALLOWED_HUMAN_LOGINS.has(emailLogin.toLowerCase())) {
    return {
      ok: false,
      reason: `非白名单 GitHub 提交身份 "${trimmed}"（仅允许 Xavier189/Xavier noreply 或官方 *[bot] 身份）`,
    };
  }
  return { ok: true };
}

export function scanLineForLeaks(line) {
  for (const { id, regex } of SECRET_PATTERNS) {
    if (regex.test(line)) {
      return `检测到疑似凭证 (${id})`;
    }
  }
  const userPathMatches = line.matchAll(/\/Users\/([A-Za-z0-9._-]+)\//g);
  for (const match of userPathMatches) {
    const username = match[1];
    if (!ALLOWED_MACOS_FIXTURE_USERS.has(username.toLowerCase())) {
      return `检测到本机绝对路径泄露 (/Users/${username}/...)，请改用相对路径或 $HOME`;
    }
  }
  return null;
}

export const PERSONAL_INVARIANTS = [
  {
    id: "INV-CUSTOM-01",
    title: "模型展示名优先读取 magpie_label",
    file: "apps/claude-mom/src-tauri/src/upstreams.rs",
    mustContain: ['["magpie_label", "display_name"]'],
    fix: "检查 apps/claude-mom/src-tauri/src/upstreams.rs 的 parse_models，确保优先读取 magpie_label 再回退 display_name。",
  },
  {
    id: "INV-CUSTOM-02",
    title: "本地代理异常退出单次自恢复与前端状态澄清",
    file: "crates/claude-local/src/backend.rs",
    mustContain: ["fn recover_exited_proxy", "auto_recovered"],
    fix: "检查 crates/claude-local/src/backend.rs 的 recover_exited_proxy 自恢复逻辑是否在上游合并时被误删。",
  },
  {
    id: "INV-CUSTOM-02B",
    title: "前端重启提示文案区分连接状态与配置变更",
    file: "apps/claude-mom/src/model.ts",
    mustContain: ["export function restartMessage"],
    fix: "检查 apps/claude-mom/src/model.ts 的 restartMessage 及其在 ClaudeMomApp.tsx 中的调用。",
  },
  {
    id: "INV-CUSTOM-03",
    title: "合并池模型剥离免费模板套餐锁并兜底账单/分享形状",
    file: "crates/claude-local/runtime/proxy.mjs",
    mustContain: ["function stripModelLocks", "MODEL_LOCK_FIELDS", "taxDisplay:", "/shares$"],
    fix: "检查 crates/claude-local/runtime/proxy.mjs 的 mergePoolModels 去锁逻辑及 /shares、/api/billing/ 响应字段。",
  },
  {
    id: "INV-CUSTOM-04",
    title: "本地托管模式开启官方主题渲染门控",
    file: "crates/claude-local/runtime/proxy.mjs",
    mustContain: ["THEME_RENDERER_FEATURE_IDS", "enableLocalThemeRenderer(result)"],
    fix: "检查 crates/claude-local/runtime/proxy.mjs 的 resolvedBootstrap 是否仍调用 enableLocalThemeRenderer(result)。",
  },
  {
    id: "INV-CUSTOM-05",
    title: "本地托管模式隐藏不可下载的云端示例 Skills",
    file: "crates/claude-local/runtime/proxy.mjs",
    mustContain: ['slug === "skills" && runtime.managed && !runtime.recordedDir', "Cloud skill archive is unavailable in local mode"],
    fix: "检查 crates/claude-local/runtime/proxy.mjs 对托管模式云端 skills 空列表与 404 下载提示的处理。",
  },
  {
    id: "INV-CUSTOM-06",
    title: "流式连接中断销毁与关停连接池释放",
    file: "crates/claude-local/runtime/proxy.mjs",
    mustContain: ["directAgent.destroy()", "upstreamReq.destroy()"],
    fix: "检查 crates/claude-local/runtime/proxy.mjs 在响应关闭及 shutdown() 时的连接销毁逻辑。",
  },
  {
    id: "INV-FORK-01",
    title: "发版脚本具备个人 Fork 防误触保护",
    file: "scripts/release.mjs",
    mustContain: ["ALLOW_FORK_RELEASE", "BigPizzaV3/ClaudeMom"],
    fix: "确保 scripts/release.mjs 保留非原作者仓库拦截逻辑，避免误推 v* 标签。",
  },
];

const GOVERNANCE_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".githooks/pre-commit",
  ".github/workflows/ci.yml",
  ".github/workflows/upstream-sync.yml",
  "scripts/sync-upstream.mjs",
  "scripts/verify-pr.mjs",
];

function git(args, cwd = REPO_ROOT) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function tryGit(args, cwd = REPO_ROOT) {
  try {
    return { ok: true, out: git(args, cwd) };
  } catch {
    return { ok: false, out: "" };
  }
}

function checkCurrentGitVarIdentities(errors, cwd = REPO_ROOT) {
  for (const variable of ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"]) {
    const raw = git(["var", variable], cwd);
    // git var format: "Name <email> 1700000000 +0800"
    const ident = raw.replace(/\s+\d+\s+[+-]\d{4}$/, "");
    const check = validateGitIdentity(ident);
    if (!check.ok) {
      errors.push(
        `[INV-ID-LOCAL] 当前 ${variable} 不合规：${check.reason}\n` +
          `  修复方法：确认仓库位于已配置 includeIf 的目录下，或执行：\n` +
          `    git config user.name "Xavier189"\n` +
          `    git config user.email "63280269+Xavier189@users.noreply.github.com"`,
      );
    }
  }
}

function checkStagedDiff(errors, cwd = REPO_ROOT) {
  const diff = git(["diff", "--cached", "--unified=0", "--no-color"], cwd);
  let currentFile = "(unknown)";
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const issue = scanLineForLeaks(line.slice(1));
    if (issue) {
      errors.push(`[INV-SECRET-STAGED] ${currentFile}: ${issue}`);
    }
  }
}

function resolveUpstreamExcludeRef(cwd = REPO_ROOT) {
  for (const candidate of ["refs/remotes/origin/upstream-main", "refs/remotes/upstream/main", "refs/heads/upstream-main"]) {
    if (tryGit(["rev-parse", "--verify", "--quiet", candidate], cwd).ok) {
      return candidate;
    }
  }
  return null;
}

export function runAllChecks({ cwd = REPO_ROOT, stagedOnly = false } = {}) {
  const errors = [];

  if (stagedOnly) {
    checkCurrentGitVarIdentities(errors, cwd);
    checkStagedDiff(errors, cwd);
    return errors;
  }

  // 1. 历史 Fork 提交身份审计（排除上游镜像分支已有的原作者/社区提交）
  const upstreamRef = resolveUpstreamExcludeRef(cwd);
  const revArgs = upstreamRef ? ["log", "--format=%H|%an <%ae>|%cn <%ce>|%s", "HEAD", `^${upstreamRef}`] : ["log", "-n", "20", "--format=%H|%an <%ae>|%cn <%ce>|%s", "HEAD"];
  const commitLines = git(revArgs, cwd).split("\n").filter(Boolean);
  for (const entry of commitLines) {
    const [sha, author, committer, subject] = entry.split("|");
    for (const [role, ident] of [
      ["Author", author],
      ["Committer", committer],
    ]) {
      const res = validateGitIdentity(ident);
      if (!res.ok) {
        errors.push(
          `[INV-ID-COMMIT] 提交 ${sha.slice(0, 7)} (${subject}) 的 ${role} 不合规：${res.reason}\n` +
            `  修复方法：使用 git commit --amend --reset-author 或 rebase 重写该提交为：\n` +
            `    Xavier189 <63280269+Xavier189@users.noreply.github.com>`,
        );
      }
    }
  }

  // 2. 全仓受控文本文件泄露扫描
  const trackedFiles = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8" }).split("\0").filter(Boolean);
  for (const relPath of trackedFiles) {
    const fullPath = path.join(cwd, relPath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;
    const buf = fs.readFileSync(fullPath);
    if (buf.includes(0)) continue; // skip binary files
    const lines = buf.toString("utf8").split("\n");
    for (let idx = 0; idx < lines.length; idx += 1) {
      const issue = scanLineForLeaks(lines[idx]);
      if (issue) {
        errors.push(`[INV-LEAK-FILE] ${relPath}:${idx + 1}: ${issue}`);
      }
    }
  }

  // 3. 个人定制不变量检查
  for (const inv of PERSONAL_INVARIANTS) {
    const target = path.join(cwd, inv.file);
    if (!fs.existsSync(target)) {
      errors.push(`[${inv.id}] 缺失关键文件 ${inv.file}（${inv.title}）\n  修复指引：${inv.fix}`);
      continue;
    }
    const content = fs.readFileSync(target, "utf8");
    const missing = inv.mustContain.filter((snippet) => !content.includes(snippet));
    if (missing.length > 0) {
      errors.push(
        `[${inv.id}] 定制不变量被破坏：${inv.title} (${inv.file})\n` +
          `  缺失特征片段：${missing.map((s) => JSON.stringify(s)).join(", ")}\n` +
          `  修复指引：${inv.fix}`,
      );
    }
  }

  // 4. 多 Agent 治理基础设施完整性检查
  for (const govFile of GOVERNANCE_FILES) {
    const fullPath = path.join(cwd, govFile);
    if (!fs.existsSync(fullPath)) {
      errors.push(`[INV-GOV-01] 缺失治理或自动化文件：${govFile}（详见 AGENTS.md）`);
    }
  }
  const claudeMdPath = path.join(cwd, "CLAUDE.md");
  if (fs.existsSync(claudeMdPath)) {
    const claudeContent = fs.readFileSync(claudeMdPath, "utf8").trim();
    const agentsContent = fs.existsSync(path.join(cwd, "AGENTS.md")) ? fs.readFileSync(path.join(cwd, "AGENTS.md"), "utf8").trim() : "";
    if (claudeContent !== agentsContent && claudeContent !== "AGENTS.md") {
      errors.push(`[INV-GOV-02] CLAUDE.md 与 AGENTS.md 内容不一致；请保持 CLAUDE.md 软链指向 AGENTS.md。`);
    }
  }

  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stagedOnly = process.argv.includes("--staged");
  const errors = runAllChecks({ stagedOnly });
  if (errors.length > 0) {
    console.error(`\n✗ 仓库不变量检查未通过（共 ${errors.length} 项）：\n`);
    for (const err of errors) {
      console.error(`  • ${err}\n`);
    }
    process.exit(1);
  }
  console.log(stagedOnly ? "✓ 暂存区与提交身份检查通过" : `✓ 全部仓库不变量检查通过（已核验 ${PERSONAL_INVARIANTS.length} 项个人定制契约与提交隐私门禁）`);
}
