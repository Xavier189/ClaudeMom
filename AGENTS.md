# AGENTS.md — ClaudeMom 个人定制维护契约

本仓库（`Xavier189/ClaudeMom`）是 `BigPizzaV3/ClaudeMom` 的长期下游定制仓库。所有接入本仓库的 Coding Agent（Antigravity、Codex、Cursor、Claude Code、grokbot 等）执行任何修改、同步或审查任务时，必须遵守本文件定义的契约。

## 1. 分支与提交流程（硬门禁）

| 引用 | 角色 | 允许的操作 |
| --- | --- | --- |
| `main` | **个人长期黄金主线（默认分支）** | **禁止直推**。只接受通过 `ci-gate` 与本机实测 `local-verified` 双门禁的 **PR Merge Commit**（禁 Squash / Rebase，以保留与上游合并基点）。 |
| `upstream-main` | **原作者仓库干净镜像** | 只允许对 `BigPizzaV3/ClaudeMom:main` 执行 `--ff-only` 快进同步，绝不提交任何定制改动。 |
| `sync/upstream-main` | **自动上游同步 PR 分支** | 由 `.github/workflows/upstream-sync.yml` 自动生成或更新；出现冲突或测试红灯时，Agent 在此分支修复并推回 PR。 |
| `<type>/<topic>` | **功能与修复工作分支** | 所有新功能或缺陷修复一律从最新 `origin/main` 切出（如 `feat/xxx`、`fix/xxx`），完成后向 `main` 发起 PR。 |
| `local/verified-*` | **本机实测回滚锚点标签** | 仅在通过 `node scripts/verify-pr.mjs <PR>` 或本机实测签收后创建并显式推送。 |
| `v*` | **原作者公开发版标签** | **严禁**在个人 Fork 新建或推送（GitHub Ruleset 已在服务端封禁）。 |

## 2. Git 提交身份与隐私红线

1. **严禁暴露本机系统用户名、真实姓名、个人邮箱、公司邮箱或本机家目录路径（如 `/Users/<真实用户名>`）**。
2. 仓库内所有非上游提交的 `Author` 与 `Committer` 必须严格使用 GitHub 脱敏身份：
   - 维护者身份：`Xavier189 <63280269+Xavier189@users.noreply.github.com>`
   - 官方自动化/云端 Agent 身份：`* <*@users.noreply.github.com>` 或 `GitHub <noreply@github.com>`
3. 严禁将任何上游网关 Base URL、API Key、证书私钥或 `~/.claude-mom` 运行配置写入仓库、测试或 PR 描述。

## 3. 核心个人定制清单（合并上游时不得静默丢失）

`scripts/check-invariants.mjs` 会在本地钩子与 CI 中自动验证以下定制不变量。合并上游时：
- 若上游未原生覆盖该能力，必须保留对应行为与单测；
- 仅当确认上游已原生等价实现且回归测试覆盖完备时，才允许在同一 PR 中移除冗余定制并同步更新 `scripts/check-invariants.mjs`，同时在 PR 正文写明证据。

1. **模型展示名优先读取 `magpie_label`**（`apps/claude-mom/src-tauri/src/upstreams.rs`）：`parse_models` 按 `["magpie_label", "display_name"]` 顺序提取展示名。
2. **本地代理异常退出自恢复与状态澄清**（`crates/claude-local/src/backend.rs`、`apps/claude-mom/src/model.ts`）：`recover_exited_proxy` 在配置未变时单次原端口拉起已退出的代理，前端通过 `restartMessage` 区分连接异常与配置变更。
3. **合并池模型去锁与账单/分享接口兜底**（`crates/claude-local/runtime/proxy.mjs`）：`mergePoolModels` 通过 `stripModelLocks` 剥离免费录制模板的 `disabled` / `upgrade_required` 限制，并提供 `/shares` 与 `/api/billing/` 完整字段形状。
4. **托管模式启用本地主题渲染门控**（`crates/claude-local/runtime/proxy.mjs`）：`resolvedBootstrap` 调用 `enableLocalThemeRenderer` 注入 `THEME_RENDERER_FEATURE_IDS`。
5. **托管模式隐藏不可下载的云端示例 Skills**（`crates/claude-local/runtime/proxy.mjs`）：无录制目录的托管模式下 `skills` 接口返回 `{ skills: [] }`，`download-dot-skill-file` 返回明确 404 JSON。
6. **流式请求中断清理与关停销毁连接池**（`crates/claude-local/runtime/proxy.mjs`）：客户端提前断开时销毁 `upstreamReq`，`shutdown()` 时销毁 `directAgent` / `tunnelAgent`。

## 4. 标准验证命令

在推送分支或更新 PR 前，按当前环境能力依次执行：

```bash
# 1. 必跑：隐私身份、禁区与个人定制不变量检查 + 脚本单测（毫秒级，全平台可跑）
node scripts/check-invariants.mjs
node --test scripts/*.test.mjs

# 2. 代码改动必跑（macOS / 具备 Rust + Node 22 环境时）：前端 + Rust + Node 全套检查（不打包）
node scripts/build-local.mjs --check-only

# 3. 手动触发上游同步（云端 Actions 未启用或需立即检查时在本机运行）
node scripts/sync-upstream.mjs

# 4. 维护者本机最终签收并合入 main（云端 CI 绿灯后在本机终端执行；若云端 Runner 暂不可用可追加 --local-ci）
node scripts/verify-pr.mjs <PR编号>
```

## 5. 上游同步冲突/红灯修复SOP（供任意 Agent 执行）

当 `.github/workflows/upstream-sync.yml` 产生带 `[CONFLICT]` 或 `[CI FAILED]` 的 Draft PR 时：

1. 执行 `git fetch origin --prune && git fetch upstream --tags`（若无 `upstream` 远端则先添加只读 `https://github.com/BigPizzaV3/ClaudeMom.git`）。
2. 检出同步分支：`git switch -C sync/upstream-main origin/sync/upstream-main`。
3. 若分支尚未合并 `origin/main`（冲突回退态），执行 `git merge origin/main`（或基于 `origin/main` 重建并 `git merge origin/upstream-main`），对照第 3 节保留全部个人定制语义并解决冲突。
4. 运行第 4 节检查命令全部通过后，`git push origin sync/upstream-main`，等待云端 `ci-gate` 变绿后交由维护者在本机执行 `node scripts/verify-pr.mjs <PR编号>` 实测合入。

详细本机备份、回滚与 Claude Desktop 交互验收细则见 [docs/local-maintenance.md](docs/local-maintenance.md)。
