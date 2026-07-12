/**
 * 增强调度器 - 支持双频率并行扫描
 * 1. 已知仓位扫描：高频快速更新（15秒-5分钟）
 * 2. 全量扫描：低频发现新仓位（3分钟+）
 *
 * 两种扫描可并行运行：已知扫描更新状态/推送告警，全量扫描发现新仓位。
 * 各自仅防自身重入（同一类型扫描不并发）。
 */
import cron from "node-cron";
import { scanKnownPositions, type KnownPositionsSummary } from "./known-positions-scanner";
import { runScan, type ScanSummary } from "./scanner";
import { getScanCron } from "../db/settings";

let _knownPositionsScheduled: cron.ScheduledTask | null = null;
let _fullScanScheduled: cron.ScheduledTask | null = null;
let _knownRunning = false;  // 已知扫描的并发锁
let _fullRunning = false;   // 全量扫描的并发锁
let _lastKnownPositionsSummary: KnownPositionsSummary | null = null;
let _lastFullScanSummary: ScanSummary | null = null;

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
  stopEnhancedScheduler();

  const fullScanCron = getScanCron();
  const knownPositionsCron = getKnownPositionsCron();

  console.log(`[scheduler-enhanced] starting dual-frequency parallel scheduler`);
  console.log(`[scheduler-enhanced] known positions scan: ${knownPositionsCron}`);
  console.log(`[scheduler-enhanced] full scan: ${fullScanCron}`);

  // 启动已知仓位扫描（高频）
  if (cron.validate(knownPositionsCron)) {
    _knownPositionsScheduled = cron.schedule(knownPositionsCron, async () => {
      await runKnownScanWrapper();
    });
    console.log(`[scheduler-enhanced] known positions scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid known positions cron: ${knownPositionsCron}`);
  }

  // 启动全量扫描（低频）
  if (cron.validate(fullScanCron)) {
    _fullScanScheduled = cron.schedule(fullScanCron, async () => {
      await runFullScanWrapper();
    });
    console.log(`[scheduler-enhanced] full scan scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid full scan cron: ${fullScanCron}`);
  }
}

/** 停止双频率调度器 */
export function stopEnhancedScheduler() {
  if (_knownPositionsScheduled) {
    _knownPositionsScheduled.stop();
    _knownPositionsScheduled = null;
  }
  if (_fullScanScheduled) {
    _fullScanScheduled.stop();
    _fullScanScheduled = null;
  }
}

/** 自愈：确保增强调度器正在运行 */
export function ensureEnhancedScheduler() {
  if (_knownPositionsScheduled && _fullScanScheduled) {
    return;
  }
  console.warn("[scheduler-enhanced] scheduler missing, self-healing...");
  startEnhancedScheduler();
}

/** 更新已知仓位扫描频率 */
export function rescheduleKnownPositions(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的已知仓位扫描 cron 表达式: ${newCron}`);
  }
  const { setSetting } = require("../db/settings");
  setSetting("known_positions_cron", newCron);
  if (_knownPositionsScheduled) {
    _knownPositionsScheduled.stop();
    _knownPositionsScheduled = null;
  }
  if (cron.validate(newCron)) {
    _knownPositionsScheduled = cron.schedule(newCron, async () => {
      await runKnownScanWrapper();
    });
    console.log(`[scheduler-enhanced] known positions rescheduled to "${newCron}"`);
  }
}

/** 更新全量扫描频率 */
export function rescheduleFullScan(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的全量扫描 cron 表达式: ${newCron}`);
  }
  const { setSetting } = require("../db/settings");
  setSetting("scan_cron", newCron);
  if (_fullScanScheduled) {
    _fullScanScheduled.stop();
    _fullScanScheduled = null;
  }
  if (cron.validate(newCron)) {
    _fullScanScheduled = cron.schedule(newCron, async () => {
      await runFullScanWrapper();
    });
    console.log(`[scheduler-enhanced] full scan rescheduled to "${newCron}"`);
  }
}

export function isKnownRunning() {
  return _knownRunning;
}

export function isFullRunning() {
  return _fullRunning;
}

export function lastKnownPositionsSummary() {
  return _lastKnownPositionsSummary;
}

export function lastFullScanSummary() {
  return _lastFullScanSummary;
}

/** 包装函数：已知仓位扫描（仅防自身重入，不阻塞全量扫描） */
async function runKnownScanWrapper() {
  if (_knownRunning) {
    console.log("[scheduler-enhanced] known scan skipped: already running");
    return { skipped: true, reason: "known scan already running" };
  }
  _knownRunning = true;
  try {
    const summary = await scanKnownPositions();
    _lastKnownPositionsSummary = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler-enhanced] known scan done: ${summary.positions} positions, ${summary.active} active, ${summary.closed} closed, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler-enhanced] known scan failed:", e);
    _lastKnownPositionsSummary = {
      positions: 0, active: 0, closed: 0, alertsSent: 0, pushSkipped: 0, durationMs: 0,
      errors: [],
      error: e?.message ?? String(e),
      at: new Date().toISOString()
    };
    throw e;
  } finally {
    _knownRunning = false;
  }
}

/** 包装函数：全量扫描（仅防自身重入，不阻塞已知扫描） */
async function runFullScanWrapper() {
  if (_fullRunning) {
    console.log("[scheduler-enhanced] full scan skipped: already running");
    return { skipped: true, reason: "full scan already running" };
  }
  _fullRunning = true;
  try {
    const summary = await runScan();
    _lastFullScanSummary = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler-enhanced] full scan done: ${summary.positions} positions, ${summary.outOfRange} out of range, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler-enhanced] full scan failed:", e);
    _lastFullScanSummary = {
      wallets: 0, positions: 0, outOfRange: 0, alertsSent: 0, errors: [],
      startedAt: new Date().toISOString(), durationMs: 0,
      error: e?.message ?? String(e),
      at: new Date().toISOString()
    };
    throw e;
  } finally {
    _fullRunning = false;
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