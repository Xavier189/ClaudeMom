# AGENTS.md — ClaudeMom 个人定制维护契约

本仓库（`Xavier189/ClaudeMom`）是 `BigPizzaV3/ClaudeMom` 的长期下游定制仓库（已关闭 GitHub Actions 云端流水线，统一采用 **最简 PR 门禁 + grokbot / 本机拉取验证后 Merge** 机制）。所有接入本仓库的 Coding Agent（grokbot、Antigravity、Codex、Cursor、Claude Code 等）执行任务时必须遵守本契约。

## 1. 分支与提交流程（服务端 Ruleset 硬门禁）

| 引用 | 角色 | 允许的操作 |
| --- | --- | --- |
| `main` | **个人长期黄金主线（默认分支）** | **禁止直推与强推**。仅允许通过 PR 在完成验证后以 **Merge Commit** 合入（已禁用 Squash / Rebase，以保留与上游的合并基点）。 |
| `upstream-main` | **原作者仓库干净镜像** | 只允许对 `BigPizzaV3/ClaudeMom:main` 执行 `--ff-only` 快进同步，绝不提交任何定制改动。 |
| `sync/upstream-main` | **自动上游同步 PR 分支** | 由 `node scripts/sync-upstream.mjs` 自动生成或更新；出现冲突或验证红灯时，Agent 在此分支修复并推回 PR。 |
| `<type>/<topic>` | **功能与修复工作分支** | 所有新功能或缺陷修复一律从最新 `origin/main` 切出（如 `feat/xxx`、`fix/xxx`），完成后向 `main` 发起 PR。 |
| `local/verified-*` | **本机实测回滚锚点标签** | 在本机完成真机交互实测后打标并显式推送到 `origin`。 |
| `v*` | **原作者公开发版标签** | **严禁**在个人 Fork 新建或推送（GitHub Ruleset 已在服务端封禁）。 |

## 2. 平台范围与 Git 隐私红线

1. **专注 macOS 平台（暂不考虑 Windows）**：本 Fork 的开发、测试、打包与验收均只面向 macOS。开发个人定制功能时无需编写 Windows 适配；对于上游源码中已有的 `#[cfg(windows)]` / `win32` 分支，保持原样不主动删除，以避免同步上游时产生无意义的合并冲突。
2. **严禁暴露本机系统用户名、真实姓名、个人邮箱、公司邮箱或本机家目录路径（如 `/Users/<真实用户名>`）**。
3. 仓库内所有非上游提交的 `Author` 与 `Committer` 必须严格使用 GitHub 脱敏身份：
   - 维护者身份：`Xavier189 <63280269+Xavier189@users.noreply.github.com>`（PR Merge Commit 允许主页名 `Xavier` + 同邮箱）
   - 官方自动化/Agent 身份：`* <*@users.noreply.github.com>` 或 `GitHub <noreply@github.com>`
4. 严禁将任何上游网关 Base URL、API Key、证书私钥或 `~/.claude-mom` 运行配置写入仓库、测试或 PR 描述。

## 3. 核心个人定制清单（合并上游时不得静默丢失）

`scripts/check-invariants.mjs` 会在本地钩子与验证流程中自动核验以下定制不变量。合并上游时若上游未原生覆盖该能力，必须保留对应行为与单测；仅当确认上游已原生等价实现且回归测试完备时，才允许在同一 PR 中移除冗余定制并同步更新 `scripts/check-invariants.mjs`：

1. **模型展示名优先读取 `magpie_label`**（`apps/claude-mom/src-tauri/src/upstreams.rs`）：`parse_models` 按 `["magpie_label", "display_name"]` 顺序提取展示名。
2. **本地代理异常退出自恢复与状态澄清**（`crates/claude-local/src/backend.rs`、`apps/claude-mom/src/model.ts`）：`recover_exited_proxy` 在配置未变时单次原端口拉起已退出的代理，前端通过 `restartMessage` 区分连接异常与配置变更。
3. **合并池模型去锁扩展与账单/分享接口兜底**（`crates/claude-local/runtime/runtime.mjs`、`crates/claude-local/runtime/proxy.mjs`）：上游 `v0.1.8`（#21）已将 `mergePoolModels` 与 `clearModelGates` 迁入 `runtime.mjs`，个人分支在 `runtime.mjs` 保留 `isUnlockedTemplateModel` 模板优选、`structuredClone` 深拷贝、`required_plan` 剥离及命中池内模型的 `minimum_tier = "free"` 重置，并在 `proxy.mjs` 提供 `/shares` 与 `/api/billing/` 完整字段形状。
4. **托管模式启用本地主题渲染门控**（`crates/claude-local/runtime/proxy.mjs`）：`resolvedBootstrap` 调用 `enableLocalThemeRenderer` 注入 `THEME_RENDERER_FEATURE_IDS`。
5. **托管模式隐藏不可下载的云端示例 Skills**（`crates/claude-local/runtime/proxy.mjs`）：无录制目录的托管模式下 `skills` 接口返回 `{ skills: [] }`，`download-dot-skill-file` 返回明确 404 JSON。
6. **流式请求中断清理与关停销毁连接池**（`crates/claude-local/runtime/proxy.mjs`）：客户端提前断开时销毁 `upstreamReq`，`shutdown()` 时销毁 `directAgent` / `tunnelAgent`。

## 4. 标准自动化与验证命令（grokbot / Agent / 本机通用）

```bash
# 1. 拉取上游更新：快进更新 origin/upstream-main，并在有新提交时自动创建/更新 sync/upstream-main -> main PR
node scripts/sync-upstream.mjs

# 2. 提交或推分支前必跑：隐私身份、禁区与个人定制不变量检查 + 脚本单测
node scripts/check-invariants.mjs
node --test scripts/*.test.mjs

# 3. grokbot / 自动化 Agent 拉取待审 PR 验证并合入 main（隔离 worktree 预合并 + 全量测试，通过则自动 Merge，失败自动转草稿并留言）
node scripts/verify-pr.mjs <PR编号> --auto        # 仅验证不合并可改用 --check-only

# 4. 维护者本机打包 .app + Claude Desktop 真机交互实测签收合入（自动备份安装并推送 local/verified-* 标签）
node scripts/verify-pr.mjs <PR编号>
```

## 5. 上游同步冲突或验证失败修复 SOP

当 `sync-upstream.mjs` 或 `verify-pr.mjs --auto` 产生带 `[CONFLICT]` 或失败留言的草稿 PR 时：

1. 执行 `git fetch origin --prune && git fetch upstream --no-tags`（若无 `upstream` 远端则添加只读 `https://github.com/BigPizzaV3/ClaudeMom.git`）。
2. 基于最新主线检出同步分支：`git switch -C sync/upstream-main origin/main && git merge origin/upstream-main`（若是普通功能 PR，则检出对应分支并 `git merge origin/main`）。
3. 对照第 3 节保留全部个人定制语义解决冲突或修复报错，确保提交身份合规。
4. 运行 `node scripts/check-invariants.mjs && node scripts/build-local.mjs --check-only` 通过后推送回该 PR 分支，再执行 `node scripts/verify-pr.mjs <PR编号> --auto`（或交由本机真机实测）合入 `main`。

详细本机备份、回滚与 Claude Desktop 交互验收细则见 [docs/local-maintenance.md](docs/local-maintenance.md)。
