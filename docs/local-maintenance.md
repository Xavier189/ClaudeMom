# ClaudeMom 个人 Fork 维护与本地打包指南

本手册规定个人 Fork（`Xavier189/ClaudeMom`）与作者上游仓库（`BigPizzaV3/ClaudeMom`）之间的分支门禁、自动上游同步、多 Agent 开发、本机真机实测签收及回滚规则。
在 macOS 上构建并安装 `main` 分支需要 Node.js 22+、npm、Rust 工具链和 Xcode Command Line Tools。

该流程只向个人 Fork 推送经脱敏身份提交的源码与 `local/verified-*` 本地验证标签，不修改作者上游仓库，也不产出带 Apple 公证签名或自动更新元数据的公开发行包。

## 远端、分支与门禁约定

| 远端名 | 仓库地址 | 用途与推送限制 |
| --- | --- | --- |
| `origin` | `git@github.com:Xavier189/ClaudeMom.git` | 个人 Fork，托管默认黄金主线 `main`、上游干净镜像 `upstream-main` 与 `local/verified-*` 标签 |
| `upstream` | `https://github.com/BigPizzaV3/ClaudeMom.git` | 作者上游仓库，只拉取更新；本地将 `pushurl` 设为 `no_push` 以防误推 |

| 引用名 | 类型 | 规则与用途 |
| --- | --- | --- |
| `main` | 默认主分支 | **个人长期黄金主线**；服务端开启 Ruleset 禁止直推与强推，必须经 PR 通过 `ci-gate` 与 `local-verified` 双状态检查后以 Merge Commit 合入 |
| `upstream-main` | 镜像分支 | **作者上游干净镜像**；服务端禁止强推与删除，仅通过 `--ff-only` 同步 `upstream/main`，不在该分支提交任何个人改动 |
| `sync/upstream-main` | 同步分支 | 由 [upstream-sync.yml](../.github/workflows/upstream-sync.yml) 自动维护的上游同步 PR 分支 |
| `local/verified-YYYYMMDD-HHMMSS` | 标签 | 本机完成真机交互验收并合入 `main` 后的回退锚点标签 |
| `v*`（例如 `v0.1.7`） | 标签 | 上游发版标签；服务端 Ruleset 已封禁在个人 Fork 创建或更新 `v*` 标签，防止误触发 [release.yml](../.github/workflows/release.yml) |

## 检查或初始化仓库远端与本地钩子

在另一台机器克隆仓库或排查配置是否偏移时，先运行以下初始化：

```bash
git remote -v
git branch -vv
git config core.hooksPath .githooks
```

根据输出按对应条件补齐远端：

- **从个人 Fork 克隆仓库且缺少 `upstream` 时**：添加只读上游远端并拉取上游分支。

  ```bash
  git remote add upstream https://github.com/BigPizzaV3/ClaudeMom.git
  git remote set-url --push upstream no_push
  git fetch upstream --tags
  git fetch origin --prune
  ```

- **核对提交脱敏身份**：确认 `git config user.name` 为 `Xavier189` 且 `user.email` 为 `63280269+Xavier189@users.noreply.github.com`（本地 `.githooks/pre-commit` 与云端 [check-invariants.mjs](../scripts/check-invariants.mjs) 均会强制拦截私人用户名或公司邮箱）。

## 自动上游同步与 PR 签收工作流

### 1. 自动发现与预合并（云端每日执行 + 支持手动触发）

[.github/workflows/upstream-sync.yml](../.github/workflows/upstream-sync.yml) 每天北京时间 09:17 自动运行（也可执行 `gh workflow run upstream-sync.yml` 立即触发）：

1. 自动将 `origin/upstream-main` 快进更新至 `BigPizzaV3/ClaudeMom:main`。
2. 若 `main` 尚未包含最新上游提交，在 `sync/upstream-main` 尝试合并 `origin/main` 与最新上游：
   - **无冲突**：自动发起/更新指向 `main` 的同步 PR，立即调用 [ci.yml](../.github/workflows/ci.yml) 执行双平台编译测试与个人定制不变量检查，汇总写入 `ci-gate` 状态。
   - **发生 Git 冲突或 CI 失败**：自动将同步 PR 转为草稿（标题带 `[CONFLICT]` 或 `[CI FAILED]`），并在 PR 中附上冲突清单与可直接复制给任一 Coding Agent 的修复提示词。

### 2. 多 Agent 日常开发与冲突修复

所有接入本仓库的 Coding Agent（Antigravity、Codex、Cursor、Claude Code、grokbot 等）共享根目录 [AGENTS.md](../AGENTS.md)（`CLAUDE.md` 软链同源）：

```bash
# 新开发或修复一律从最新 main 切分支
git fetch origin main
git switch -c feat/<topic> origin/main

# 提交前执行不变量与全套本地检查
node scripts/check-invariants.mjs
node scripts/build-local.mjs --check-only

# 推送并创建指向 main 的 PR
git push -u origin HEAD
gh pr create --base main --fill
```

### 3. 本机一键真机实测签收（唯一合入 `main` 的放行通道）

当任意 PR（上游同步 PR 或 Agent 功能 PR）的云端 `ci-gate` 变绿后，在本机运行：

```bash
node scripts/verify-pr.mjs <PR编号>
```

脚本会在隔离的临时 `git worktree` 中将 PR 预合入最新 `origin/main`，跑完 `check-invariants.mjs` 与 `build-local.mjs` 生成待测 `ClaudeMom.app`，先不覆盖已安装版本而直接启动待测实例供真机验证：

- 输入 `pass`：自动备份 `~/.claude-mom` 与旧 `/Applications/ClaudeMom.app`，安装新包，向 GitHub 上报 `local-verified = success`，执行 Merge Commit 合入 `main`，并在新主线提交上打 `local/verified-YYYYMMDD-HHMMSS` 标签推送到 `origin`。
- 输入 `fail <原因>`：保留原 `/Applications/ClaudeMom.app` 不变，向 GitHub 上报 `local-verified = failure`，将 PR 退回草稿并自动留言失败原因供 Agent 继续修复。
- 纯文档/工作流治理 PR（未触碰 `apps/`、`crates/`、`Cargo.*`）可使用 `node scripts/verify-pr.mjs <PR编号> --non-runtime`（仍强制执行全套本地单测与类型检查）。

- **向作者上游提交纯净 PR**：不要从 `main` 直接向 `BigPizzaV3/ClaudeMom` 提 PR。从同步后的 `origin/upstream-main` 新建临时分支，只 `git cherry-pick <commit>` 通用修复提交后再提 PR。

## 手动本地打包与备份命令参考（不经 PR 调试时）

1. 在干净工作区运行验证与打包命令：

   ```bash
   node scripts/build-local.mjs
   ```

   脚本要求干净工作区，依次运行 `npm ci`、前端类型检查和测试、Rust workspace 测试、Node 后端测试、Tauri release 构建及签名校验。
   npm 和 Cargo 使用仓库锁文件；任一步失败即停止，不安装或启动 App。测试证书在临时目录生成，用后删除，不加入系统信任。

   生成文件：

   | 路径 | 内容 |
   | --- | --- |
   | `target/release/bundle/macos/ClaudeMom.app` | 本机架构的安装包 |
   | `target/local-build.json` | 源码提交、分支、构建时间、架构、版本和已签名二进制 SHA-256 |

   脚本使用 macOS 临时签名，不生成作者的自动更新包，也不读取作者的更新签名或公证凭据。安装包仅供本地使用，不等同于作者签名、公证的公开发行包。

## 备份并安装

1. 完全退出 Claude 和 ClaudeMom，再执行以下命令。先将新安装包放入暂存位置并检查签名，校验通过后才移动已安装的 App。

   ```bash
   claudemom_stage=$(mktemp -d /Applications/.claudemom-install.XXXXXX)
   test -f target/local-build.json &&
     ditto target/release/bundle/macos/ClaudeMom.app "$claudemom_stage/ClaudeMom.app" &&
     codesign --verify --deep --strict "$claudemom_stage/ClaudeMom.app"
   ```

   任一步报错都应停止，不继续替换。`target/local-build.json` 只在整套验证与打包成功后生成；开始下一次真实检查或构建时会删除，以免误用失败构建的记录。

2. 备份程序和持久状态，再替换程序。保留终端中的 `claudemom_backup` 和 `claudemom_state_backup`，用于回滚。

   ```bash
   claudemom_stamp=$(date +%Y%m%d-%H%M%S)
   claudemom_backup="$HOME/.claude-mom/backups/ClaudeMom-before-local-$claudemom_stamp.app"
   claudemom_state_backup="$HOME/.claude-mom-snapshots/$claudemom_stamp"
   test -d "$claudemom_stage/ClaudeMom.app" &&
     codesign --verify --deep --strict "$claudemom_stage/ClaudeMom.app" &&
     mkdir -p "$HOME/.claude-mom/backups" "$HOME/.claude-mom-snapshots" &&
     chmod 700 "$HOME/.claude-mom-snapshots" &&
     ditto "$HOME/.claude-mom" "$claudemom_state_backup" &&
     mv /Applications/ClaudeMom.app "$claudemom_backup" &&
     mv "$claudemom_stage/ClaudeMom.app" /Applications/ClaudeMom.app &&
     rmdir "$claudemom_stage" &&
     open /Applications/ClaudeMom.app
   ```

   状态备份含模型凭证，只保存在受保护的本地目录，不放进 Git 或公开附件。替换 `.app` 会保留 `~/.claude-mom` 中的模型、设置和对话数据。
   Code 配置目录由 `~/.claude-mom/settings.json` 的 `claudeDesktopLocal.codeShareHome` 控制，见「检查 Code 共享目录与主题」。运行配置不属于 Git 源码。

3. 从 ClaudeMom 启动 Claude，完成实际交互验证。

   - 普通对话连续发送两轮消息，确认均有回复；重启后重新打开同一对话，确认记录可读。
   - Code 在空测试目录中发送不调用工具的最小提示，确认能启动会话并收到模型回复。
   - 检查所用模型及本地通道符合配置。测试通过不代表 Cowork、远程控制等其他功能均已验证。

4. 日常更新统一推荐通过 `node scripts/verify-pr.mjs <PR编号>` 自动合并 PR 并推送 `local/verified-*` 标签；若仅对已合入 `main` 的当前提交补充打标备份，可显式推送标签（不要直推 `main`）：

   ```bash
   verified_tag="local/verified-$(date +%Y%m%d-%H%M%S)"
   git tag "$verified_tag" origin/main
   git push origin "refs/tags/$verified_tag"
   ```

## 检查 Code 共享目录与主题

| `codeShareHome` | Code 配置目录 | 适用场景 |
| --- | --- | --- |
| `true` | `~/.claude` | 共用本机 CLI 安装的插件、个人 Skills、设置和会话 |
| `false` | `~/.claude-desktop-local/claude-code` | 使用独立配置，CLI 的插件和 Skills 不自动共用 |

修改目录选项后，结束需要保留的任务并重新启动 ClaudeMom 和 Claude，让下一批 Code 进程使用对应目录。共享模式也会读取 CLI 设置中的供应商地址、认证、MCP 和 hooks；遇到路由冲突时应检查这些设置，避免为修复 App 而直接覆盖 CLI 配置。

在 Code 的自定义页面检查以下内容：

1. 插件页的「我的」应列出所选配置目录中的插件。「在此项目中 0」只表示项目作用域没有插件，不代表用户作用域为空。
2. 保留官方 Skills 页面。所查 Desktop 5.11492.5 和网页构建 `aadd83568f` 的列表使用账户/Cowork 存储与插件数据，不直接列出 CLI 的个人 Skills 目录。页面没有列出个人 Skill，不代表 Code 会话没有加载它。
3. 在空测试目录新建 Code 会话，确认个人 Skill 和插件命令可发现。自定义页列表不代表 CLI 已完成初始化，也不代替实际调用验证。CLI 外部安装或更新后，已运行会话可使用 `/reload-plugins` 或重新开会话加载变化，参见[官方刷新说明](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins)。
4. 安装主题插件时，调用其主题命令，在测试会话中应用主题，确认背景和控件实际变化。菜单能打开、主题能保存，均不足以证明窗口已绘制背景。

## 升级 Claude Desktop 后验证兼容性

本地构建依赖已安装 Claude Desktop 的原生桥接和前端协议；维护 ClaudeMom 分支并不会解除这项依赖。ClaudeMom 更新、Claude Desktop 更新以及 Code CLI/插件更新应分别验证。

主题兼容逻辑位于 `crates/claude-local/runtime/proxy.mjs` 的 `enableLocalThemeRenderer`。它为 Desktop 5.11492.5 的绘制开关 `3829528001` 和网页构建 `aadd83568f` 的开关 `1253327512` 提供 bootstrap 值。窗口实际挂载绘制层后，仍由官方实现发送 `ui_attach.draws`，本地服务不代发绘制能力。

若更新后再次出现「主题保存但不显示」，先确认窗口加载的前端构建、主题开关和 Code 的绘制响应，再调整兼容逻辑；不能仅凭 App 版本推断实际网页构建，也不要把 `isDrawn` 写入配置作为开关。主题 API 的版本条件见[官方接口说明](https://code.claude.com/docs/en/plugins/mods/interface#put-a-backdrop-behind-the-conversation)。

## 处理失败与回滚

- **合并冲突或测试失败：**保留已安装 App，先修复源码及测试；不要运行安装步骤。需要撤销进行中的合并时用 `git merge --abort`。
- **没有生效的 Rust 工具链：**脚本会沿用项目、环境或 rustup 已激活的工具链；没有激活版本且只安装了一个工具链时，会单次使用该版本。安装了多个版本时，运行 `rustup toolchain list`，再通过 `RUSTUP_TOOLCHAIN=<已安装版本> node scripts/build-local.mjs` 明确选择。脚本不修改全局默认版本。
- **依赖下载连接被拒绝：**检查终端继承的代理是否仍在监听。需要单次去掉代理变量时，可用 `env -u HTTPS_PROXY -u HTTP_PROXY -u ALL_PROXY -u https_proxy -u http_proxy -u all_proxy node scripts/build-local.mjs`；网络依赖代理时，应先配置有效代理。
- **安装后对话或 Code 回归：**完全退出两个 App，将失败的安装包移走，再从备份恢复。

  ```bash
  test -n "${claudemom_backup:-}" && test -d "$claudemom_backup" &&
    mv /Applications/ClaudeMom.app "/Applications/ClaudeMom.failed-local-$(date +%Y%m%d-%H%M%S).app" &&
    ditto "$claudemom_backup" /Applications/ClaudeMom.app &&
    open /Applications/ClaudeMom.app
  ```

  若替换时失败且 `/Applications/ClaudeMom.app` 不存在，直接从 `claudemom_backup` 恢复即可。
  若版本升级还迁移了状态文件，需要先停止 App，另存故障状态，再从 `claudemom_state_backup` 恢复；这会回退备份之后的设置和对话，先保留故障状态以供恢复数据。
  更换终端后，按备份目录名重新设置这两个变量，不使用未定义的变量执行恢复命令。

## 禁止事项与更新边界

个人 Fork 采用“同步上游至 `upstream-main` → 预合并 PR 过 `ci-gate` → `verify-pr.mjs` 本机实测签收合入 `main`”的日常维护流程，需遵守以下边界：

- **禁止点击应用内「检查更新」**：[tauri.conf.json](../apps/claude-mom/src-tauri/tauri.conf.json) 的 `plugins.updater.endpoints` 指向 `https://github.com/BigPizzaV3/ClaudeMom/releases/latest/download/latest.json`，安装它会用原作者发行包覆盖本地构建。
- **禁止运行 `scripts/release.mjs` 或向 Fork 推送 `v*` 标签**：[release.mjs](../scripts/release.mjs) 已内置原作者仓库校验，且个人 Fork 远端 Ruleset 已封禁 `v*` 标签（[release.yml](../.github/workflows/release.yml) 依赖作者的 `TAURI_SIGNING_PRIVATE_KEY` 与 6 个 Apple 公证签名 Secret，个人 Fork 缺少凭据会直接失败）。
- **本地开发调试入口**：[relaunch-local.mjs](../scripts/relaunch-local.mjs) 用于开发时启动构建目录内的实例，不会替换 `/Applications/ClaudeMom.app`。
- **异机备份与离线归档**：PR 合入 `main` 及推送 `local/verified-*` 标签可完成源码与验证历史备份，但不包含 `target/` 构建产物与 `~/.claude-mom` 运行配置（含模型凭证）。如需离线全量归档仓库对象，可执行：

```bash
git bundle create "$HOME/ClaudeMom-local-source.bundle" --all
git bundle verify "$HOME/ClaudeMom-local-source.bundle"
```

相关入口：[README](../README.md)、[多 Agent 维护契约](../AGENTS.md)、[本地签收脚本](../scripts/verify-pr.mjs)、[本地构建脚本](../scripts/build-local.mjs)。
