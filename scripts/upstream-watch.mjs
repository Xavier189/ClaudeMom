#!/usr/bin/env node
/**
 * scripts/upstream-watch.mjs
 *
 * CM-IMPL-001 (UNIT 1): 独立轻量上游监测模块 (Independent Lightweight Upstream Detector)
 *
 * 架构说明与可靠性契约：
 * 1. 运行在共享 Linux 环境，监测公共固定上游 BigPizzaV3/ClaudeMom 的 main 分支提交 SHA。
 * 2. 状态原子持久化于 stateDir（独占进程锁 + 原子写入 state.json）。
 * 3. 严格冻结可信锁（TRUSTED_LOCKS），不可被外部入参、环境变量、CLI 或外部负载覆盖。
 * 4. 平台幂等性说明：
 *    本模块不假定远程目标平台具备天然幂等性。我们不在此同时宣称“完全严格一次 (Exactly-once)”
 *    和“自动零丢失 (Automatic no-loss)”。若前次进程在 POST 发出后、结果确认前崩溃退出
 *    （即重启时检测到 send.state === "inflight"），本模块绝不盲目重试二次触发，而是将其状态
 *    转为 "unknown"，保留现场供人工对账，以杜绝意外重复触发。
 * 5. 安全与准入先行：
 *    触发判定与鉴权授权必须在任何模型唤醒计数 (onModelWake) 或网络投递 (deliver) 前完成。
 *    外部负载仅为纯数据，绝不能自我提权或修改可信锁。
 * 6. 传输模式：
 *    本单元仅开放 mock 传输，生产网络传输默认且强制关闭；禁止开启任何常驻守护进程或服务。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { formatOverlapSection } from "./sync-upstream.mjs";

/**
 * 严格冻结的可信锁定义 (不可被外部覆盖)
 */
export const TRUSTED_LOCKS = Object.freeze({
  upstream: Object.freeze({
    owner: "BigPizzaV3",
    repo: "ClaudeMom",
    ref: "main",
  }),
  downstream: Object.freeze({
    owner: "Xavier189",
    repo: "ClaudeMom",
    base: "main",
  }),
  executor: "千锤万凿",
  allowedActions: Object.freeze(["integrate_fixed_sha_and_open_pr"]),
});

const FORBIDDEN_PAYLOAD_KEYS = new Set([
  "repo",
  "repository",
  "owner",
  "upstream",
  "downstream",
  "branch",
  "ref",
  "base",
  "action",
  "actions",
  "route",
  "executor",
  "permission",
  "permissions",
  "authorization",
  "auth",
  "role",
  "roles",
  "allow",
  "grant",
  "token",
  "bearer",
  "privileged",
  "sudo",
  "admin",
]);

/**
 * 校验 IANA 时区字符串是否有效
 */
export function isValidTimezone(tz) {
  if (typeof tz !== "string" || tz.trim() === "") return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * 检查指定时刻是否与配置的计划时间（时:分）在指定时区内精确吻合
 */
export function isScheduleMatch(now, scheduleTimes, timezone) {
  if (!Array.isArray(scheduleTimes) || scheduleTimes.length === 0) {
    return false;
  }
  const date = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(date.getTime())) {
    return false;
  }

  for (const item of scheduleTimes) {
    const tz = item.timezone || timezone;
    if (!isValidTimezone(tz)) continue;
    try {
      const parts = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour: "numeric",
        minute: "numeric",
        hourCycle: "h23",
      }).formatToParts(date);

      let hour = -1;
      let minute = -1;
      for (const p of parts) {
        if (p.type === "hour") hour = parseInt(p.value, 10);
        if (p.type === "minute") minute = parseInt(p.value, 10);
      }
      if (hour === item.hour && minute === item.minute) {
        return true;
      }
    } catch {
      // 忽略无法格式化的时区异常
    }
  }
  return false;
}

/**
 * 检查当前系统进程 PID 是否存活（用于保守判断锁文件是否过期）
 */
export function isPidAlive(pid) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/**
 * 运行时可调配置严格校验（严禁静默默认生产数值）
 */
export function validateConfig(config) {
  if (!config || typeof config !== "object") {
    throw new Error("缺少配置对象 (Configuration object is required)");
  }

  if (
    typeof config.pollIntervalSeconds !== "number" ||
    !Number.isFinite(config.pollIntervalSeconds) ||
    config.pollIntervalSeconds <= 0
  ) {
    throw new Error("缺少必填配置：pollIntervalSeconds 必须为正数，不能使用默认值");
  }

  if (
    typeof config.commitThreshold !== "number" ||
    !Number.isInteger(config.commitThreshold) ||
    config.commitThreshold <= 0
  ) {
    throw new Error("缺少必填配置：commitThreshold 必须为正整数，不能使用默认值");
  }

  if (!Array.isArray(config.scheduleTimes)) {
    throw new Error("缺少必填配置：scheduleTimes 必须为数组，不能使用默认值");
  }

  for (const st of config.scheduleTimes) {
    if (
      !st ||
      typeof st !== "object" ||
      typeof st.hour !== "number" ||
      !Number.isInteger(st.hour) ||
      st.hour < 0 ||
      st.hour > 23 ||
      typeof st.minute !== "number" ||
      !Number.isInteger(st.minute) ||
      st.minute < 0 ||
      st.minute > 59
    ) {
      throw new Error("scheduleTimes 项格式错误：必须包含 hour (0-23) 与 minute (0-59)");
    }
  }

  if (config.scheduleTimes.length > 0) {
    const tz = config.timezone || config.scheduleTimezone;
    if (!isValidTimezone(tz)) {
      throw new Error(`scheduleTimes 配置缺少有效 IANA 时区字符串：${tz}`);
    }
  }

  if (config.schedulerEnabled !== undefined && typeof config.schedulerEnabled !== "boolean") {
    throw new Error("schedulerEnabled 必须为布尔值");
  }

  if (config.stateDir !== undefined && (typeof config.stateDir !== "string" || config.stateDir.trim() === "")) {
    throw new Error("stateDir 必须为非空路径字符串");
  }

  if (!config.transport || typeof config.transport !== "object") {
    throw new Error("缺少必填配置：transport 必须为对象 { mode: 'mock', productionEnabled: false }");
  }

  if (config.transport.mode !== "mock") {
    throw new Error(`本单元拒绝非 mock 传输模式：transport.mode "${config.transport.mode}" 不被允许`);
  }

  if (config.transport.productionEnabled !== false) {
    throw new Error("生产传输通道处于硬关闭状态：transport.productionEnabled 必须为 false");
  }

  return {
    ...config,
    schedulerEnabled: config.schedulerEnabled === true,
  };
}

/**
 * 递归检查对象中是否存在越权覆盖的敏感键
 */
function findForbiddenKey(obj) {
  if (!obj || typeof obj !== "object") return null;
  for (const key of Object.keys(obj)) {
    if (FORBIDDEN_PAYLOAD_KEYS.has(key.toLowerCase())) {
      return key;
    }
    if (typeof obj[key] === "object" && obj[key] !== null) {
      const nested = findForbiddenKey(obj[key]);
      if (nested) return nested;
    }
  }
  return null;
}

/**
 * 触发权限鉴权（在模型唤醒或 POST 前必须执行）
 */
export function authorizeTrigger({ payload, trusted, config }) {
  // 1. 可信锁匹配检查
  if (trusted) {
    if (
      trusted.upstream?.owner !== TRUSTED_LOCKS.upstream.owner ||
      trusted.upstream?.repo !== TRUSTED_LOCKS.upstream.repo ||
      trusted.upstream?.ref !== TRUSTED_LOCKS.upstream.ref ||
      trusted.downstream?.owner !== TRUSTED_LOCKS.downstream.owner ||
      trusted.downstream?.repo !== TRUSTED_LOCKS.downstream.repo ||
      trusted.downstream?.base !== TRUSTED_LOCKS.downstream.base ||
      trusted.executor !== TRUSTED_LOCKS.executor ||
      !Array.isArray(trusted.allowedActions) ||
      trusted.allowedActions.length !== 1 ||
      trusted.allowedActions[0] !== TRUSTED_LOCKS.allowedActions[0]
    ) {
      return { ok: false, reason: "trusted_locks_violation" };
    }
  }

  // 2. 传输配置安全性检查
  if (config?.transport) {
    if (config.transport.mode !== "mock" || config.transport.productionEnabled !== false) {
      return { ok: false, reason: "production_transport_not_allowed" };
    }
  }

  // 3. 外部 payload 越权字段扫描
  if (payload && typeof payload === "object") {
    const forbidden = findForbiddenKey(payload);
    if (forbidden) {
      return { ok: false, reason: `payload_attempted_override: ${forbidden}` };
    }
  }

  return { ok: true };
}

/**
 * 创建默认初始状态对象
 */
export function createDefaultState() {
  return {
    seen: {
      headSha: null,
      commitShas: [],
    },
    lastSuccessfulTrigger: null,
    processed: {
      baseSha: null,
      headSha: null,
    },
    openBatch: null,
    send: null,
    alarm: null,
  };
}

/**
 * 从磁盘读取状态 JSON
 */
export function loadState(stateDir) {
  const statePath = path.join(stateDir, "state.json");
  if (!fs.existsSync(statePath)) {
    return createDefaultState();
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      seen: {
        headSha: parsed?.seen?.headSha ?? null,
        commitShas: Array.isArray(parsed?.seen?.commitShas) ? [...parsed.seen.commitShas] : [],
      },
      lastSuccessfulTrigger: parsed?.lastSuccessfulTrigger
        ? {
            at: parsed.lastSuccessfulTrigger.at ?? null,
            eventId: parsed.lastSuccessfulTrigger.eventId ?? null,
            baseSha: parsed.lastSuccessfulTrigger.baseSha ?? null,
            headSha: parsed.lastSuccessfulTrigger.headSha ?? null,
          }
        : null,
      processed: {
        baseSha: parsed?.processed?.baseSha ?? null,
        headSha: parsed?.processed?.headSha ?? null,
      },
      openBatch: parsed?.openBatch
        ? {
            baseSha: parsed.openBatch.baseSha ?? null,
            headSha: parsed.openBatch.headSha ?? null,
            commitShas: Array.isArray(parsed.openBatch.commitShas) ? [...parsed.openBatch.commitShas] : [],
            createdAt: parsed.openBatch.createdAt ?? null,
          }
        : null,
      send: parsed?.send
        ? {
            eventId: parsed.send.eventId ?? null,
            state: parsed.send.state ?? null,
            attempts: parsed.send.attempts ?? 0,
            lastHttpStatus: parsed.send.lastHttpStatus ?? null,
            lastError: parsed.send.lastError ?? null,
            updatedAt: parsed.send.updatedAt ?? null,
          }
        : null,
      alarm: parsed?.alarm
        ? {
            at: parsed.alarm.at ?? null,
            reason: parsed.alarm.reason ?? null,
          }
        : null,
    };
  } catch (err) {
    throw new Error(`无法从 ${statePath} 读取或解析状态：${err.message}`);
  }
}

/**
 * 原子保存状态 JSON 至磁盘
 */
export function saveState(stateDir, state) {
  fs.mkdirSync(stateDir, { recursive: true });
  const statePath = path.join(stateDir, "state.json");
  const tmpPath = path.join(stateDir, `state.tmp.${process.pid}.${Date.now()}`);
  const data = JSON.stringify(state, null, 2);
  fs.writeFileSync(tmpPath, data, "utf8");
  fs.renameSync(tmpPath, statePath);
}

/**
 * 单实例排他锁：获取锁
 */
export function acquireLock(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true });
  const lockPath = path.join(stateDir, "upstream-watch.lock");
  const lockPayload = JSON.stringify({
    pid: process.pid,
    createdAt: new Date().toISOString(),
  });

  try {
    const fd = fs.openSync(lockPath, "wx");
    fs.writeSync(fd, lockPayload);
    fs.closeSync(fd);
    return { lockPath, acquired: true };
  } catch (err) {
    if (err.code !== "EEXIST") {
      throw err;
    }
  }

  // 锁文件已存在，保守读取
  let existing;
  try {
    const raw = fs.readFileSync(lockPath, "utf8");
    existing = JSON.parse(raw);
  } catch {
    throw new Error(`锁文件已存在且无法安全核验：${lockPath}`);
  }

  if (existing?.pid && isPidAlive(existing.pid)) {
    throw new Error(`已有存活进程（PID ${existing.pid}）持有锁：${lockPath}，严禁抢占`);
  }

  // 属已死进程残留的陈旧锁，安全清理后重试一次
  try {
    fs.unlinkSync(lockPath);
  } catch (unlinkErr) {
    if (unlinkErr.code !== "ENOENT") {
      throw new Error(`清理过期锁文件失败：${unlinkErr.message}`);
    }
  }

  const retryFd = fs.openSync(lockPath, "wx");
  fs.writeSync(retryFd, lockPayload);
  fs.closeSync(retryFd);
  return { lockPath, acquired: true };
}

/**
 * 单实例排他锁：释放锁
 */
export function releaseLock(stateDir) {
  const lockPath = path.join(stateDir, "upstream-watch.lock");
  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, "utf8");
      const data = JSON.parse(raw);
      if (data?.pid === process.pid) {
        fs.unlinkSync(lockPath);
      }
    }
  } catch {
    // 忽略释放过程中的非致命错误
  }
}

/**
 * 包装在排他锁内执行的回调
 */
export async function withLock(stateDir, fn) {
  acquireLock(stateDir);
  try {
    return await fn();
  } finally {
    releaseLock(stateDir);
  }
}

export class FetchNetworkError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "FetchNetworkError";
    this.cause = cause;
  }
}

/**
 * 上游拉取适配层（只向外抛出或返回，不调用真实 GitHub API）
 */
export async function fetchUpstream({ adapter, trusted = TRUSTED_LOCKS, seenHead = null }) {
  if (!adapter) {
    throw new FetchNetworkError("未注入 fetch adapter 且离线单元禁用网络请求");
  }

  try {
    let result;
    if (typeof adapter === "function") {
      result = await adapter({ trusted, seenHead });
    } else if (adapter && typeof adapter.fetch === "function") {
      result = await adapter.fetch({ trusted, seenHead });
    } else {
      throw new Error("提供的 adapter 不合法（需为函数或具备 fetch 方法的对象）");
    }

    if (!result || typeof result !== "object") {
      throw new Error("adapter 返回空或非对象结果");
    }

    return {
      headSha: result.headSha ?? null,
      commits: Array.isArray(result.commits) ? [...result.commits] : [],
    };
  } catch (err) {
    throw new FetchNetworkError(`上游拉取失败（网络/适配器异常）：${err.message}`, err);
  }
}

/**
 * 构建幂等去重键
 */
export function getDedupKey(eventOrBatch) {
  const batch = eventOrBatch?.batch || eventOrBatch;
  const baseSha = batch?.baseSha ?? "null";
  const headSha = batch?.headSha ?? "null";
  return `${TRUSTED_LOCKS.upstream.owner}/${TRUSTED_LOCKS.upstream.repo}@${TRUSTED_LOCKS.upstream.ref}->${TRUSTED_LOCKS.downstream.owner}/${TRUSTED_LOCKS.downstream.repo}@${TRUSTED_LOCKS.downstream.base}:${TRUSTED_LOCKS.allowedActions[0]}:${baseSha}..${headSha}`;
}

/**
 * 构建触发事件 Payload（从 TRUSTED_LOCKS 硬编码复制元数据，绝不采信外部提权）
 */
export function buildTriggerEvent({ batch, trusted = TRUSTED_LOCKS, now = Date.now(), eventId = null } = {}) {
  const timestamp = typeof now === "number" ? now : new Date(now).getTime();
  const resolvedEventId = eventId || `evt_${timestamp}_${(batch?.headSha || "sha").slice(0, 8)}`;
  return {
    id: resolvedEventId,
    eventId: resolvedEventId,
    createdAt: new Date(timestamp).toISOString(),
    executor: trusted.executor,
    action: trusted.allowedActions[0],
    upstream: {
      owner: trusted.upstream.owner,
      repo: trusted.upstream.repo,
      ref: trusted.upstream.ref,
    },
    downstream: {
      owner: trusted.downstream.owner,
      repo: trusted.downstream.repo,
      base: trusted.downstream.base,
    },
    batch: {
      baseSha: batch.baseSha,
      headSha: batch.headSha,
      commitShas: [...batch.commitShas],
      count: batch.commitShas.length,
    },
    note: "Data payload only; does not grant permissions or override trusted locks.",
  };
}

/**
 * 触发条件断言评估（必须在任何唤醒或投递前执行）
 */
export function evaluateTrigger({ now = Date.now(), state, config, fetchResult, onModelWake } = {}) {
  // 1. 严格校验配置项（严禁使用隐式默认值）
  if (!config || typeof config !== "object") {
    throw new Error("evaluateTrigger 缺少必填 config 对象");
  }
  if (
    typeof config.commitThreshold !== "number" ||
    !Number.isInteger(config.commitThreshold) ||
    config.commitThreshold <= 0
  ) {
    throw new Error("evaluateTrigger 缺少必填配置：commitThreshold 必须为正整数");
  }
  if (!Array.isArray(config.scheduleTimes)) {
    throw new Error("evaluateTrigger 缺少必填配置：scheduleTimes 必须为数组");
  }

  // 2. 鉴权与安全门禁
  const auth = authorizeTrigger({ payload: null, trusted: TRUSTED_LOCKS, config });
  if (!auth.ok) {
    return {
      shouldTrigger: false,
      reason: `authz_failed: ${auth.reason}`,
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  // 3. 告警阻断检查
  if (state?.alarm) {
    return {
      shouldTrigger: false,
      reason: `alarm_active: ${state.alarm.reason}`,
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  // 4. 统计未在 seen 中出现的新提交
  const seenShas = new Set(state?.seen?.commitShas || []);
  const allCommits = fetchResult?.commits || [];
  const newCommits = allCommits.filter((c) => c && c.sha && !seenShas.has(c.sha));

  if (newCommits.length === 0) {
    return {
      shouldTrigger: false,
      reason: "no_new_commits",
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  const thresholdMet = newCommits.length >= config.commitThreshold;
  const scheduleHit =
    config.schedulerEnabled === true &&
    isScheduleMatch(now, config.scheduleTimes, config.timezone || config.scheduleTimezone);

  if (!thresholdMet && !scheduleHit) {
    return {
      shouldTrigger: false,
      reason: "threshold_not_met",
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  const batchHead = fetchResult?.headSha || newCommits[newCommits.length - 1].sha;
  const batchBase = state?.seen?.headSha ?? null;
  const batch = {
    baseSha: batchBase,
    headSha: batchHead,
    commitShas: newCommits.map((c) => c.sha),
    createdAt: new Date(now).toISOString(),
  };

  // 重复或已交付批次过滤
  if (
    state?.lastSuccessfulTrigger &&
    state.lastSuccessfulTrigger.baseSha === batch.baseSha &&
    state.lastSuccessfulTrigger.headSha === batch.headSha
  ) {
    return {
      shouldTrigger: false,
      reason: "batch_already_triggered",
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  if (
    state?.openBatch &&
    state.openBatch.baseSha === batch.baseSha &&
    state.openBatch.headSha === batch.headSha &&
    state.send &&
    ["accepted", "rejected", "unknown", "inflight"].includes(state.send.state)
  ) {
    return {
      shouldTrigger: false,
      reason: `existing_batch_in_${state.send.state}_state`,
      batch: null,
      modelWakeCount: 0,
      postCount: 0,
    };
  }

  if (typeof onModelWake === "function") {
    onModelWake({ batch, reason: thresholdMet ? "commit_threshold" : "schedule_time" });
  }

  return {
    shouldTrigger: true,
    reason: thresholdMet ? "commit_threshold_reached" : "schedule_time_reached",
    batch,
    modelWakeCount: 1,
    postCount: 0,
  };
}

/**
 * 429 退避延迟计算（有界递增，达到上限后返回 null）
 */
export function nextBackoffMs(attempt, { initialMs, maxMs, maxAttempts }) {
  if (typeof attempt !== "number" || attempt < 1) {
    throw new Error("attempt 必须为大于等于 1 的整数");
  }
  if (attempt >= maxAttempts) {
    return null;
  }
  return Math.min(maxMs, initialMs * Math.pow(2, attempt - 1));
}

/**
 * 创建离线 Mock 传输器（绝不打开真实网络 Socket）
 */
export function createMockTransport({ behavior = 200 } = {}) {
  const calls = [];
  return {
    calls,
    get postCount() {
      return calls.length;
    },
    async post(event) {
      const attempt = calls.length + 1;
      calls.push({ event, attempt, timestamp: Date.now() });

      let result = behavior;
      if (typeof behavior === "function") {
        result = behavior(attempt);
      }

      if (result instanceof Error) {
        throw result;
      }
      if (typeof result === "string") {
        if (result === "timeout" || result === "disconnect") {
          const err = new Error(result);
          err.code = result.toUpperCase();
          throw err;
        }
        if (result === "5xx") {
          return { status: 500, statusText: "Internal Server Error" };
        }
      }
      if (typeof result === "number") {
        return { status: result, statusText: String(result) };
      }
      if (result && typeof result.status === "number") {
        return result;
      }
      return { status: 200, statusText: "OK" };
    },
  };
}

/**
 * 事件投递状态机
 */
export async function deliver({
  state,
  transport,
  event,
  now = Date.now(),
  backoff = { initialMs: 10, maxMs: 100, maxAttempts: 3 },
  stateDir,
} = {}) {
  let postCount = 0;
  const currentTime = new Date(now).toISOString();

  // 1. 已成功接受，不再重发
  if (state.send?.state === "accepted") {
    return {
      delivered: true,
      state: "accepted",
      postCount: 0,
      reason: "already_accepted",
      acceptedMeansRunStarted: true,
    };
  }

  // 2. 已被拒，保持告警不再重发
  if (state.send?.state === "rejected") {
    return {
      delivered: false,
      state: "rejected",
      postCount: 0,
      reason: "already_rejected",
    };
  }

  if (state.alarm) {
    return {
      delivered: false,
      state: state.send?.state || "rejected",
      postCount: 0,
      reason: "alarm_active",
    };
  }

  // 3. 结果未知（超时、断连、5xx），绝不盲目重发，保留状态待人工对账
  if (state.send?.state === "unknown") {
    return {
      delivered: false,
      state: "unknown",
      postCount: 0,
      reason: "prior_delivery_unknown_no_blind_retry",
    };
  }

  // 4. 重启后残留的 inflight 状态：上一进程可能在 POST 后崩溃，结果未知。
  // 绝不盲目重发第二次，直接转为 unknown
  if (state.send?.state === "inflight") {
    state.send.state = "unknown";
    state.send.lastError = "inflight_on_restart_outcome_unknown";
    state.send.updatedAt = currentTime;
    if (stateDir) saveState(stateDir, state);
    return {
      delivered: false,
      state: "unknown",
      postCount: 0,
      reason: "inflight_on_restart_treated_as_unknown",
    };
  }

  // 5. 初始投递准备
  const eventId = event?.id || event?.eventId || `evt_${Date.now()}`;
  if (!state.send) {
    state.send = {
      eventId,
      state: "pending",
      attempts: 0,
      lastHttpStatus: null,
      lastError: null,
      updatedAt: currentTime,
    };
    if (stateDir) saveState(stateDir, state);
  }

  const initialMs = backoff?.initialMs ?? 10;
  const maxMs = backoff?.maxMs ?? 100;
  const maxAttempts = backoff?.maxAttempts ?? 3;
  const sleepFn = backoff?.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  while (true) {
    state.send.state = "inflight";
    state.send.attempts += 1;
    state.send.updatedAt = new Date().toISOString();
    if (stateDir) saveState(stateDir, state);

    let res;
    try {
      postCount += 1;
      res = await transport.post(event);
    } catch (err) {
      state.send.state = "unknown";
      state.send.lastHttpStatus = null;
      state.send.lastError = err?.message || "network_or_transport_error";
      state.send.updatedAt = new Date().toISOString();
      if (stateDir) saveState(stateDir, state);
      return {
        delivered: false,
        state: "unknown",
        postCount,
        reason: "transport_error_treated_as_unknown",
      };
    }

    const status = res?.status;

    // HTTP 200 => accepted，注意：200 表示触发任务已启动，非执行完毕
    if (status === 200) {
      state.send.state = "accepted";
      state.send.lastHttpStatus = 200;
      state.send.lastError = null;
      state.send.updatedAt = new Date().toISOString();
      state.lastSuccessfulTrigger = {
        at: state.send.updatedAt,
        eventId,
        baseSha: event?.batch?.baseSha ?? null,
        headSha: event?.batch?.headSha ?? null,
      };
      state.processed = {
        baseSha: event?.batch?.baseSha ?? null,
        headSha: event?.batch?.headSha ?? null,
      };
      state.openBatch = null;
      if (stateDir) saveState(stateDir, state);
      return {
        delivered: true,
        state: "accepted",
        postCount,
        acceptedMeansRunStarted: true,
      };
    }

    // HTTP 401 / 403 => rejected，停发并设置告警
    if (status === 401 || status === 403) {
      state.send.state = "rejected";
      state.send.lastHttpStatus = status;
      state.send.lastError = `HTTP ${status}`;
      state.send.updatedAt = new Date().toISOString();
      state.alarm = {
        at: state.send.updatedAt,
        reason: `HTTP ${status} unauthorized/forbidden`,
      };
      if (stateDir) saveState(stateDir, state);
      return {
        delivered: false,
        state: "rejected",
        postCount,
        reason: "rejected_alarm",
      };
    }

    // HTTP 429 => 有界退避
    if (status === 429) {
      state.send.lastHttpStatus = 429;
      state.send.lastError = "HTTP 429";
      state.send.updatedAt = new Date().toISOString();

      const delay = nextBackoffMs(state.send.attempts, { initialMs, maxMs, maxAttempts });
      if (delay === null) {
        state.send.state = "unknown";
        state.send.lastError = "HTTP 429 Rate limited: max retries reached";
        if (stateDir) saveState(stateDir, state);
        return {
          delivered: false,
          state: "unknown",
          postCount,
          reason: "rate_limit_max_attempts_reached",
        };
      }

      await sleepFn(delay);
      continue;
    }

    // timeout / disconnect / 5xx => unknown，不盲目重试
    state.send.state = "unknown";
    state.send.lastHttpStatus = status || 500;
    state.send.lastError = res?.statusText || `HTTP ${status}`;
    state.send.updatedAt = new Date().toISOString();
    if (stateDir) saveState(stateDir, state);
    return {
      delivered: false,
      state: "unknown",
      postCount,
      reason: "server_error_treated_as_unknown",
    };
  }
}

/**
 * 只读上游 SHA 查询适配器（仅用于 --allow-network，绝不写 refs、绝不 push、绝不 POST）
 */
export function createReadonlyUpstreamFetchAdapter({ git } = {}) {
  const upstreamOwner = TRUSTED_LOCKS.upstream.owner;
  const upstreamRepo = TRUSTED_LOCKS.upstream.repo;
  const upstreamRef = TRUSTED_LOCKS.upstream.ref;
  const remoteUrl = `https://github.com/${upstreamOwner}/${upstreamRepo}.git`;
  const targetRef = `refs/heads/${upstreamRef}`;

  return async function readonlyUpstreamFetchAdapter({ seenHead = null } = {}) {
    let stdout;
    if (typeof git === "function") {
      const res = await git(["ls-remote", remoteUrl, targetRef]);
      stdout = typeof res === "string" ? res : res?.stdout || "";
    } else if (git && typeof git.exec === "function") {
      const res = await git.exec(["ls-remote", remoteUrl, targetRef]);
      stdout = typeof res === "string" ? res : res?.stdout || "";
    } else {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const execFileAsync = promisify(execFile);
      const res = await execFileAsync("git", ["ls-remote", remoteUrl, targetRef], {
        timeout: 15000,
        maxBuffer: 1024 * 1024,
      });
      stdout = res.stdout;
    }

    const trimmed = (stdout || "").trim();
    if (!trimmed) {
      return { headSha: null, commits: [] };
    }
    const lines = trimmed.split("\n");
    for (const line of lines) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && (!ref || ref === targetRef)) {
        return {
          headSha: sha,
          commits: [{ sha }],
        };
      }
    }
    return { headSha: null, commits: [] };
  };
}

/**
 * 单次检测执行主流程 (One-shot runDetect)
 */
export async function runDetect({
  config,
  now = Date.now(),
  adapter,
  transport,
  onModelWake,
  backoff,
  allowNetwork = false,
  git = null,
} = {}) {
  const validConfig = validateConfig(config);
  if (!validConfig.stateDir) {
    throw new Error("runDetect 需要在 config 中指定 stateDir");
  }

  const transportInstance = transport || createMockTransport({ behavior: 200 });

  acquireLock(validConfig.stateDir);
  try {
    const state = loadState(validConfig.stateDir);

    // 重启后残留的 inflight 状态：上一进程可能在 POST 后崩溃，结果未知。
    // 严禁盲目重发第二次，转换为 unknown 且持久化保留现场
    if (state.send?.state === "inflight") {
      state.send.state = "unknown";
      state.send.lastError = "inflight_on_restart_outcome_unknown";
      state.send.updatedAt = new Date(now).toISOString();
      saveState(validConfig.stateDir, state);
    }

    // 1. 触发前鉴权授权（准入先行门禁）
    const auth = authorizeTrigger({ payload: null, trusted: TRUSTED_LOCKS, config: validConfig });
    if (!auth.ok) {
      return {
        ok: false,
        reason: `authz_failed: ${auth.reason}`,
        shouldTrigger: false,
        modelWakeCount: 0,
        postCount: 0,
        state,
      };
    }

    // 2. 告警激活检查
    if (state.alarm) {
      return {
        ok: true,
        shouldTrigger: false,
        reason: `alarm_active: ${state.alarm.reason}`,
        batch: null,
        modelWakeCount: 0,
        postCount: 0,
        state,
      };
    }

    // 3. 恢复未完成的待投递批次 (Resume unposted pending handoff)
    // 若 openBatch 存在且 send 缺失或为 pending（未观察到 POST），在鉴权通过后直接恢复投递该现有批次，
    // 无需等待新的上游提交，且绝不产生新的 event / batch。
    const hasPendingBatch = Boolean(state.openBatch && (!state.send || state.send.state === "pending"));
    if (hasPendingBatch) {
      const batchToResume = state.openBatch;
      const event = buildTriggerEvent({
        batch: batchToResume,
        trusted: TRUSTED_LOCKS,
        now,
        eventId: state.send?.eventId,
      });

      const deliverResult = await deliver({
        state,
        transport: transportInstance,
        event,
        now,
        backoff: backoff || validConfig.backoff,
        stateDir: validConfig.stateDir,
      });
      saveState(validConfig.stateDir, state);

      return {
        ok: true,
        shouldTrigger: true,
        reason: "resumed_pending_batch",
        batch: batchToResume,
        modelWakeCount: 0,
        postCount: deliverResult.postCount,
        deliverResult,
        state,
      };
    }

    // 4. 若开启 --allow-network 且未注入 adapter，使用只读检测适配器
    let activeAdapter = adapter;
    if (!activeAdapter && allowNetwork) {
      activeAdapter = createReadonlyUpstreamFetchAdapter({ git });
    }

    // 5. 常规上游拉取与检测
    let fetchResult;
    try {
      fetchResult = await fetchUpstream({
        adapter: activeAdapter,
        trusted: TRUSTED_LOCKS,
        seenHead: state.seen?.headSha ?? null,
      });
    } catch (fetchErr) {
      // 适配器/网络异常：严禁更新 seen，严禁标记“无更新”，严禁触发与 POST
      return {
        ok: false,
        error: "fetch_error",
        message: fetchErr.message,
        shouldTrigger: false,
        modelWakeCount: 0,
        postCount: 0,
        state,
      };
    }

    const evalResult = evaluateTrigger({
      now,
      state,
      config: validConfig,
      fetchResult,
      onModelWake,
    });

    let postCount = 0;
    let deliverResult = null;

    if (evalResult.shouldTrigger && evalResult.batch) {
      state.openBatch = evalResult.batch;
      state.seen.headSha = fetchResult.headSha;
      for (const commit of fetchResult.commits || []) {
        if (!state.seen.commitShas.includes(commit.sha)) {
          state.seen.commitShas.push(commit.sha);
        }
      }
      saveState(validConfig.stateDir, state);

      const event = buildTriggerEvent({
        batch: evalResult.batch,
        trusted: TRUSTED_LOCKS,
        now,
      });

      deliverResult = await deliver({
        state,
        transport: transportInstance,
        event,
        now,
        backoff: backoff || validConfig.backoff,
        stateDir: validConfig.stateDir,
      });
      postCount = deliverResult.postCount;
      saveState(validConfig.stateDir, state);
    } else {
      // 未满足触发门槛或无更新：成功拉取后允许更新已观察到的 commits
      if (fetchResult.headSha) {
        state.seen.headSha = fetchResult.headSha;
      }
      for (const commit of fetchResult.commits || []) {
        if (!state.seen.commitShas.includes(commit.sha)) {
          state.seen.commitShas.push(commit.sha);
        }
      }
      saveState(validConfig.stateDir, state);
    }

    return {
      ok: true,
      shouldTrigger: evalResult.shouldTrigger,
      reason: evalResult.reason,
      batch: evalResult.batch,
      modelWakeCount: evalResult.modelWakeCount,
      postCount,
      deliverResult,
      state,
    };
  } finally {
    releaseLock(validConfig.stateDir);
  }
}

const PROTECTED_INTEGRATION_BRANCHES = Object.freeze(new Set(["main", "upstream-main", "sync/upstream-main"]));

const HOT_CUSTOM_FILES = Object.freeze([
  "apps/claude-mom/src-tauri/src/upstreams.rs",
  "crates/claude-local/src/backend.rs",
  "apps/claude-mom/src/model.ts",
  "crates/claude-local/runtime/proxy.mjs",
  "scripts/check-invariants.mjs",
]);

/**
 * 候选集成固定 SHA (仅在指定的临时仓库执行，绝不操作宿主 dev 仓库)
 */
export async function integrateFixedSha({
  repoDir,
  baseRef = "main",
  upstreamSha,
  workBranch,
  testRunner,
  git,
  repair,
} = {}) {
  if (!repoDir || typeof repoDir !== "string" || repoDir.trim() === "") {
    throw new Error("Missing required argument: repoDir (must be a non-empty path)");
  }
  if (!workBranch || typeof workBranch !== "string" || workBranch.trim() === "") {
    throw new Error("Missing required argument: workBranch");
  }

  const trimmedBranch = workBranch.trim();
  if (PROTECTED_INTEGRATION_BRANCHES.has(trimmedBranch)) {
    throw new Error(`Refusing to use protected branch "${trimmedBranch}" as workBranch`);
  }

  if (!upstreamSha || typeof upstreamSha !== "string" || upstreamSha.trim() === "") {
    throw new Error("Missing required argument: upstreamSha");
  }

  const trimmedUpstreamSha = upstreamSha.trim();
  const targetBaseRef = (baseRef && typeof baseRef === "string" && baseRef.trim()) ? baseRef.trim() : "main";

  const runGit = async (args) => {
    if (typeof git === "function") {
      const res = await git(args, { cwd: repoDir });
      if (typeof res === "string") {
        return { status: 0, stdout: res, stderr: "" };
      }
      return {
        status: res?.status ?? 0,
        stdout: res?.stdout || "",
        stderr: res?.stderr || "",
      };
    } else if (git && typeof git.exec === "function") {
      const res = await git.exec(args, { cwd: repoDir });
      if (typeof res === "string") {
        return { status: 0, stdout: res, stderr: "" };
      }
      return {
        status: res?.status ?? 0,
        stdout: res?.stdout || "",
        stderr: res?.stderr || "",
      };
    }
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile(
        "git",
        args,
        {
          cwd: repoDir,
          encoding: "utf8",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Xavier189",
            GIT_AUTHOR_EMAIL: "63280269+Xavier189@users.noreply.github.com",
            GIT_COMMITTER_NAME: "Xavier189",
            GIT_COMMITTER_EMAIL: "63280269+Xavier189@users.noreply.github.com",
          },
        },
        (error, stdout, stderr) => {
          const status = error ? (typeof error.status === "number" ? error.status : (typeof error.code === "number" ? error.code : 1)) : 0;
          resolve({
            status,
            stdout: stdout || "",
            stderr: stderr || "",
            error,
          });
        }
      );
    });
  };

  // 1. 验证 repoDir 是否为有效 git 仓库
  const repoCheck = await runGit(["rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.status !== 0 || !repoCheck.stdout.includes("true")) {
    throw new Error(`Directory "${repoDir}" is not a valid git repository`);
  }

  // 2. 解析 baseSha
  const baseShaRes = await runGit(["rev-parse", targetBaseRef]);
  if (baseShaRes.status !== 0) {
    throw new Error(`Failed to resolve baseRef "${targetBaseRef}": ${baseShaRes.stderr}`);
  }
  const baseSha = baseShaRes.stdout.trim();

  // 3. 从 baseRef 切出 workBranch
  const checkoutRes = await runGit(["checkout", "--quiet", "-B", trimmedBranch, targetBaseRef]);
  if (checkoutRes.status !== 0) {
    throw new Error(`Failed to create work branch "${trimmedBranch}" from "${targetBaseRef}": ${checkoutRes.stderr}`);
  }

  // 4. 尝试合并 upstreamSha
  const mergeRes = await runGit(["merge", "--no-ff", trimmedUpstreamSha, "-m", `Integrate upstream ${trimmedUpstreamSha}`]);

  let conflict = false;
  let conflictedFiles = [];

  const unmergedDiff = await runGit(["diff", "--name-only", "--diff-filter=U"]);
  const unmergedFiles = unmergedDiff.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  if (unmergedFiles.length > 0) {
    conflict = true;
    conflictedFiles = unmergedFiles;
  } else if (mergeRes.status !== 0) {
    const statusRes = await runGit(["status", "--porcelain"]);
    const conflictMarkers = ["UU ", "AA ", "UD ", "DU ", "DD ", "AU ", "UA "];
    const statusConflicts = statusRes.stdout
      .split("\n")
      .filter((line) => conflictMarkers.some((m) => line.startsWith(m)))
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
    if (statusConflicts.length > 0) {
      conflict = true;
      conflictedFiles = statusConflicts;
    }
  }

  let headSha = null;
  let testsRan = false;
  let testResult = null;
  let prReady = false;
  let ok = false;

  if (conflict) {
    if (typeof repair === "function") {
      await repair({
        repoDir,
        workBranch: trimmedBranch,
        conflictedFiles,
        baseSha,
        upstreamSha: trimmedUpstreamSha,
        runGit,
      });

      const checkDiff = await runGit(["diff", "--name-only", "--diff-filter=U"]);
      const remainingUnmerged = checkDiff.stdout
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);

      if (remainingUnmerged.length === 0) {
        const statusAfter = await runGit(["status", "--porcelain"]);
        if (statusAfter.stdout.trim() !== "") {
          await runGit(["commit", "-m", `Resolve conflicts integrating ${trimmedUpstreamSha}`]);
        }
        const headRes = await runGit(["rev-parse", "HEAD"]);
        if (headRes.status === 0) {
          headSha = headRes.stdout.trim();
        }

        if (typeof testRunner === "function") {
          testsRan = true;
          testResult = await testRunner({ repoDir, workBranch: trimmedBranch });
          const testPassed = Boolean(testResult && testResult !== false && testResult.ok !== false);
          prReady = testPassed;
          ok = testPassed;
        }
      }
    } else {
      await runGit(["merge", "--abort"]);
      testsRan = false;
      testResult = null;
      prReady = false;
      ok = false;
    }
  } else {
    const headRes = await runGit(["rev-parse", "HEAD"]);
    if (headRes.status === 0) {
      headSha = headRes.stdout.trim();
    }

    if (typeof testRunner === "function") {
      testsRan = true;
      testResult = await testRunner({ repoDir, workBranch: trimmedBranch });
      const testPassed = Boolean(testResult && testResult !== false && testResult.ok !== false);
      prReady = testPassed;
      ok = testPassed;
    } else {
      testsRan = false;
      testResult = null;
      prReady = false;
      ok = true;
    }
  }

  let notes = "Mac packaging, app install, and Desktop verification are untested; Linux evidence is this script and node tests only.";
  try {
    const diffFilesRes = await runGit(["diff", "--name-only", baseSha, headSha || trimmedUpstreamSha]);
    if (diffFilesRes.status === 0) {
      const changedFiles = new Set(
        diffFilesRes.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      );
      const hotFiles = HOT_CUSTOM_FILES.filter((f) => changedFiles.has(f));
      if (hotFiles.length > 0) {
        notes += "\n\n" + formatOverlapSection(hotFiles);
      }
    }
  } catch {
    // 忽略 diff 异常
  }

  return {
    ok,
    workBranch: trimmedBranch,
    baseSha,
    headSha,
    conflict,
    conflictedFiles,
    testsRan,
    testResult,
    prReady,
    notes,
  };
}

/**
 * 格式化 PR 描述正文（说明 Issue 创建状态、关联任务、审核门禁与调度器状态）
 */
export function formatImplementationPrBody({ taskId = "CM-IMPL-001", issueStatus } = {}) {
  const issueNote = issueStatus || "GitHub Issue could not be created (create_issue 403).";
  return [
    `## Task: ${taskId}`,
    "",
    `**Issue Status**: ${issueNote}`,
    "",
    "### Review & Merge Gate",
    "- **Reviewer**: 不畏浮云",
    "- **Merge Permission**: Only xavier may merge.",
    "",
    "### Safety Invariants",
    "- Formal scheduler remains disabled.",
    "- Production POST and production transport remain disabled.",
    "- Mac packaging, app install, and Desktop verification are untested; Linux evidence is this script and node tests only.",
  ].join("\n");
}

/**
 * 解析 CLI 命令行参数
 */
export function parseArgs(argv) {
  let subcommand = null;
  let help = false;
  let configFile = null;
  let stateDir = null;
  let now = null;
  let adapterFile = null;
  let allowNetwork = false;
  let repoDir = null;
  let baseRef = null;
  let upstreamSha = null;
  let workBranch = null;

  const args = [...argv];
  if (args.length > 0 && !args[0].startsWith("-")) {
    subcommand = args.shift();
    if (subcommand !== "detect" && subcommand !== "integrate") {
      throw new Error(`未知子命令 "${subcommand}"；使用 --help 查看用法`);
    }
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      help = true;
    } else if (arg === "--config") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --config 参数值");
      }
      configFile = args[i];
    } else if (arg === "--state-dir") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --state-dir 参数值");
      }
      stateDir = args[i];
    } else if (arg === "--now") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --now 参数值");
      }
      now = args[i];
    } else if (arg === "--adapter-file") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --adapter-file 参数值");
      }
      adapterFile = args[i];
    } else if (arg === "--allow-network") {
      allowNetwork = true;
    } else if (arg === "--repo-dir") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --repo-dir 参数值");
      }
      repoDir = args[i];
    } else if (arg === "--base-ref") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --base-ref 参数值");
      }
      baseRef = args[i];
    } else if (arg === "--upstream-sha") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --upstream-sha 参数值");
      }
      upstreamSha = args[i];
    } else if (arg === "--work-branch") {
      i++;
      if (i >= args.length || args[i].startsWith("-")) {
        throw new Error("缺少 --work-branch 参数值");
      }
      workBranch = args[i];
    } else {
      throw new Error(`未知参数 "${arg}"；使用 --help 查看用法`);
    }
  }

  return {
    subcommand,
    help,
    configFile,
    stateDir,
    now,
    adapterFile,
    allowNetwork,
    repoDir,
    baseRef,
    upstreamSha,
    workBranch,
  };
}

export async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(2);
  }

  if (opts.help || !opts.subcommand) {
    console.log(`
用法：
  node scripts/upstream-watch.mjs detect --config <file> --state-dir <dir> [--now <ISO>] [--allow-network]
  node scripts/upstream-watch.mjs integrate --repo-dir <dir> --base-ref <ref> --upstream-sha <sha> --work-branch <name>

说明：
  detect:    单次监测公共固定上游 SHA，持久化状态并按阈值或计划执行离线 mock 触发。
  integrate: 在隔离临时仓库中将固定 upstreamSha 合并入 workBranch，并执行测试挂钩。
  正式调度器与生产传输强制关闭，禁止作为常驻守护进程启动。
`);
    process.exit(0);
  }

  if (opts.subcommand === "integrate") {
    if (!opts.repoDir) {
      console.error("错误：integrate 子命令必须提供 --repo-dir <dir>（严禁默认使用当前仓库）");
      process.exit(2);
    }
    if (!opts.upstreamSha) {
      console.error("错误：integrate 子命令必须提供 --upstream-sha <sha>");
      process.exit(2);
    }
    if (!opts.workBranch) {
      console.error("错误：integrate 子命令必须提供 --work-branch <name>");
      process.exit(2);
    }

    try {
      const result = await integrateFixedSha({
        repoDir: path.resolve(opts.repoDir),
        baseRef: opts.baseRef || "main",
        upstreamSha: opts.upstreamSha,
        workBranch: opts.workBranch,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error(`集成失败：${err.message}`);
      process.exit(2);
    }
  }

  if (opts.subcommand === "detect") {
    if (!opts.configFile) {
      console.error("错误：detect 子命令必须提供 --config <file>");
      process.exit(2);
    }

    let rawConfig;
    try {
      const configPath = path.resolve(opts.configFile);
      rawConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch (err) {
      console.error(`读取配置文件失败：${err.message}`);
      process.exit(2);
    }

    if (opts.stateDir) {
      rawConfig.stateDir = path.resolve(opts.stateDir);
    }

    let adapter = null;
    if (opts.adapterFile) {
      try {
        const adapterModule = await import(pathToFileURL(path.resolve(opts.adapterFile)).href);
        adapter = adapterModule.default || adapterModule.adapter || adapterModule;
      } catch (err) {
        console.error(`加载 adapter 文件失败：${err.message}`);
        process.exit(2);
      }
    } else if (opts.allowNetwork) {
      adapter = createReadonlyUpstreamFetchAdapter();
    }

    try {
      const result = await runDetect({
        config: rawConfig,
        now: opts.now || Date.now(),
        adapter,
        allowNetwork: opts.allowNetwork,
      });
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.ok ? 0 : 1);
    } catch (err) {
      console.error(`运行检测失败：${err.message}`);
      process.exit(2);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  main();
}
