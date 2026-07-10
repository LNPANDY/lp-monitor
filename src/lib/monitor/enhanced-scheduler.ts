/**
 * 增强调度器 - 支持双频率扫描
 * 1. 已知仓位扫描：高频快速更新（15秒-5分钟）
 * 2. 全量扫描：低频发现新仓位（3分钟+）
 */
import cron from "node-cron";
import { scanKnownPositions, type KnownPositionsSummary } from "./known-positions-scanner";
import { runScan, type ScanSummary } from "./scanner";
import { getScanCron, setSetting } from "../db/settings";

let _knownPositionsScheduled: cron.ScheduledTask | null = null;
let _fullScanScheduled: cron.ScheduledTask | null = null;
let _running = false;
let _lastKnownPositionsSummary: KnownPositionsSummary | null = null;
let _lastFullScanSummary: ScanSummary | null = null;

/** 获取已知仓位扫描频率配置 */
function getKnownPositionsCron(): string {
  // 默认30秒扫描一次已知仓位
  const { getSetting } = require("../db/settings");
  return getSetting("known_positions_cron") || "*/30 * * * *";
}

/** 启动双频率调度器 */
export function startEnhancedScheduler() {
  // 停止现有调度器
  stopEnhancedScheduler();
  
  const fullScanCron = getScanCron();
  const knownPositionsCron = getKnownPositionsCron();
  
  console.log(`[scheduler-enhanced] starting dual-frequency scheduler`);
  console.log(`[scheduler-enhanced] known positions scan: ${knownPositionsCron}`);
  console.log(`[scheduler-enhanced] full scan: ${fullScanCron}`);
  
  // 启动已知仓位扫描（高频）
  if (cron.validate(knownPositionsCron)) {
    _knownPositionsScheduled = cron.schedule(knownPositionsCron, async () => {
      await scanKnownPositionsWrapper();
    });
    console.log(`[scheduler-enhanced] known positions scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid known positions cron: ${knownPositionsCron}`);
  }
  
  // 启动全量扫描（低频）
  if (cron.validate(fullScanCron)) {
    _fullScanScheduled = cron.schedule(fullScanCron, async () => {
      await fullScanWrapper();
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

/** 更新扫描频率 */
export function rescheduleKnownPositions(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的已知仓位扫描 cron 表达式: ${newCron}`);
  }
  
  setSetting("known_positions_cron", newCron);
  
  if (_knownPositionsScheduled) {
    _knownPositionsScheduled.stop();
    _knownPositionsScheduled = null;
  }
  
  if (cron.validate(newCron)) {
    _knownPositionsScheduled = cron.schedule(newCron, async () => {
      await scanKnownPositionsWrapper();
    });
    console.log(`[scheduler-enhanced] known positions rescheduled to "${newCron}"`);
  }
}

export function isRunning() {
  return _running;
}

export function lastKnownPositionsSummary() {
  return _lastKnownPositionsSummary;
}

export function lastFullScanSummary() {
  return _lastFullScanSummary;
}

/** 包装函数：已知仓位扫描 */
async function scanKnownPositionsWrapper() {
  if (_running) {
    console.log("[scanner-known] skipping scan: another scan is running");
    return { skipped: true, reason: "another scan is running" };
  }
  
  _running = true;
  try {
    console.log(`[scanner-known] starting known positions scan`);
    const summary = await scanKnownPositions();
    _lastKnownPositionsSummary = { ...summary, at: new Date().toISOString() };
    console.log(`[scanner-known] scan done: ${summary.positions} positions, ${summary.active} active, ${summary.closed} closed, ${summary.alertsSent} alerts, ${summary.pushSkipped} skipped, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scanner-known] scan failed:", e);
    _lastKnownPositionsSummary = { error: e?.message ?? String(e), at: new Date().toISOString() };
    throw e;
  } finally {
    _running = false;
  }
}

/** 包装函数：全量扫描 */
async function fullScanWrapper() {
  if (_running) {
    console.log("[scanner] skipping full scan: another scan is running");
    return { skipped: true, reason: "another scan is running" };
  }
  
  _running = true;
  try {
    console.log(`[scanner] starting full scan`);
    const summary = await runScan();
    _lastFullScanSummary = { ...summary, at: new Date().toISOString() };
    console.log(`[scanner] scan done: ${summary.positions} positions, ${summary.outOfRange} out of range, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scanner] scan failed:", e);
    _lastFullScanSummary = { error: e?.message ?? String(e), at: new Date().toISOString() };
    throw e;
  } finally {
    _running = false;
  }
}

/** 手动触发已知仓位扫描 */
export async function triggerKnownPositionsScan() {
  return await scanKnownPositionsWrapper();
}

/** 手动触发全量扫描 */
export async function triggerFullScan() {
  return await fullScanWrapper();
}