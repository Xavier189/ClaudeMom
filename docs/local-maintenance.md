# ClaudeMom 个人 Fork 维护与本地打包指南

本手册规定个人 Fork（`Xavier189/ClaudeMom`）与作者上游仓库（`BigPizzaV3/ClaudeMom`）之间的分支门禁、自动上游同步、多 Agent 开发、本机真机实测签收、个人 macOS Release 发布及回滚规则。
在 macOS 上构建并安装 `main` 分支需要 Node.js 22+、npm、Rust 工具链和 Xcode Command Line Tools。

该流程只向个人 Fork 推送经脱敏身份提交的源码，并通过 [release-mac.mjs](../scripts/release-mac.mjs) 发布仅包含 macOS 安装包（ad-hoc 签名）的 `mac-v*` GitHub Release，不修改作者上游仓库，也不构建或发布 Windows 安装包。

## 远端、分支与门禁约定

| 远端名 | 仓库地址 | 用途与推送限制 |
| --- | --- | --- |
| `origin` | `git@github.com:Xavier189/ClaudeMom.git` | 个人 Fork，托管默认黄金主线 `main`、上游干净镜像 `upstream-main` 与个人 `mac-v*` 发行标签 |
| `upstream` | `https://github.com/BigPizzaV3/ClaudeMom.git` | 作者上游仓库，只拉取更新；本地将 `pushurl` 设为 `no_push` 以防误推 |

| 引用名 | 类型 | 规则与用途 |
| --- | --- | --- |
| `main` | 默认主分支 | **个人长期黄金主线**；服务端开启 Ruleset 禁止直推与强推，必须经 PR 验证通过后以 Merge Commit 合入（已停用 GitHub Actions） |
| `upstream-main` | 镜像分支 | **作者上游干净镜像**；服务端禁止强推与删除，仅通过 `--ff-only` 同步 `upstream/main`，不在该分支提交任何个人改动 |
| `sync/upstream-main` | 同步分支 | 由 [sync-upstream.mjs](../scripts/sync-upstream.mjs) 自动维护的上游同步 PR 分支 |
| `mac-v<version>-<shortsha>` | 发行标签 | 由 [release-mac.mjs](../scripts/release-mac.mjs) 创建并绑定 macOS-only GitHub Release（含 `.dmg`、`.app.zip` 与 `SHA256SUMS.txt`） |
| `local/verified-YYYYMMDD-HHMMSS` | 标签 | 可选本机回滚锚点标签（执行 `verify-pr.mjs <PR> --tag` 或手动需要时推送） |
| `v*`（例如 `v0.1.7`） | 标签 | 上游发版标签；服务端 Ruleset 已封禁在个人 Fork 创建或更新 `v*` 标签 |

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

## 自动上游同步与 PR 验证工作流（grokbot + 多 Agent + 本机）

### 1. 主动发现上游更新并创建预合并 PR

由 `grokbot` 定时任务或本机直接运行 [scripts/sync-upstream.mjs](../scripts/sync-upstream.mjs)：

```bash
node scripts/sync-upstream.mjs
```

1. 自动将 `origin/upstream-main` 快进更新至 `BigPizzaV3/ClaudeMom:main`。
2. 若 `main` 尚未包含最新上游提交，在隔离 `worktree` 尝试预合并 `origin/main` 与最新上游：
   - **无冲突**：自动发起/更新指向 `main` 的同步 PR，附带上游提交清单与个人定制敏感文件重叠提醒。
   - **发生 Git 冲突**：自动将同步 PR 转为标题带 `[CONFLICT]` 的草稿 PR，并在正文中附上冲突文件清单与现成的 Agent 修复指令。

### 2. 多 Agent 日常开发与冲突修复

所有接入本仓库的 Coding Agent（grokbot、Antigravity、Codex、Cursor、Claude Code 等）共享根目录 [AGENTS.md](../AGENTS.md)（`CLAUDE.md` 软链同源）：

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

### 3. PR 验证与合入 `main`（支持 grokbot 自动验证与本机真机签收）

- **方式 A（grokbot / 自动化 Agent 一键拉取验证并合入）**：
  ```bash
  node scripts/verify-pr.mjs <PR编号> --auto
  ```
  脚本在隔离 `git worktree` 中将 PR 预合入最新 `origin/main`，依次运行 `check-invariants.mjs`、治理单测与 `build-local.mjs --check-only`（前端检查 + Rust 测试 + Node 运行时测试）。全部通过则自动以 Merge Commit 合入 `main` 并清理源分支；若合并冲突或任一检查失败，自动把 PR 退回草稿并评论失败详情供修复（若只验证不合并可传 `--check-only`）。

- **方式 B（维护者本机打包 `.app` 真机实测签收并安装）**：
  ```bash
  node scripts/verify-pr.mjs <PR编号>
  ```
  完整编译待测 `ClaudeMom.app`，先不覆盖已安装版本而直接启动待测实例供 Claude Desktop 真机交互验证：
  - 输入 `pass`：自动备份 `~/.claude-mom`、将旧 `/Applications/ClaudeMom.app` 归档为 `.app.zip` 并注销 LaunchServices 注册，安装新包并清理工作目录临时 `.app`，执行 Merge Commit 合入 `main`（如需同步推送 `local/verified-*` 标签可加 `--tag`）。
  - 输入 `fail <原因>`：保留原 `/Applications/ClaudeMom.app` 不变，将 PR 退回草稿并留言失败原因供 Agent 继续修复。

### 4. 发布个人 macOS Release（仅 Mac，不含 Windows）

PR 合入 `main` 且本地 `main` 已同步至最新 `origin/main` 后，运行 [release-mac.mjs](../scripts/release-mac.mjs)：

```bash
node scripts/release-mac.mjs           # 跑全套检查 → 构建 .dmg + .app.zip → 创建 mac-v<version>-<shortsha> Release
node scripts/release-mac.mjs --install # 同上，并同步安全替换本地 /Applications/ClaudeMom.app
```

脚本只构建 macOS 产物并自动清理 `target/release/bundle/` 临时包，避免 Spotlight / Raycast 检索出重复 `ClaudeMom.app`。

- **向作者上游提交纯净 PR**：不要从 `main` 直接向 `BigPizzaV3/ClaudeMom` 提 PR。从同步后的 `origin/upstream-main` 新建临时分支，只 `git cherry-pick <commit>` 通用修复提交后再提 PR。

## 手动本地打包与备份命令参考（不经 PR 调试时）

1. 最省事的方式是直接使用 `--install`（先退出 Claude 与 ClaudeMom）：

   ```bash
   node scripts/build-local.mjs --install
   ```

   脚本要求干净工作区与已退出状态，依次运行全套校验与打包后，自动备份并替换 `/Applications/ClaudeMom.app`，将旧应用归档为 `.app.zip`、注销 LaunchServices 旧注册，并清理 `target/release/bundle/macos/ClaudeMom.app` 防止系统搜出两个 ClaudeMom。

2. 若仅构建检查（不自动替换 `/Applications/ClaudeMom.app`）：

   ```bash
   node scripts/build-local.mjs
   ```

   生成文件：

   | 路径 | 内容 |
   | --- | --- |
   | `target/release/bundle/macos/ClaudeMom.app` | 本机架构的安装包（手动安装完毕后应删去此副本，防止 Spotlight 检索出两个应用） |
   | `target/local-build.json` | 源码提交、分支、构建时间、架构、版本和已签名二进制 SHA-256 |

   脚本使用 macOS 临时签名，不生成作者的自动更新包，也不读取作者的更新签名或公证凭据。安装包仅供本地使用，不等同于作者签名、公证的公开发行包。

## 手动备份并安装

1. 完全退出 Claude 和 ClaudeMom，再执行以下命令。先将新安装包放入暂存位置并检查签名，校验通过后才移动已安装的 App。

   ```bash
   claudemom_stage=$(mktemp -d /Applications/.claudemom-install.XXXXXX)
   test -f target/local-build.json &&
     ditto target/release/bundle/macos/ClaudeMom.app "$claudemom_stage/ClaudeMom.app" &&
     codesign --verify --deep --strict "$claudemom_stage/ClaudeMom.app"
   ```

   任一步报错都应停止，不继续替换。`target/local-build.json` 只在整套验证与打包成功后生成；开始下一次真实检查或构建时会删除，以免误用失败构建的记录。

2. 备份程序与持久状态、压缩归档旧应用、安装新应用并清理 `target/` 重复副本：

   ```bash
   claudemom_lsreg="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
   claudemom_stamp=$(date +%Y%m%d-%H%M%S)
   claudemom_raw_backup="$HOME/.claude-mom/backups/ClaudeMom-before-local-$claudemom_stamp.app"
   claudemom_backup="${claudemom_raw_backup}.zip"
   claudemom_state_backup="$HOME/.claude-mom-snapshots/$claudemom_stamp"
   test -d "$claudemom_stage/ClaudeMom.app" &&
     codesign --verify --deep --strict "$claudemom_stage/ClaudeMom.app" &&
     mkdir -p "$HOME/.claude-mom/backups" "$HOME/.claude-mom-snapshots" &&
     chmod 700 "$HOME/.claude-mom-snapshots" &&
     ditto "$HOME/.claude-mom" "$claudemom_state_backup" &&
     "$claudemom_lsreg" -u /Applications/ClaudeMom.app 2>/dev/null || true &&
     mv /Applications/ClaudeMom.app "$claudemom_raw_backup" &&
     "$claudemom_lsreg" -u "$claudemom_raw_backup" 2>/dev/null || true &&
     ditto -c -k --sequesterRsrc --keepParent "$claudemom_raw_backup" "$claudemom_backup" &&
     rm -rf "$claudemom_raw_backup" &&
     mv "$claudemom_stage/ClaudeMom.app" /Applications/ClaudeMom.app &&
     rmdir "$claudemom_stage" &&
     "$claudemom_lsreg" -u target/release/bundle/macos/ClaudeMom.app 2>/dev/null || true &&
     rm -rf target/release/bundle/macos/ClaudeMom.app &&
     "$claudemom_lsreg" -f /Applications/ClaudeMom.app 2>/dev/null || true &&
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
- **安装后对话或 Code 回归：**完全退出两个 App，将失败的安装包移走，再从 `.app.zip` 归档（或历史 `.app` 目录）备份恢复。

  ```bash
  # 新版备份为 .app.zip：
  test -n "${claudemom_backup:-}" && test -f "$claudemom_backup" &&
    mv /Applications/ClaudeMom.app "/Applications/ClaudeMom.failed-local-$(date +%Y%m%d-%H%M%S).app" &&
    ditto -x -k "$claudemom_backup" /Applications/ &&
    open /Applications/ClaudeMom.app

  # 历史未压缩 .app 目录备份：
  test -n "${claudemom_backup:-}" && test -d "$claudemom_backup" &&
    mv /Applications/ClaudeMom.app "/Applications/ClaudeMom.failed-local-$(date +%Y%m%d-%H%M%S).app" &&
    ditto "$claudemom_backup" /Applications/ClaudeMom.app &&
    open /Applications/ClaudeMom.app
  ```

  若替换时失败且 `/Applications/ClaudeMom.app` 不存在，直接从 `claudemom_backup` 恢复即可。
  若版本升级还迁移了状态文件，需要先停止 App，另存故障状态，再从 `claudemom_state_backup` 恢复；这会回退备份之后的设置和对话，先保留故障状态以供恢复数据。
  更换终端后，按备份目录名重新设置这两个变量，不使用未定义的变量执行恢复命令。

## 禁止事项与更新边界

个人 Fork 采用“同步上游至 `upstream-main` → 发起预合并 PR → `grokbot` / 本机 `verify-pr.mjs` 验证合入 `main`”的日常维护流程，需遵守以下边界：

- **禁止点击应用内「检查更新」**：[tauri.conf.json](../apps/claude-mom/src-tauri/tauri.conf.json) 的 `plugins.updater.endpoints` 指向 `https://github.com/BigPizzaV3/ClaudeMom/releases/latest/download/latest.json`，安装它会用原作者发行包覆盖本地构建。
- **禁止运行 `scripts/release.mjs` 或向 Fork 推送 `v*` 标签**：[release.mjs](../scripts/release.mjs) 已内置原作者仓库校验，且个人 Fork 远端 Ruleset 已封禁 `v*` 标签。个人 Fork 发版一律使用只构建 macOS 产物的 [release-mac.mjs](../scripts/release-mac.mjs)。
- **本地开发调试入口**：[relaunch-local.mjs](../scripts/relaunch-local.mjs) 用于开发时启动构建目录内的实例，不会替换 `/Applications/ClaudeMom.app`（注意开发调试后清理 `target/release/bundle/macos/ClaudeMom.app`，以免 Spotlight 索引出两个应用）。
- **异机备份与离线归档**：PR 合入 `main` 及通过 [release-mac.mjs](../scripts/release-mac.mjs) 发布 `mac-v*` Release 可完成源码与可用安装包归档；如需离线全量归档仓库对象，可执行：

```bash
git bundle create "$HOME/ClaudeMom-local-source.bundle" --all
git bundle verify "$HOME/ClaudeMom-local-source.bundle"
```

相关入口：[README](../README.md)、[多 Agent 维护契约](../AGENTS.md)、[本地签收脚本](../scripts/verify-pr.mjs)、[本地构建脚本](../scripts/build-local.mjs)、[macOS 发版脚本](../scripts/release-mac.mjs)。
