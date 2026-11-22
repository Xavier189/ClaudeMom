import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  formatImplementationPrBody,
  integrateFixedSha,
} from "./upstream-watch.mjs";

function makeTempRepoDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-integrate-test-"));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略清理异常
  }
}

function gitExec(repoDir, args) {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Xavier189",
      GIT_AUTHOR_EMAIL: "63280269+Xavier189@users.noreply.github.com",
      GIT_COMMITTER_NAME: "Xavier189",
      GIT_COMMITTER_EMAIL: "63280269+Xavier189@users.noreply.github.com",
    },
  }).trim();
}

function initFixtureRepo() {
  const dir = makeTempRepoDir();
  gitExec(dir, ["init", "-b", "main"]);
  gitExec(dir, ["config", "user.name", "Xavier189"]);
  gitExec(dir, ["config", "user.email", "63280269+Xavier189@users.noreply.github.com"]);
  fs.writeFileSync(path.join(dir, "README.md"), "# Initial\n");
  gitExec(dir, ["add", "README.md"]);
  gitExec(dir, ["commit", "-m", "initial commit"]);
  const mainSha = gitExec(dir, ["rev-parse", "main"]);

  // 建立 upstream-main 镜像分支作为测试夹具
  gitExec(dir, ["branch", "upstream-main", "main"]);
  const upstreamMainSha = gitExec(dir, ["rev-parse", "upstream-main"]);

  return { dir, mainSha, upstreamMainSha };
}

test("1. No conflict: merge succeeds, testRunner is invoked, prReady true only if hook passes", async () => {
  const { dir, mainSha, upstreamMainSha } = initFixtureRepo();
  try {
    // 构造上游分支提交
    gitExec(dir, ["checkout", "--quiet", "-b", "temp-upstream"]);
    fs.writeFileSync(path.join(dir, "upstream-feature.txt"), "feature from upstream\n");
    gitExec(dir, ["add", "upstream-feature.txt"]);
    gitExec(dir, ["commit", "-m", "upstream feature commit"]);
    const upstreamSha = gitExec(dir, ["rev-parse", "HEAD"]);
    gitExec(dir, ["checkout", "--quiet", "main"]);

    let hookCalled = false;
    const result = await integrateFixedSha({
      repoDir: dir,
      baseRef: "main",
      upstreamSha,
      workBranch: "feat/candidate-no-conflict",
      testRunner: async ({ repoDir, workBranch }) => {
        hookCalled = true;
        assert.equal(repoDir, dir);
        assert.equal(workBranch, "feat/candidate-no-conflict");
        return { ok: true, suite: "passed" };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(hookCalled, true, "Assert the hook was called when there is no conflict");
    assert.equal(result.testsRan, true);
    assert.equal(result.prReady, true);
    assert.equal(result.conflict, false);
    assert.deepEqual(result.conflictedFiles, []);
    assert.equal(result.workBranch, "feat/candidate-no-conflict");

    // baseSha 与 headSha 分离记录
    assert.equal(result.baseSha, mainSha);
    assert.notEqual(result.headSha, mainSha);
    assert.equal(typeof result.headSha, "string");

    // 验证测试夹具中的 main 与 upstream-main 分支未被篡改
    const mainAfter = gitExec(dir, ["rev-parse", "main"]);
    const upstreamMainAfter = gitExec(dir, ["rev-parse", "upstream-main"]);
    assert.equal(mainAfter, mainSha, "fixture main must be unchanged");
    assert.equal(upstreamMainAfter, upstreamMainSha, "fixture upstream-main must be unchanged");

    // 验证 notes 说明 Mac packaging 未实测
    assert.match(result.notes, /Mac packaging, app install, and Desktop verification are untested/);
    assert.match(result.notes, /Linux evidence is this script and node tests only/);
  } finally {
    cleanTempDir(dir);
  }
});

test("2. No conflict but testRunner hook fails: prReady is false, ok is false", async () => {
  const { dir } = initFixtureRepo();
  try {
    gitExec(dir, ["checkout", "--quiet", "-b", "temp-upstream-2"]);
    fs.writeFileSync(path.join(dir, "feature-2.txt"), "feature 2\n");
    gitExec(dir, ["add", "feature-2.txt"]);
    gitExec(dir, ["commit", "-m", "feature 2 commit"]);
    const upstreamSha = gitExec(dir, ["rev-parse", "HEAD"]);
    gitExec(dir, ["checkout", "--quiet", "main"]);

    let hookCalled = false;
    const result = await integrateFixedSha({
      repoDir: dir,
      baseRef: "main",
      upstreamSha,
      workBranch: "feat/hook-fail",
      testRunner: async () => {
        hookCalled = true;
        return { ok: false, error: "unit test failed" };
      },
    });

    assert.equal(hookCalled, true);
    assert.equal(result.testsRan, true);
    assert.equal(result.prReady, false, "prReady must be false when testRunner hook fails");
    assert.equal(result.ok, false);
  } finally {
    cleanTempDir(dir);
  }
});

test("3. Conflict without repair: conflict=true, testsRan false, prReady false", async () => {
  const { dir, mainSha, upstreamMainSha } = initFixtureRepo();
  try {
    // 本地 base 产生变更
    fs.writeFileSync(path.join(dir, "conflict-file.txt"), "downstream version\n");
    gitExec(dir, ["add", "conflict-file.txt"]);
    gitExec(dir, ["commit", "-m", "downstream commit on main"]);
    const updatedMainSha = gitExec(dir, ["rev-parse", "main"]);

    // 上游产生冲突变更
    gitExec(dir, ["checkout", "--quiet", "-b", "temp-conflict-upstream", upstreamMainSha]);
    fs.writeFileSync(path.join(dir, "conflict-file.txt"), "upstream conflicting version\n");
    gitExec(dir, ["add", "conflict-file.txt"]);
    gitExec(dir, ["commit", "-m", "upstream conflicting commit"]);
    const upstreamSha = gitExec(dir, ["rev-parse", "HEAD"]);
    gitExec(dir, ["checkout", "--quiet", "main"]);

    let hookCalled = false;
    const result = await integrateFixedSha({
      repoDir: dir,
      baseRef: "main",
      upstreamSha,
      workBranch: "feat/candidate-conflict",
      testRunner: async () => {
        hookCalled = true;
        return { ok: true };
      },
    });

    assert.equal(result.conflict, true);
    assert.ok(result.conflictedFiles.includes("conflict-file.txt"));
    assert.equal(result.testsRan, false, "testsRan must be false when conflict occurs without repair");
    assert.equal(hookCalled, false, "testRunner must NOT be invoked when conflict occurs without repair");
    assert.equal(result.prReady, false);
    assert.equal(result.ok, false);
    assert.equal(result.baseSha, updatedMainSha);

    // 验证 main 与 upstream-main 依然未被修改
    assert.equal(gitExec(dir, ["rev-parse", "main"]), updatedMainSha);
    assert.equal(gitExec(dir, ["rev-parse", "upstream-main"]), upstreamMainSha);
  } finally {
    cleanTempDir(dir);
  }
});

test("4. Conflict with repair: repair resolves conflict, testRunner runs and prReady is true", async () => {
  const { dir, upstreamMainSha } = initFixtureRepo();
  try {
    fs.writeFileSync(path.join(dir, "conflict-file.txt"), "downstream content\n");
    gitExec(dir, ["add", "conflict-file.txt"]);
    gitExec(dir, ["commit", "-m", "downstream commit"]);
    const baseSha = gitExec(dir, ["rev-parse", "main"]);

    gitExec(dir, ["checkout", "--quiet", "-b", "temp-conflict-branch", upstreamMainSha]);
    fs.writeFileSync(path.join(dir, "conflict-file.txt"), "upstream content\n");
    gitExec(dir, ["add", "conflict-file.txt"]);
    gitExec(dir, ["commit", "-m", "upstream commit"]);
    const upstreamSha = gitExec(dir, ["rev-parse", "HEAD"]);
    gitExec(dir, ["checkout", "--quiet", "main"]);

    let repairCalled = false;
    let hookCalled = false;

    const result = await integrateFixedSha({
      repoDir: dir,
      baseRef: "main",
      upstreamSha,
      workBranch: "feat/candidate-repaired",
      repair: async ({ repoDir, conflictedFiles }) => {
        repairCalled = true;
        assert.ok(conflictedFiles.includes("conflict-file.txt"));
        // 修复冲突
        fs.writeFileSync(path.join(repoDir, "conflict-file.txt"), "resolved merged content\n");
        gitExec(repoDir, ["add", "conflict-file.txt"]);
      },
      testRunner: async ({ repoDir, workBranch }) => {
        hookCalled = true;
        assert.equal(workBranch, "feat/candidate-repaired");
        return { ok: true };
      },
    });

    assert.equal(repairCalled, true);
    assert.equal(result.conflict, true);
    assert.equal(result.testsRan, true);
    assert.equal(hookCalled, true);
    assert.equal(result.prReady, true);
    assert.equal(result.ok, true);
    assert.equal(result.baseSha, baseSha);
    assert.notEqual(result.headSha, baseSha);
  } finally {
    cleanTempDir(dir);
  }
});

test("5. Refuses protected branch names as workBranch (main, upstream-main, sync/upstream-main)", async () => {
  const { dir, mainSha } = initFixtureRepo();
  try {
    for (const forbidden of ["main", "upstream-main", "sync/upstream-main"]) {
      await assert.rejects(
        () =>
          integrateFixedSha({
            repoDir: dir,
            baseRef: "main",
            upstreamSha: mainSha,
            workBranch: forbidden,
          }),
        /Refusing to use protected branch/
      );
    }
  } finally {
    cleanTempDir(dir);
  }
});

test("6. Refuses omitted or empty repoDir", async () => {
  await assert.rejects(
    () =>
      integrateFixedSha({
        repoDir: "",
        baseRef: "main",
        upstreamSha: "abc",
        workBranch: "feat/test",
      }),
    /repoDir/
  );

  await assert.rejects(
    () =>
      integrateFixedSha({
        baseRef: "main",
        upstreamSha: "abc",
        workBranch: "feat/test",
      }),
    /repoDir/
  );
});

test("7. CLI one-shot integrate command execution and exit code semantics", async () => {
  const { dir, mainSha } = initFixtureRepo();
  try {
    // 构造 upstreamSha
    gitExec(dir, ["checkout", "--quiet", "-b", "cli-upstream"]);
    fs.writeFileSync(path.join(dir, "cli-file.txt"), "cli content\n");
    gitExec(dir, ["add", "cli-file.txt"]);
    gitExec(dir, ["commit", "-m", "cli upstream commit"]);
    const upstreamSha = gitExec(dir, ["rev-parse", "HEAD"]);
    gitExec(dir, ["checkout", "--quiet", "main"]);

    // A. 缺少 --repo-dir: 拒绝并以退出码 2 退出
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/upstream-watch.mjs", "integrate", "--upstream-sha", upstreamSha, "--work-branch", "feat/cli-test"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (err) => err.status === 2
    );

    // B. 未知参数: 退出码 2
    assert.throws(
      () =>
        execFileSync(process.execPath, ["scripts/upstream-watch.mjs", "integrate", "--unknown-flag"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      (err) => err.status === 2
    );

    // C. 尝试使用保护分支: 退出码 2
    assert.throws(
      () =>
        execFileSync(
          process.execPath,
          [
            "scripts/upstream-watch.mjs",
            "integrate",
            "--repo-dir",
            dir,
            "--upstream-sha",
            upstreamSha,
            "--work-branch",
            "main",
          ],
          {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
          }
        ),
      (err) => err.status === 2
    );

    // D. 正常参数执行: 退出码 0，并输出 JSON
    const stdout = execFileSync(
      process.execPath,
      [
        "scripts/upstream-watch.mjs",
        "integrate",
        "--repo-dir",
        dir,
        "--base-ref",
        "main",
        "--upstream-sha",
        upstreamSha,
        "--work-branch",
        "feat/cli-success",
      ],
      {
        encoding: "utf8",
      }
    );
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.workBranch, "feat/cli-success");
    assert.equal(parsed.baseSha, mainSha);
    assert.notEqual(parsed.headSha, mainSha);
    assert.equal(parsed.conflict, false);
  } finally {
    cleanTempDir(dir);
  }
});

test("8. formatImplementationPrBody helper formats required review, issue, and scheduler notes", () => {
  const body = formatImplementationPrBody({ taskId: "CM-IMPL-001" });
  assert.match(body, /Task: CM-IMPL-001/);
  assert.match(body, /create_issue 403/);
  assert.match(body, /不畏浮云/);
  assert.match(body, /xavier/);
  assert.match(body, /Formal scheduler remains disabled/);
  assert.match(body, /Production POST and production transport remain disabled/);

  const customBody = formatImplementationPrBody({ taskId: "CM-IMPL-002", issueStatus: "Issue #99 verified" });
  assert.match(customBody, /Task: CM-IMPL-002/);
  assert.match(customBody, /Issue #99 verified/);
});
