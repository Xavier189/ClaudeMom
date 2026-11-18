import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import {
  TRUSTED_LOCKS,
  acquireLock,
  authorizeTrigger,
  buildTriggerEvent,
  createDefaultState,
  createMockTransport,
  deliver,
  evaluateTrigger,
  fetchUpstream,
  getDedupKey,
  isPidAlive,
  isScheduleMatch,
  loadState,
  nextBackoffMs,
  parseArgs,
  releaseLock,
  runDetect,
  saveState,
  validateConfig,
} from "./upstream-watch.mjs";

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cm-upstream-watch-test-"));
}

function cleanTempDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 忽略临时目录清理异常
  }
}

function createBaseConfig(overrides = {}) {
  return {
    pollIntervalSeconds: 300,
    commitThreshold: 3,
    scheduleTimes: [],
    schedulerEnabled: false,
    stateDir: makeTempDir(),
    transport: { mode: "mock", productionEnabled: false },
    ...overrides,
  };
}

test("1. Below threshold, no schedule hit: 0 POSTs, 0 model wakes; seen may update after a successful fetch, but no trigger", async () => {
  const stateDir = makeTempDir();
  try {
    const config = createBaseConfig({
      stateDir,
      commitThreshold: 5,
      schedulerEnabled: false,
    });

    let wakes = 0;
    const transport = createMockTransport({ behavior: 200 });
    const adapter = async () => ({
      headSha: "sha_002",
      commits: [
        { sha: "sha_001", timestamp: 1000 },
        { sha: "sha_002", timestamp: 2000 },
      ],
    });

    const result = await runDetect({
      config,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(result.ok, true);
    assert.equal(result.shouldTrigger, false);
    assert.equal(result.modelWakeCount, 0);
    assert.equal(wakes, 0);
    assert.equal(result.postCount, 0);
    assert.equal(transport.postCount, 0);

    // 成功拉取后，已观察的 seen 允许更新
    const state = loadState(stateDir);
    assert.equal(state.seen.headSha, "sha_002");
    assert.deepEqual(state.seen.commitShas, ["sha_001", "sha_002"]);
    assert.equal(state.openBatch, null);
    assert.equal(state.send, null);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("2. No new commits: 0 POSTs, 0 model wakes, even at a schedule time", async () => {
  const stateDir = makeTempDir();
  try {
    // 预先写入已记录的 seen
    const initialState = createDefaultState();
    initialState.seen = { headSha: "sha_002", commitShas: ["sha_001", "sha_002"] };
    saveState(stateDir, initialState);

    const config = createBaseConfig({
      stateDir,
      commitThreshold: 5,
      schedulerEnabled: true,
      timezone: "America/Los_Angeles",
      scheduleTimes: [{ hour: 14, minute: 30 }],
    });

    let wakes = 0;
    const transport = createMockTransport({ behavior: 200 });
    // 适配器返回当前 headSha，但无新提交
    const adapter = async () => ({
      headSha: "sha_002",
      commits: [],
    });

    // 构造洛杉矶时间 14:30
    const matchingTime = new Date("2026-11-18T22:30:00.000Z"); // UTC 22:30 对应 America/Los_Angeles 14:30 (PST)

    const result = await runDetect({
      config,
      now: matchingTime,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(result.ok, true);
    assert.equal(result.shouldTrigger, false);
    assert.equal(result.reason, "no_new_commits");
    assert.equal(result.modelWakeCount, 0);
    assert.equal(wakes, 0);
    assert.equal(result.postCount, 0);
    assert.equal(transport.postCount, 0);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("3. Reaching commitThreshold: exactly 1 trigger / 1 POST / 1 model wake (model wake hook runs only after predicate + authz pass, and only once)", async () => {
  const stateDir = makeTempDir();
  try {
    const config = createBaseConfig({
      stateDir,
      commitThreshold: 3,
      schedulerEnabled: false,
    });

    let wakes = 0;
    const transport = createMockTransport({ behavior: 200 });
    const adapter = async () => ({
      headSha: "sha_003",
      commits: [
        { sha: "sha_001", timestamp: 100 },
        { sha: "sha_002", timestamp: 200 },
        { sha: "sha_003", timestamp: 300 },
      ],
    });

    const result = await runDetect({
      config,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(result.ok, true);
    assert.equal(result.shouldTrigger, true);
    assert.equal(result.modelWakeCount, 1);
    assert.equal(wakes, 1);
    assert.equal(result.postCount, 1);
    assert.equal(transport.postCount, 1);

    // 投递成功后状态检查
    const state = loadState(stateDir);
    assert.equal(state.send.state, "accepted");
    assert.equal(result.deliverResult.acceptedMeansRunStarted, true);
    assert.equal(state.openBatch, null);
    assert.equal(state.processed.headSha, "sha_003");
  } finally {
    cleanTempDir(stateDir);
  }
});

test("4. Burst of several new commits in one detect: coalesced to 1 batch, 1 trigger, not N triggers", async () => {
  const stateDir = makeTempDir();
  try {
    const config = createBaseConfig({
      stateDir,
      commitThreshold: 3,
    });

    let wakes = 0;
    const transport = createMockTransport({ behavior: 200 });
    const burstCommits = Array.from({ length: 10 }, (_, i) => ({
      sha: `burst_sha_${i + 1}`,
      timestamp: 1000 + i,
    }));

    const adapter = async () => ({
      headSha: burstCommits[burstCommits.length - 1].sha,
      commits: burstCommits,
    });

    const result = await runDetect({
      config,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(result.ok, true);
    assert.equal(result.shouldTrigger, true);
    assert.equal(result.batch.commitShas.length, 10);
    assert.equal(result.modelWakeCount, 1);
    assert.equal(wakes, 1);
    assert.equal(result.postCount, 1);
    assert.equal(transport.postCount, 1);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("5. Duplicate/same batch again (or replay of same event): 0 additional POSTs / wakes", async () => {
  const stateDir = makeTempDir();
  try {
    const config = createBaseConfig({
      stateDir,
      commitThreshold: 2,
    });

    const commits = [
      { sha: "sha_dup_1", timestamp: 1 },
      { sha: "sha_dup_2", timestamp: 2 },
    ];
    const transport = createMockTransport({ behavior: 200 });
    const adapter = async () => ({ headSha: "sha_dup_2", commits });

    let wakes = 0;
    // 第一次运行：触发
    const run1 = await runDetect({
      config,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });
    assert.equal(run1.shouldTrigger, true);
    assert.equal(wakes, 1);
    assert.equal(transport.postCount, 1);

    // 第二次运行相同数据（重放）：不触发、不唤醒、不发 POST
    const run2 = await runDetect({
      config,
      adapter,
      transport,
      onModelWake: () => wakes++,
    });
    assert.equal(run2.shouldTrigger, false);
    assert.equal(wakes, 1); // 仍为 1，无新增
    assert.equal(transport.postCount, 1); // 仍为 1，无新增
  } finally {
    cleanTempDir(stateDir);
  }
});

test("6. Payload injection of repo/branch/action/route/permission: rejected, 0 POST, 0 wake", () => {
  const maliciousPayloads = [
    { repo: "malicious/fork" },
    { branch: "evil-branch" },
    { action: "arbitrary_exec" },
    { route: "/malicious" },
    { executor: "untrusted_agent" },
    { permission: "root" },
    { authorization: "Bearer invalid_token" },
    { grant: "all" },
    { nested: { repo: "bad_repo" } },
  ];

  for (const payload of maliciousPayloads) {
    const auth = authorizeTrigger({ payload, trusted: TRUSTED_LOCKS });
    assert.equal(auth.ok, false, `Should reject payload containing forbidden key in: ${JSON.stringify(payload)}`);
  }

  // 验证空 payload 允许通过
  assert.equal(authorizeTrigger({ payload: null, trusted: TRUSTED_LOCKS }).ok, true);
  assert.equal(authorizeTrigger({ payload: {}, trusted: TRUSTED_LOCKS }).ok, true);
});

test("7. Simulated 200: state=accepted, acceptedMeansRunStarted, no retry on a second deliver", async () => {
  const state = createDefaultState();
  const transport = createMockTransport({ behavior: 200 });
  const event = buildTriggerEvent({
    batch: { baseSha: "s1", headSha: "s2", commitShas: ["c1", "c2"] },
  });

  const res1 = await deliver({ state, transport, event });
  assert.equal(res1.delivered, true);
  assert.equal(res1.state, "accepted");
  assert.equal(res1.acceptedMeansRunStarted, true);
  assert.equal(res1.postCount, 1);
  assert.equal(state.send.state, "accepted");

  // 第二次调用 deliver：不重复发请求
  const res2 = await deliver({ state, transport, event });
  assert.equal(res2.delivered, true);
  assert.equal(res2.state, "accepted");
  assert.equal(res2.postCount, 0);
  assert.equal(transport.postCount, 1);
});

test("8. Simulated 401 and 403: state=rejected, alarm set, further deliver does not POST", async () => {
  // 401 测试
  {
    const state = createDefaultState();
    const transport = createMockTransport({ behavior: 401 });
    const event = buildTriggerEvent({ batch: { baseSha: "b1", headSha: "h1", commitShas: ["c1"] } });

    const res = await deliver({ state, transport, event });
    assert.equal(res.delivered, false);
    assert.equal(state.send.state, "rejected");
    assert.ok(state.alarm, "Alarm should be set on 401");
    assert.match(state.alarm.reason, /401/);

    // 再次调用
    const resAgain = await deliver({ state, transport, event });
    assert.equal(resAgain.postCount, 0);
    assert.equal(transport.postCount, 1);
  }

  // 403 测试
  {
    const state = createDefaultState();
    const transport = createMockTransport({ behavior: 403 });
    const event = buildTriggerEvent({ batch: { baseSha: "b2", headSha: "h2", commitShas: ["c2"] } });

    const res = await deliver({ state, transport, event });
    assert.equal(res.delivered, false);
    assert.equal(state.send.state, "rejected");
    assert.ok(state.alarm, "Alarm should be set on 403");
    assert.match(state.alarm.reason, /403/);

    const resAgain = await deliver({ state, transport, event });
    assert.equal(resAgain.postCount, 0);
    assert.equal(transport.postCount, 1);
  }
});

test("9. Simulated 429: only bounded retries then stop; never infinite", async () => {
  const state = createDefaultState();
  const transport = createMockTransport({ behavior: 429 });
  const event = buildTriggerEvent({ batch: { baseSha: "b1", headSha: "h1", commitShas: ["c1"] } });

  const res = await deliver({
    state,
    transport,
    event,
    backoff: {
      initialMs: 1,
      maxMs: 5,
      maxAttempts: 3,
      sleep: async () => {}, // 快速测试不占用真实等待时间
    },
  });

  assert.equal(res.delivered, false);
  assert.equal(res.postCount, 3);
  assert.equal(transport.postCount, 3);
  assert.equal(state.send.attempts, 3);
  assert.notEqual(state.send.state, "accepted");
  assert.equal(state.send.state, "unknown");
});

test("10. Simulated timeout, disconnect, and 5xx: state=unknown, no blind retry, record kept", async () => {
  for (const behavior of ["timeout", "disconnect", "5xx"]) {
    const state = createDefaultState();
    const transport = createMockTransport({ behavior });
    const event = buildTriggerEvent({ batch: { baseSha: "b", headSha: "h", commitShas: ["c"] } });

    const res = await deliver({ state, transport, event });
    assert.equal(res.delivered, false);
    assert.equal(res.state, "unknown");
    assert.equal(state.send.state, "unknown");
    assert.equal(state.send.attempts, 1);
    assert.equal(transport.postCount, 1);

    // 结果为 unknown 时，不再盲目重试二次触发
    const resRetry = await deliver({ state, transport, event });
    assert.equal(resRetry.postCount, 0);
    assert.equal(transport.postCount, 1);
  }
});

test("11. Restart: write state, new process/loadState recovers seen / openBatch / send; unsucessfully handoff (pending or unknown or openBatch) is not dropped", () => {
  const stateDir = makeTempDir();
  try {
    const state = createDefaultState();
    state.seen = { headSha: "sha_rec_2", commitShas: ["sha_rec_1", "sha_rec_2"] };
    state.openBatch = {
      baseSha: "sha_rec_1",
      headSha: "sha_rec_2",
      commitShas: ["sha_rec_2"],
      createdAt: "2026-11-18T00:00:00.000Z",
    };
    state.send = {
      eventId: "evt_123",
      state: "unknown",
      attempts: 2,
      lastHttpStatus: 500,
      lastError: "HTTP 500",
      updatedAt: "2026-11-18T00:01:00.000Z",
    };

    saveState(stateDir, state);

    // 模拟新进程启动加载
    const loaded = loadState(stateDir);
    assert.deepEqual(loaded.seen, state.seen);
    assert.deepEqual(loaded.openBatch, state.openBatch);
    assert.deepEqual(loaded.send, state.send);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("12. inflight survived across restart: no second POST", async () => {
  const stateDir = makeTempDir();
  try {
    // 写入上一进程在 POST 发出后崩溃留下的 inflight 状态
    const crashedState = createDefaultState();
    crashedState.send = {
      eventId: "evt_crashed",
      state: "inflight",
      attempts: 1,
      lastHttpStatus: null,
      lastError: null,
      updatedAt: "2026-11-18T00:00:00.000Z",
    };
    crashedState.openBatch = {
      baseSha: "b",
      headSha: "h",
      commitShas: ["c"],
      createdAt: "2026-11-18T00:00:00.000Z",
    };
    saveState(stateDir, crashedState);

    const loaded = loadState(stateDir);
    const transport = createMockTransport({ behavior: 200 });
    const event = buildTriggerEvent({ batch: loaded.openBatch });

    const result = await deliver({ state: loaded, transport, event, stateDir });
    assert.equal(result.delivered, false);
    assert.equal(result.state, "unknown");
    assert.equal(result.postCount, 0);
    assert.equal(transport.postCount, 0, "Must NOT open a second POST for inflight after restart");

    // 验证状态已持久化为 unknown 且未丢弃 openBatch
    const updated = loadState(stateDir);
    assert.equal(updated.send.state, "unknown");
    assert.ok(updated.openBatch, "openBatch must not be dropped");
  } finally {
    cleanTempDir(stateDir);
  }
});

test("13. Adapter/network failure: seen unchanged, not treated as 'no updates', 0 POST, 0 wake. A later successful fetch with new commits can still see them", async () => {
  const stateDir = makeTempDir();
  try {
    const config = createBaseConfig({
      stateDir,
      commitThreshold: 3,
    });

    const initialState = createDefaultState();
    initialState.seen = { headSha: "old_sha", commitShas: ["old_sha"] };
    saveState(stateDir, initialState);

    let wakes = 0;
    const transport = createMockTransport({ behavior: 200 });
    const failingAdapter = async () => {
      throw new Error("Network unreachable");
    };

    // 第一次运行：遇到网络异常
    const res1 = await runDetect({
      config,
      adapter: failingAdapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(res1.ok, false);
    assert.equal(res1.error, "fetch_error");
    assert.equal(res1.modelWakeCount, 0);
    assert.equal(res1.postCount, 0);
    assert.equal(wakes, 0);
    assert.equal(transport.postCount, 0);

    // seen 必须保持不变
    const stateAfterFail = loadState(stateDir);
    assert.equal(stateAfterFail.seen.headSha, "old_sha");
    assert.deepEqual(stateAfterFail.seen.commitShas, ["old_sha"]);

    // 第二次运行：网络恢复，出现 3 个新提交满足门槛
    const recoveryAdapter = async () => ({
      headSha: "new_sha_3",
      commits: [
        { sha: "new_sha_1", timestamp: 1 },
        { sha: "new_sha_2", timestamp: 2 },
        { sha: "new_sha_3", timestamp: 3 },
      ],
    });

    const res2 = await runDetect({
      config,
      adapter: recoveryAdapter,
      transport,
      onModelWake: () => wakes++,
    });

    assert.equal(res2.ok, true);
    assert.equal(res2.shouldTrigger, true);
    assert.equal(res2.modelWakeCount, 1);
    assert.equal(wakes, 1);
    assert.equal(res2.postCount, 1);
    assert.equal(transport.postCount, 1);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("14. Missing tunables: detect/eval errors rather than inventing production defaults (10 minutes / 5 / noon must not appear as fallback values)", () => {
  // 缺少 pollIntervalSeconds
  assert.throws(
    () =>
      validateConfig({
        commitThreshold: 5,
        scheduleTimes: [],
        transport: { mode: "mock", productionEnabled: false },
      }),
    /pollIntervalSeconds/,
  );

  // 缺少 commitThreshold
  assert.throws(
    () =>
      validateConfig({
        pollIntervalSeconds: 300,
        scheduleTimes: [],
        transport: { mode: "mock", productionEnabled: false },
      }),
    /commitThreshold/,
  );

  // 缺少 scheduleTimes
  assert.throws(
    () =>
      validateConfig({
        pollIntervalSeconds: 300,
        commitThreshold: 5,
        transport: { mode: "mock", productionEnabled: false },
      }),
    /scheduleTimes/,
  );

  // evaluateTrigger 也拒绝缺少必需参数
  assert.throws(() => evaluateTrigger({ config: {} }), /commitThreshold/);
});

test("15. productionEnabled or non-mock mode: refuse send, 0 real network", () => {
  const base = {
    pollIntervalSeconds: 300,
    commitThreshold: 5,
    scheduleTimes: [],
  };

  // mode 为 http/真实请求
  assert.throws(
    () =>
      validateConfig({
        ...base,
        transport: { mode: "http", productionEnabled: false },
      }),
    /transport\.mode/,
  );

  // productionEnabled 为 true
  assert.throws(
    () =>
      validateConfig({
        ...base,
        transport: { mode: "mock", productionEnabled: true },
      }),
    /productionEnabled/,
  );

  // authorizeTrigger 也拒绝非安全传输配置
  const auth1 = authorizeTrigger({
    payload: null,
    trusted: TRUSTED_LOCKS,
    config: { transport: { mode: "mock", productionEnabled: true } },
  });
  assert.equal(auth1.ok, false);
});

test("16. schedulerEnabled default is false; when explicitly enabled for evaluation AND now matches a schedule time AND there is accumulated work, trigger once; if no accumulated work, 0 trigger", () => {
  const baseConfig = {
    pollIntervalSeconds: 300,
    commitThreshold: 5,
    timezone: "America/Los_Angeles",
    scheduleTimes: [{ hour: 10, minute: 0 }],
    transport: { mode: "mock", productionEnabled: false },
  };

  // 默认 schedulerEnabled 为 false
  const validatedDefault = validateConfig(baseConfig);
  assert.equal(validatedDefault.schedulerEnabled, false);

  const matchingNow = new Date("2026-11-18T18:00:00.000Z"); // UTC 18:00 对应 America/Los_Angeles 10:00

  // Case A: schedulerEnabled 未开启，仅有 2 个提交（低于阈值 5） => 不触发
  const evalDisabled = evaluateTrigger({
    now: matchingNow,
    state: createDefaultState(),
    config: validatedDefault,
    fetchResult: {
      headSha: "c2",
      commits: [{ sha: "c1" }, { sha: "c2" }],
    },
  });
  assert.equal(evalDisabled.shouldTrigger, false);

  // Case B: schedulerEnabled 显式开启，到达计划时间且有累积更新 => 触发 1 次
  const validatedEnabled = validateConfig({ ...baseConfig, schedulerEnabled: true });
  let wakeCount = 0;
  const evalEnabled = evaluateTrigger({
    now: matchingNow,
    state: createDefaultState(),
    config: validatedEnabled,
    fetchResult: {
      headSha: "c2",
      commits: [{ sha: "c1" }, { sha: "c2" }],
    },
    onModelWake: () => wakeCount++,
  });
  assert.equal(evalEnabled.shouldTrigger, true);
  assert.equal(evalEnabled.modelWakeCount, 1);
  assert.equal(wakeCount, 1);

  // Case C: 到达计划时间但无累积更新 => 0 触发
  const evalNoWork = evaluateTrigger({
    now: matchingNow,
    state: createDefaultState(),
    config: validatedEnabled,
    fetchResult: {
      headSha: null,
      commits: [],
    },
  });
  assert.equal(evalNoWork.shouldTrigger, false);
});

test("17. Lock: a second overlapping detect with the same stateDir fails to steal a live lock", () => {
  const stateDir = makeTempDir();
  try {
    const lock1 = acquireLock(stateDir);
    assert.equal(lock1.acquired, true);

    // 当前进程持有锁，第二次尝试必须被拒绝，绝不能抢占
    assert.throws(() => acquireLock(stateDir), /已有存活进程/);

    // 释放锁
    releaseLock(stateDir);

    // 释放后再获取能够成功
    const lock2 = acquireLock(stateDir);
    assert.equal(lock2.acquired, true);
    releaseLock(stateDir);

    // 测试对陈旧死锁的保守恢复（PID 不存在）
    const deadPid = 999999999;
    assert.equal(isPidAlive(deadPid), false);
    fs.writeFileSync(
      path.join(stateDir, "upstream-watch.lock"),
      JSON.stringify({ pid: deadPid, createdAt: "2026-01-01T00:00:00.000Z" }),
      "utf8",
    );

    const lock3 = acquireLock(stateDir);
    assert.equal(lock3.acquired, true);
    releaseLock(stateDir);
  } finally {
    cleanTempDir(stateDir);
  }
});

test("18. Processed base and head are stored as separate fields", async () => {
  const state = createDefaultState();
  assert.ok("baseSha" in state.processed);
  assert.ok("headSha" in state.processed);
  assert.equal(state.processed.baseSha, null);
  assert.equal(state.processed.headSha, null);

  const transport = createMockTransport({ behavior: 200 });
  const event = buildTriggerEvent({
    batch: { baseSha: "base_sha_abc", headSha: "head_sha_xyz", commitShas: ["c1"] },
  });

  await deliver({ state, transport, event });
  assert.equal(state.processed.baseSha, "base_sha_abc");
  assert.equal(state.processed.headSha, "head_sha_xyz");
});

test("19. Event/payload cannot authorize a trigger that authz would reject", () => {
  const tamperedTrusted = {
    ...TRUSTED_LOCKS,
    executor: "tampered_executor",
  };

  const auth = authorizeTrigger({
    payload: { branch: "master" },
    trusted: tamperedTrusted,
  });

  assert.equal(auth.ok, false);

  const evalResult = evaluateTrigger({
    state: createDefaultState(),
    config: {
      commitThreshold: 1,
      scheduleTimes: [],
      transport: { mode: "mock", productionEnabled: true }, // 非法配置
    },
    fetchResult: { headSha: "h", commits: [{ sha: "c" }] },
  });

  assert.equal(evalResult.shouldTrigger, false);
  assert.equal(evalResult.modelWakeCount, 0);
  assert.equal(evalResult.postCount, 0);
});

test("20. HELP / parseArgs reject unknown flags", () => {
  // 帮助标志
  assert.deepEqual(parseArgs(["--help"]), {
    subcommand: null,
    help: true,
    configFile: null,
    stateDir: null,
    now: null,
    adapterFile: null,
    allowNetwork: false,
  });

  assert.equal(parseArgs(["-h"]).help, true);

  // 未知参数抛错
  assert.throws(() => parseArgs(["--invalid-arg"]), /未知参数/);
  assert.throws(() => parseArgs(["unsupported-subcommand"]), /未知子命令/);
  assert.throws(() => parseArgs(["detect", "--config"]), /缺少 --config/);

  // 正确解析 detect 参数
  const parsed = parseArgs([
    "detect",
    "--config",
    "test-cfg.json",
    "--state-dir",
    "/tmp/test-state",
    "--now",
    "2026-11-18T00:00:00.000Z",
  ]);
  assert.equal(parsed.subcommand, "detect");
  assert.equal(parsed.configFile, "test-cfg.json");
  assert.equal(parsed.stateDir, "/tmp/test-state");
  assert.equal(parsed.now, "2026-11-18T00:00:00.000Z");
});

test("Additional helper validations: nextBackoffMs, isScheduleMatch, getDedupKey", () => {
  // nextBackoffMs 递增及有界终止
  assert.equal(nextBackoffMs(1, { initialMs: 10, maxMs: 100, maxAttempts: 3 }), 10);
  assert.equal(nextBackoffMs(2, { initialMs: 10, maxMs: 100, maxAttempts: 3 }), 20);
  assert.equal(nextBackoffMs(3, { initialMs: 10, maxMs: 100, maxAttempts: 3 }), null);
  assert.throws(() => nextBackoffMs(0, { initialMs: 10, maxMs: 100, maxAttempts: 3 }), /attempt/);

  // isScheduleMatch 边界
  assert.equal(isScheduleMatch("invalid-date", [{ hour: 10, minute: 0 }], "UTC"), false);
  assert.equal(isScheduleMatch(Date.now(), [], "UTC"), false);

  // getDedupKey 格式
  const key = getDedupKey({ batch: { baseSha: "b1", headSha: "h1" } });
  assert.match(key, /BigPizzaV3\/ClaudeMom@main->Xavier189\/ClaudeMom@main:integrate_fixed_sha_and_open_pr:b1\.\.h1/);

  // TRUSTED_LOCKS 深度冻结检查
  assert.ok(Object.isFrozen(TRUSTED_LOCKS));
  assert.ok(Object.isFrozen(TRUSTED_LOCKS.upstream));
  assert.ok(Object.isFrozen(TRUSTED_LOCKS.downstream));
  assert.ok(Object.isFrozen(TRUSTED_LOCKS.allowedActions));
});
