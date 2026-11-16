#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appDir = path.join(root, "apps/claude-mom");
const runtimeDir = path.join(root, "crates/claude-local/runtime");
const manifestPath = path.join(root, "target/local-build.json");
const args = process.argv.slice(2);

if (args.includes("--help")) {
  console.log("用法：node scripts/build-local.mjs [--check-only] [--dry-run]\n验证锁定依赖、前端、Rust 和 Node 测试，再生成 macOS .app；不安装、不启动、不推送。\n要求工作区干净。RUSTUP_TOOLCHAIN 可指定已安装的 Rust 工具链。");
  process.exit(0);
}
if (args.some((arg) => !["--check-only", "--dry-run"].includes(arg))) throw new Error("未知参数；使用 --help 查看用法");
if (process.platform !== "darwin") throw new Error("此本地打包入口只支持 macOS");
if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("需要 Node.js 22 或更高版本");

const env = { ...process.env, PATH: `${process.env.PATH || ""}${path.delimiter}${path.join(os.homedir(), ".cargo/bin")}` };
// 本地 .app 使用临时签名，不读取或继承作者的更新包签名、公证凭据。
for (const name of Object.keys(env)) {
  if (/^(?:TAURI_SIGNING_|APPLE_)/.test(name)) delete env[name];
}
const capture = (command, argv) => execFileSync(command, argv, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const clean = () => {
  if (capture("git", ["status", "--porcelain"])) throw new Error("先提交或移走工作区改动，再打包；避免生成无法对应源码提交的安装包");
};
clean();
const revision = capture("git", ["rev-parse", "HEAD"]);
const branch = capture("git", ["branch", "--show-current"]);
if (!env.RUSTUP_TOOLCHAIN) {
  try { capture("rustup", ["show", "active-toolchain"]); }
  catch {
    const toolchains = capture("rustup", ["toolchain", "list"]).split("\n").map((line) => line.split(/\s/)[0]).filter(Boolean);
    if (toolchains.length !== 1 || toolchains[0] === "no") throw new Error("没有生效的 Rust 工具链；请用 RUSTUP_TOOLCHAIN 指定已安装的版本");
    env.RUSTUP_TOOLCHAIN = toolchains[0];
  }
}
console.log(`源码：${branch || "detached HEAD"} @ ${revision.slice(0, 12)}`);
console.log(`Rust：${capture("rustc", ["--version"])}`);
const dryRun = args.includes("--dry-run");
const run = (command, argv, cwd = root, extraEnv = {}) => {
  console.log(`$ ${command} ${argv.join(" ")}`);
  if (!dryRun) execFileSync(command, argv, { cwd, env: { ...env, ...extraEnv }, stdio: "inherit" });
};

function testCertificates(directory) {
  fs.chmodSync(directory, 0o700);
  const common = "prompt = no\n";
  fs.writeFileSync(path.join(directory, "root.cnf"), `[req]\ndistinguished_name = dn\n${common}[dn]\nCN = ClaudeMom Test CA\n[ca]\nbasicConstraints = critical,CA:TRUE\nkeyUsage = critical,keyCertSign,cRLSign\nsubjectKeyIdentifier = hash\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(directory, "leaf.cnf"), `[req]\ndistinguished_name = dn\n${common}[dn]\nCN = claude.ai\n[leaf]\nbasicConstraints = critical,CA:FALSE\nkeyUsage = critical,digitalSignature,keyEncipherment\nextendedKeyUsage = serverAuth\nauthorityKeyIdentifier = keyid,issuer\nsubjectAltName = DNS:claude.ai,DNS:*.claude.ai,DNS:claude.com,DNS:*.claude.com,DNS:anthropic.com,DNS:*.anthropic.com,DNS:claude.local,DNS:localhost,IP:127.0.0.1\n`, { mode: 0o600 });
  const openssl = (argv) => execFileSync("/usr/bin/openssl", argv, { cwd: directory, stdio: ["ignore", "pipe", "pipe"] });
  openssl(["req", "-new", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-sha256", "-config", "root.cnf", "-extensions", "ca"]);
  openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "server.key", "-out", "server.csr", "-config", "leaf.cnf"]);
  openssl(["x509", "-req", "-in", "server.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-out", "server.crt", "-days", "1", "-sha256", "-extfile", "leaf.cnf", "-extensions", "leaf"]);
  openssl(["verify", "-CAfile", "ca.pem", "server.crt"]);
}

if (!dryRun) fs.rmSync(manifestPath, { force: true });
run("npm", ["ci", "--no-audit", "--no-fund"], appDir);
run("npm", ["run", "check"], appDir);
run("npm", ["test"], appDir);
run("cargo", ["test", "--workspace", "--locked"]);
const caDir = dryRun ? "<temporary-test-ca>" : fs.mkdtempSync(path.join(os.tmpdir(), "claudemom-build-ca-"));
try {
  if (!dryRun) testCertificates(caDir);
  const tests = ["managed.test.mjs", "proxy.test.mjs", ...fs.readdirSync(path.join(runtimeDir, "scripts")).filter((file) => file.endsWith(".test.mjs")).map((file) => `scripts/${file}`)];
  run(process.execPath, ["--test", "--test-timeout=120000", ...tests], runtimeDir, { CLAUDE_LOCAL_TEST_CA_DIR: caDir });
} finally {
  if (!dryRun) fs.rmSync(caDir, { recursive: true, force: true });
}
if (args.includes("--check-only")) {
  console.log("检查完成；未生成安装包。");
  process.exit(0);
}
run("npm", ["exec", "--no", "--", "tauri", "build", "--bundles", "app", "--config", JSON.stringify({ bundle: { createUpdaterArtifacts: false, macOS: { signingIdentity: "-" } } }), "--", "--locked"], appDir);
if (dryRun) process.exit(0);
clean();
if (capture("git", ["rev-parse", "HEAD"]) !== revision) throw new Error("构建期间源码提交发生变化；请重新构建");
const bundle = "target/release/bundle/macos/ClaudeMom.app";
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", path.join(root, bundle)]);
const binarySha256 = crypto.createHash("sha256").update(fs.readFileSync(path.join(root, bundle, "Contents/MacOS/claude-mom"))).digest("hex");
fs.writeFileSync(manifestPath, JSON.stringify({ revision, branch, builtAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, bundle, binarySha256, version: JSON.parse(fs.readFileSync(path.join(appDir, "src-tauri/tauri.conf.json"))).version }, null, 2) + "\n");
console.log(`已生成：${bundle}\n构建记录：target/local-build.json\n按 docs/local-maintenance.md 备份并安装；已安装的 App 保持运行。`);
