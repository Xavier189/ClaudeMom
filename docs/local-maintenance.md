# 维护和打包 ClaudeMom 本地修复版

此流程在作者仓库的基础上保留本地修复，合并上游源码后，通过测试生成 macOS 安装包。
适用于维护 `codex/local-maintenance` 分支的使用者；需要 Node.js 22+、npm、Rust 工具链和 Xcode Command Line Tools。

`origin` 指向作者仓库 `https://github.com/BigPizzaV3/ClaudeMom.git`。本地修复保存在 Git 提交中，安装包由这些提交构建。
作者发版后，在维护分支合并源码并重新打包，才能同时得到作者改进和本地修复。

## 同步上游并打包

1. 进入仓库根目录，切换到维护分支，确认工作区干净。

   ```bash
   git switch codex/local-maintenance
   git status --short
   ```

   有改动时，先检查并提交或另行保存。不要用 `git reset --hard origin/main` 覆盖维护分支。

2. 获取上游源码，检查变化，再合并。

   ```bash
   git fetch origin --tags
   git log --oneline HEAD..origin/main
   git diff --stat HEAD...origin/main
   git merge --no-edit origin/main
   ```

   此方式保留本地修复提交。出现冲突时停止打包，检查冲突涉及的接口及对应测试，解决后提交；放弃合并可运行 `git merge --abort`。
   上游实现了同一修复时，需要结合代码和回归测试判断是否保留本地实现，不能仅凭“没有合并冲突”认定兼容。

3. 运行验证与打包命令。

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

4. 验证通过后，为该源码创建本地标签，记录可回退的版本。

   ```bash
   git tag "local/verified-$(date +%Y%m%d-%H%M%S)"
   ```

## 检查 Code 共享目录与主题

| `codeShareHome` | Code 配置目录 | 适用场景 |
| --- | --- | --- |
| `true` | `~/.claude` | 共用本机 CLI 安装的插件、个人 Skills、设置和会话 |
| `false` | `~/.claude-desktop-local/claude-code` | 使用独立配置，CLI 的插件和 Skills 不自动共用 |

修改目录选项后，结束需要保留的任务并重新启动 ClaudeMom 和 Claude，让下一批 Code 进程使用对应目录。共享模式也会读取 CLI 设置中的供应商地址、认证、MCP 和 hooks；遇到路由冲突时应检查这些设置，避免为修复 App 而直接覆盖 CLI 配置。

在 Code 的自定义页面检查以下内容：

1. 插件页的「我的」应列出所选配置目录中的插件。「在此项目中 0」只表示项目作用域没有插件，不代表用户作用域为空。
2. Skills 页的「本机 Claude Code Skills」面板列出配置目录下直接包含 `SKILL.md` 的个人 Skill 目录，支持搜索、刷新和符号链接。列表按目录名展示，只读取目录名和修改时间；不复制正文，也不提供启停、修改或删除。插件内的 Skills 由官方列表列出。
3. 在空测试目录新建 Code 会话，确认个人 Skill 和插件命令可发现。自定义页列表不代表 CLI 已完成初始化，也不代替实际调用验证。CLI 外部安装或更新后，已运行会话可使用 `/reload-plugins` 或重新开会话加载变化，参见[官方刷新说明](https://code.claude.com/docs/en/plugins/cli-reference#reload-plugins)。
4. 安装主题插件时，调用其主题命令，在测试会话中应用主题，确认背景和控件实际变化。菜单能打开、主题能保存，均不足以证明窗口已绘制背景。

个人 Skills 面板属于 ClaudeMom 的只读扩展，显示来源目录；官方 Skills 页面使用的账户/Cowork 存储与 CLI 个人目录相互独立。CLI 仍负责解析 Skill frontmatter、权限及是否允许用户调用；面板中的目录数不是启用数量。

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

## 保留源码与选择更新方式

维护本地修复时，使用“合并作者源码 → 验证 → 自行打包 → 备份安装”的流程。ClaudeMom 内置更新会检查作者的 Release，安装它会替换本地构建；需要保留本地补丁时，不通过内置更新按钮安装作者版本。

`scripts/relaunch-local.mjs` 用于开发时启动构建目录内的 App，不会替换 `/Applications/ClaudeMom.app`。
`scripts/release.mjs` 用于公开发版，会提交、打标签并推送作者仓库；本地维护不运行该脚本。

将本地提交备份为可迁移的 Git bundle，并另存安装包及 `target/local-build.json`：

```bash
git bundle create "$HOME/ClaudeMom-local-source.bundle" --all
git bundle verify "$HOME/ClaudeMom-local-source.bundle"
```

Git bundle 只包含 Git 对象和引用，不包含 `target/` 安装包及 `~/.claude-mom` 运行配置。保存在同一台电脑上的文件不构成异机备份；将 bundle 和安装包另存到自己的备份位置，或把维护分支推送到自己的 fork。

相关入口：[README](../README.md)、[本地构建脚本](../scripts/build-local.mjs)。
