/**
 * 增强调度器 - 支持双频率并行扫描
 * 1. 已知仓位扫描：高频快速更新（15秒-5分钟）
 * 2. 全量扫描：低频发现新仓位（3分钟+）
 *
 * 两种扫描可并行运行：已知扫描更新状态/推送告警，全量扫描发现新仓位。
 * 各自仅防自身重入（同一类型扫描不并发）。
 *
 * 关键：所有状态存储在 globalThis 上，防止 Next.js dev HMR 重载模块时
 * 丢失模块级变量引用、导致旧 cron 任务泄漏（随时间累积连续多次扫描）。
 */
import cron from "node-cron";
import { scanKnownPositions, type KnownPositionsSummary } from "./known-positions-scanner";
import { runScan, type ScanSummary } from "./scanner";
import { getScanCron } from "../db/settings";

/** 调度器全局状态（HMR 安全） */
interface SchedulerState {
  knownScheduled: cron.ScheduledTask | null;
  fullScheduled: cron.ScheduledTask | null;
  knownRunning: boolean;
  fullRunning: boolean;
  lastKnown: KnownPositionsSummary | null;
  lastFull: ScanSummary | null;
  started: boolean;
}

const GLOBAL_KEY = "__lpMonitorScheduler__";

function getState(): SchedulerState {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = {
      knownScheduled: null,
      fullScheduled: null,
      knownRunning: false,
      fullRunning: false,
      lastKnown: null,
      lastFull: null,
      started: false,
    } as SchedulerState;
  }
  return (globalThis as any)[GLOBAL_KEY] as SchedulerState;
}

/** 当前生效的全量扫描 cron 表达式。 */
export function currentFullScanCron(): string {
  return getScanCron();
}

/** 获取已知仓位扫描频率配置 */
export function getKnownPositionsCron(): string {
  const { getSetting } = require("../db/settings");
  return getSetting("known_positions_cron") || "*/30 * * * * *";
}

/** 启动双频率调度器 */
export function startEnhancedScheduler() {
  const s = getState();
  if (s.started) return;  // 已启动则不重复
  s.started = true;
  stopEnhancedScheduler();

  const fullScanCron = getScanCron();
  const knownPositionsCron = getKnownPositionsCron();

  console.log(`[scheduler-enhanced] starting dual-frequency parallel scheduler`);
  console.log(`[scheduler-enhanced] known positions scan: ${knownPositionsCron}`);
  console.log(`[scheduler-enhanced] full scan: ${fullScanCron}`);

  // 启动已知仓位扫描（高频）
  if (cron.validate(knownPositionsCron)) {
    s.knownScheduled = cron.schedule(knownPositionsCron, async () => {
      await runKnownScanWrapper();
    });
    console.log(`[scheduler-enhanced] known positions scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid known positions cron: ${knownPositionsCron}`);
  }

  // 启动全量扫描（低频）
  if (cron.validate(fullScanCron)) {
    s.fullScheduled = cron.schedule(fullScanCron, async () => {
      await runFullScanWrapper();
    });
    console.log(`[scheduler-enhanced] full scan scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid full scan cron: ${fullScanCron}`);
  }
}

/** 停止双频率调度器 */
export function stopEnhancedScheduler() {
  const s = getState();
  if (s.knownScheduled) {
    s.knownScheduled.stop();
    s.knownScheduled = null;
  }
  if (s.fullScheduled) {
    s.fullScheduled.stop();
    s.fullScheduled = null;
  }
}

/** 自愈：确保增强调度器正在运行 */
export function ensureEnhancedScheduler() {
  const s = getState();
  if (s.knownScheduled && s.fullScheduled) {
    return;
  }
  console.warn("[scheduler-enhanced] scheduler missing, self-healing...");
  // 重置 started 标志以允许重新创建缺失的任务
  s.started = false;
  startEnhancedScheduler();
}

/** 更新已知仓位扫描频率 */
export function rescheduleKnownPositions(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的已知仓位扫描 cron 表达式: ${newCron}`);
  }
  const { setSetting } = require("../db/settings");
  setSetting("known_positions_cron", newCron);
  const s = getState();
  if (s.knownScheduled) {
    s.knownScheduled.stop();
    s.knownScheduled = null;
  }
  s.knownScheduled = cron.schedule(newCron, async () => {
    await runKnownScanWrapper();
  });
  console.log(`[scheduler-enhanced] known positions rescheduled to "${newCron}"`);
}

/** 更新全量扫描频率 */
export function rescheduleFullScan(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的全量扫描 cron 表达式: ${newCron}`);
  }
  const { setSetting } = require("../db/settings");
  setSetting("scan_cron", newCron);
  const s = getState();
  if (s.fullScheduled) {
    s.fullScheduled.stop();
    s.fullScheduled = null;
  }
  s.fullScheduled = cron.schedule(newCron, async () => {
    await runFullScanWrapper();
  });
  console.log(`[scheduler-enhanced] full scan rescheduled to "${newCron}"`);
}

export function isKnownRunning() {
  return getState().knownRunning;
}

export function isFullRunning() {
  return getState().fullRunning;
}

export function lastKnownPositionsSummary() {
  return getState().lastKnown;
}

export function lastFullScanSummary() {
  return getState().lastFull;
}

/** 包装函数：已知仓位扫描（仅防自身重入，不阻塞全量扫描） */
async function runKnownScanWrapper() {
  const s = getState();
  if (s.knownRunning) {
    console.log("[scheduler-enhanced] known scan skipped: already running");
    return { skipped: true, reason: "known scan already running" };
  }
  s.knownRunning = true;
  try {
    const summary = await scanKnownPositions();
    s.lastKnown = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler-enhanced] known scan done: ${summary.positions} positions, ${summary.active} active, ${summary.closed} closed, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler-enhanced] known scan failed:", e);
    s.lastKnown = {
      positions: 0, active: 0, closed: 0, alertsSent: 0, pushSkipped: 0, durationMs: 0,
      errors: [],
      error: e?.message ?? String(e),
      at: new Date().toISOString()
    };
    throw e;
  } finally {
    s.knownRunning = false;
  }
}

/** 包装函数：全量扫描（仅防自身重入，不阻塞已知扫描） */
async function runFullScanWrapper() {
  const s = getState();
  if (s.fullRunning) {
    console.log("[scheduler-enhanced] full scan skipped: already running");
    return { skipped: true, reason: "full scan already running" };
  }
  s.fullRunning = true;
  try {
    const summary = await runScan();
    s.lastFull = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler-enhanced] full scan done: ${summary.positions} positions, ${summary.outOfRange} out of range, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler-enhanced] full scan failed:", e);
    s.lastFull = {
      wallets: 0, positions: 0, outOfRange: 0, alertsSent: 0, errors: [],
      startedAt: new Date().toISOString(), durationMs: 0,
      error: e?.message ?? String(e),
      at: new Date().toISOString()
    };
    throw e;
  } finally {
    s.fullRunning = false;
  }
}

/** 手动触发已知仓位扫描 */
export async function triggerKnownPositionsScan() {
  return await runKnownScanWrapper();
}

/** 手动触发全量扫描 */
export async function triggerFullScan() {
  return await runFullScanWrapper();
}
