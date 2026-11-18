#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertNoRunningClaudeApps,
  backupAndInstallApp,
  launchCleanApp,
  stampNow,
} from "./macos-install.mjs";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(REPO_ROOT, "apps/claude-mom");
const runtimeDir = path.join(REPO_ROOT, "crates/claude-local/runtime");
const manifestPath = path.join(REPO_ROOT, "target/local-build.json");

export function parseBuildLocalArgs(argv) {
  const allowed = new Set(["--check-only", "--dry-run", "--install", "--help"]);
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new Error("未知参数；使用 --help 查看用法");
  }
  const help = argv.includes("--help");
  const checkOnly = argv.includes("--check-only");
  const dryRun = argv.includes("--dry-run");
  const install = argv.includes("--install");
  if (install && (checkOnly || dryRun)) {
    throw new Error("--install 不能与 --check-only 或 --dry-run 同时使用");
  }
  return { help, checkOnly, dryRun, install };
}

export function prepareBuildEnv(cwd = REPO_ROOT) {
  if (process.platform !== "darwin") throw new Error("此本地打包入口只支持 macOS");
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node.js 22 或更高版本");

  const env = { ...process.env, PATH: `${process.env.PATH || ""}${path.delimiter}${path.join(os.homedir(), ".cargo/bin")}` };
  // 本地构建使用临时签名，不读取或继承作者的更新包签名、公证凭据。
  for (const name of Object.keys(env)) {
    if (/^(?:TAURI_SIGNING_|APPLE_)/.test(name)) delete env[name];
  }

  const capture = (command, argv) =>
    execFileSync(command, argv, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  if (!env.RUSTUP_TOOLCHAIN) {
    try {
      capture("rustup", ["show", "active-toolchain"]);
    } catch {
      const toolchains = capture("rustup", ["toolchain", "list"])
        .split("\n")
        .map((line) => line.split(/\s/)[0])
        .filter(Boolean);
      if (toolchains.length !== 1 || toolchains[0] === "no") {
        throw new Error("没有生效的 Rust 工具链；请用 RUSTUP_TOOLCHAIN 指定已安装的版本");
      }
      env.RUSTUP_TOOLCHAIN = toolchains[0];
    }
  }
  return env;
}

export function assertCleanWorktree(cwd = REPO_ROOT, env = process.env) {
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (dirty) {
    throw new Error("先提交或移走工作区改动，再打包；避免生成无法对应源码提交的安装包");
  }
}

function testCertificates(directory) {
  fs.chmodSync(directory, 0o700);
  const common = "prompt = no\n";
  fs.writeFileSync(
    path.join(directory, "root.cnf"),
    `[req]\ndistinguished_name = dn\n${common}[dn]\nCN = ClaudeMom Test CA\n[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n`,
    { mode: 0o600 },
  );
  fs.writeFileSync(
    path.join(directory, "leaf.cnf"),
    `[req]\ndistinguished_name = dn\n${common}[dn]\nCN = claude.ai\n[leaf]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nauthorityKeyIdentifier = keyid,issuer\nsubjectAltName = DNS:claude.ai,DNS:*.claude.ai,DNS:claude.com,DNS:*.claude.com,DNS:anthropic.com,DNS:*.anthropic.com,DNS:claude.local,DNS:localhost,IP:127.0.0.1\n`,
    { mode: 0o600 },
  );
  const openssl = (argv) => execFileSync("/usr/bin/openssl", argv, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  openssl(["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-sha256", "-config", "root.cnf", "-extensions", "ca"]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-config", "leaf.cnf"]);
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-sha256", "-extfile", "leaf.cnf", "-extensions", "leaf"]);
  openssl(["verify", "-CAfile", "ca.pem", "server.crt"]);
}

export function runFullVerification({ cwd = REPO_ROOT, env, dryRun = false } = {}) {
  const workAppDir = path.join(cwd, "apps/claude-mom");
  const workRuntimeDir = path.join(cwd, "crates/claude-local/runtime");
  const run = (command, argv, runCwd = cwd, extraEnv = {}) => {
    console.log(`$ ${command} ${argv.join(" ")}`);
    if (!dryRun) execFileSync(command, argv, { cwd: runCwd, env: { ...env, ...extraEnv }, stdio: "inherit" });
  };

  run("npm", ["ci", "--no-audit", "--no-fund"], workAppDir);
  run("npm", ["run", "check"], workAppDir);
  run("npm", ["test"], workAppDir);
  run("npm", ["run", "vite:build"], workAppDir);
  run("cargo", ["test", "--workspace", "--locked"], cwd);

  const caDir = dryRun ? "<temporary-test-ca>" : fs.mkdtempSync(path.join(os.tmpdir(), "claudemom-build-ca-"));
  try {
    if (!dryRun) testCertificates(caDir);
    const tests = [
      "managed.test.mjs",
      "proxy.test.mjs",
      ...fs
        .readdirSync(path.join(workRuntimeDir, "scripts"))
        .filter((file) => file.endsWith(".test.mjs"))
        .map((file) => `scripts/${file}`),
    ];
    run(process.execPath, ["--test", "--test-timeout=120000", ...tests], workRuntimeDir, { CLAUDE_LOCAL_TEST_CA_DIR: caDir });
  } finally {
    if (!dryRun) fs.rmSync(caDir, { recursive: true, force: true });
  }
}

export function buildMacBundles({ cwd = REPO_ROOT, env, bundles = ["app"], dryRun = false } = {}) {
  const workAppDir = path.join(cwd, "apps/claude-mom");
  const run = (command, argv, runCwd = cwd, extraEnv = {}) => {
    console.log(`$ ${command} ${argv.join(" ")}`);
    if (!dryRun) execFileSync(command, argv, { cwd: runCwd, env: { ...env, ...extraEnv }, stdio: "inherit" });
  };

  run(
    "npm",
    [
      "exec",
      "--no",
      "--",
      "tauri",
      "build",
      "--bundles",
      bundles.join(","),
      "--config",
      JSON.stringify({ bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: "-" } } }),
      "--",
      "--locked",
    ],
    workAppDir,
    { CI: "true" },
  );
  if (dryRun) return null;

  const bundleRel = "target/release/bundle/macos/ClaudeMom.app";
  const bundleAbs = path.join(cwd, bundleRel);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", bundleAbs]);
  const binarySha256 = crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(bundleAbs, "Contents/MacOS/claude-mom")))
    .digest("hex");
  const version = JSON.parse(fs.readFileSync(path.join(workAppDir, "src-tauri/tauri.conf.json"), "utf8")).version;

  let dmgPath = null;
  if (bundles.includes("dmg")) {
    const dmgDir = path.join(cwd, "target/release/bundle/dmg");
    const dmgFiles = fs.existsSync(dmgDir) ? fs.readdirSync(dmgDir).filter((file) => file.endsWith(".dmg")) : [];
    if (dmgFiles.length === 0) throw new Error(`未在 ${dmgDir} 找到构建生成的 .dmg 安装包`);
    dmgPath = path.join(dmgDir, dmgFiles[0]);
  }

  return { bundleRel, bundleAbs, dmgPath, binarySha256, version };
}

function main() {
  const opts = parseBuildLocalArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(
      [
        "用法：node scripts/build-local.mjs [--check-only] [--dry-run] [--install]",
        "验证锁定依赖、前端、Rust 和 Node 测试，再生成 macOS .app。",
        "  --install     完成构建后自动校验退出状态、备份 ~/.claude-mom 与旧应用，安装 /Applications/ClaudeMom.app 并清理构建目录内重复 .app",
        "  --check-only  仅执行全量校验，不生成安装包",
        "  --dry-run     只打印将要执行的命令",
      ].join("\n"),
    );
    return;
  }

  if (opts.install) {
    assertNoRunningClaudeApps();
  }

  const env = prepareBuildEnv(REPO_ROOT);
  const capture = (command, argv) =>
    execFileSync(command, argv, { cwd: REPO_ROOT, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

  assertCleanWorktree(REPO_ROOT, env);
  const revision = capture("git", ["rev-parse", "HEAD"]);
  const branch = capture("git", ["branch", "--show-current"]);
  console.log(`源码：${branch || "detached HEAD"} @ ${revision.slice(0, 12)}`);
  console.log(`Rust：${capture("rustc", ["--version"])}`);

  if (!opts.dryRun) fs.rmSync(manifestPath, { force: true });
  runFullVerification({ cwd: REPO_ROOT, env, dryRun: opts.dryRun });

  if (opts.checkOnly) {
    console.log("检查完成；未生成安装包。");
    return;
  }

  const built = buildMacBundles({ cwd: REPO_ROOT, env, bundles: ["app"], dryRun: opts.dryRun });
  if (opts.dryRun || !built) return;

  assertCleanWorktree(REPO_ROOT, env);
  if (capture("git", ["rev-parse", "HEAD"]) !== revision) {
    throw new Error("构建期间源码提交发生变化；请重新构建");
  }

  const manifest = {
    revision,
    branch,
    builtAt: new Date().toISOString(),
    platform: process.platform,
    architecture: process.arch,
    bundle: built.bundleRel,
    binarySha256: built.binarySha256,
    version: built.version,
  };

  if (opts.install) {
    const stamp = stampNow();
    const installed = backupAndInstallApp(built.bundleAbs, {
      backupPrefix: "local",
      stamp,
      stateBackupName: stamp,
      requireAppQuit: true,
      cleanupStagedBundle: true,
      repoRoot: REPO_ROOT,
    });
    manifest.installedTo = installed.targetApp;
    manifest.appBackupArchive = installed.appBackupArchive;
    manifest.stateBackupPath = installed.stateBackupPath;
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    launchCleanApp(installed.targetApp);
    console.log(`已安装并启动：${installed.targetApp}\n构建记录：target/local-build.json`);
    return;
  }

  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(
    `已生成：${built.bundleRel}\n构建记录：target/local-build.json\n提示：推荐直接运行 node scripts/build-local.mjs --install 安装并自动清理 target 内的重复 .app；手动安装请参照 docs/local-maintenance.md。`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
