/**
 * 增强调度器 - 合并式扫描
 *
 * 单一 cron 触发 runCombinedScanWrapper，串行两步：
 *   1. fast discover（discover-fast.ts）——transfer 扫描发现新仓位 + 标 closed
 *   2. known 扫描（known-positions-scanner.ts）——readRange 更新 DB 已有仓位状态 + 触发告警
 *
 * fast discover 不到 5 秒（无 readRange）；known 扫描 4-10 秒（取决仓位数）；
 * 串行总时间稳定 < 15 秒。频率默认 30 秒一次（沿用 known_positions_cron 配置）。
 *
 * 独立保留：
 *   - triggerFullScan：手动"完整扫描"按钮触发深度扫描 runScan（100k 块窗口 + 枚举钱包所有 NFT）
 *   - 不再被 cron 自动调用，仅手动按钮触发
 *
 * 关键：所有状态存储在 globalThis 上，防止 Next.js dev HMR 重载模块时丢失模块级变量引用。
 */
import cron from "node-cron";
import { scanKnownPositions, type KnownPositionsSummary } from "./known-positions-scanner";
import { runScan, type ScanSummary } from "./scanner";
import { runFastDiscover, type FastDiscoverSummary } from "./discover-fast";
import { scanFavoritePools, type FavPoolScanSummary } from "./fav-pool-scanner";
import { getScanCron } from "../db/settings";
import { getSetting, setSetting } from "../db/settings";

/** 合并扫描的统一摘要 */
export interface CombinedScanSummary {
  fast: FastDiscoverSummary | null;  // 可能因 fast 内部异常而 null
  favPools?: FavPoolScanSummary;      // 收藏池监控（Step 1.5，失败时缺省）
  known: KnownPositionsSummary | null; // 同上
  startedAt: string;
  durationMs: number;
  error?: string;
}

/** 调度器全局状态（HMR 安全） */
interface SchedulerState {
  combinedScheduled: cron.ScheduledTask | null;
  fullScheduled: null;  // 不再自动调度深度扫描，保留字段防运行中旧对象
  combinedRunning: boolean;
  fullRunning: boolean;
  lastCombined: CombinedScanSummary | null;
  lastFull: ScanSummary | null;  // 手动深度扫描的上次结果
  started: boolean;
  // fast discover 的窗口推进状态
  lastFastScanBlockByChain: Record<number, bigint>;  // 每条链上次扫描结束的区块号
  blockTimeByChain: Record<number, number>;          // 每条链的平均出块时间（秒/块）
  hasFastScanFirstDone: boolean;                      // 是否已完成首次快速扫描
}

const GLOBAL_KEY = "__lpMonitorScheduler__";

function getState(): SchedulerState {
  if (!(globalThis as any)[GLOBAL_KEY]) {
    (globalThis as any)[GLOBAL_KEY] = {
      combinedScheduled: null,
      fullScheduled: null,
      combinedRunning: false,
      fullRunning: false,
      lastCombined: null,
      lastFull: null,
      started: false,
      lastFastScanBlockByChain: {},
      blockTimeByChain: {},
      hasFastScanFirstDone: false,
    } as SchedulerState;
  }
  return (globalThis as any)[GLOBAL_KEY] as SchedulerState;
}

/** 当前生效的 cron 表达式（合并扫描沿用 scan_cron 配置） */
export function currentFullScanCron(): string {
  return getScanCron();
}

/** 获取合并扫描频率配置（沿用 known_positions_cron 或 scan_cron，前者优先） */
export function getCombinedScanCron(): string {
  const knownCron = getSetting("known_positions_cron", "");
  if (knownCron) return knownCron;
  return getScanCron();
}

/** 启动调度器 */
export function startEnhancedScheduler() {
  const s = getState();
  if (s.started) return;  // 已启动则不重复
  s.started = true;
  stopEnhancedScheduler();

  const combinedCron = getCombinedScanCron();
  console.log(`[scheduler-enhanced] starting combined scheduler (cron: ${combinedCron})`);

  if (cron.validate(combinedCron)) {
    s.combinedScheduled = cron.schedule(combinedCron, async () => {
      await runCombinedScanWrapper();
    });
    console.log(`[scheduler-enhanced] combined scheduler started`);
  } else {
    console.warn(`[scheduler-enhanced] invalid combined cron: ${combinedCron}`);
  }
}

/** 停止调度器 */
export function stopEnhancedScheduler() {
  const s = getState();
  if (s.combinedScheduled) {
    s.combinedScheduled.stop();
    s.combinedScheduled = null;
  }
}

/** 自愈：确保调度器正在运行 */
export function ensureEnhancedScheduler() {
  const s = getState();
  if (s.combinedScheduled) return;
  console.warn("[scheduler-enhanced] scheduler missing, self-healing...");
  s.started = false;
  startEnhancedScheduler();
}

/** 更新合并扫描频率（同时写 known_positions_cron + scan_cron 保持一致） */
export function rescheduleCombinedScan(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法的合并扫描 cron 表达式: ${newCron}`);
  }
  setSetting("known_positions_cron", newCron);
  setSetting("scan_cron", newCron);
  const s = getState();
  if (s.combinedScheduled) {
    s.combinedScheduled.stop();
    s.combinedScheduled = null;
  }
  s.combinedScheduled = cron.schedule(newCron, async () => {
    await runCombinedScanWrapper();
  });
  console.log(`[scheduler-enhanced] combined rescheduled to "${newCron}"`);
}

/** 向后兼容：旧 API 仍叫 rescheduleFullScan，实际改的就是合并扫描 cron */
export function rescheduleFullScan(newCron: string) {
  return rescheduleCombinedScan(newCron);
}

/** 向后兼容：旧 API 仍叫 rescheduleKnownPositions（known 已合并，等同于 rescheduleCombinedScan） */
export async function rescheduleKnownPositions(newCron: string) {
  return rescheduleCombinedScan(newCron);
}

export function isCombinedRunning() {
  return getState().combinedRunning;
}

export function isKnownRunning() {
  return getState().combinedRunning;  // 合并模式下 known 间接由 combinedRunning 表示
}

export function isFullRunning() {
  return getState().fullRunning;
}

export function isFastRunning() {
  return getState().combinedRunning;  // 合并模式下 fast 间接由 combinedRunning 表示
}

export function lastCombinedSummary() {
  return getState().lastCombined;
}

export function lastKnownPositionsSummary() {
  const c = getState().lastCombined;
  return c?.known ?? null;
}

export function lastFastScanSummary() {
  const c = getState().lastCombined;
  // 用 CombinedScanSummary 模拟旧的 lastFast（部分字段用 fast 直接填）
  if (!c?.fast) return null;
  return {
    wallets: c.fast.windows.length,
    positions: 0,
    discovered: 0,
    new: c.fast.newInserted,
    reopened: 0,
    closed: c.fast.closed,
    outOfRange: 0,
    alertsSent: 0,
    errors: c.fast.errors,
    startedAt: "",
    durationMs: c.fast.durationMs,
    at: c.startedAt,
  } as ScanSummary;
}

export function lastFullScanSummary() {
  return getState().lastFull;
}

/**
 * 合并扫描 wrapper：先 fast discover 再 known 扫描。
 * combinedRunning 作为互斥标志（fast 与 known 顺序不可倒置）。
 */
async function runCombinedScanWrapper() {
  const s = getState();
  if (s.combinedRunning || s.fullRunning) {
    console.log(`[scheduler-enhanced] combined scan skipped: ${s.combinedRunning ? "combined" : "full"} running`);
    return { skipped: true, reason: "another scan already running" };
  }
  s.combinedRunning = true;
  const startedAt = Date.now();

  let fastSummary: FastDiscoverSummary | null = null;
  let favPoolsSummary: FavPoolScanSummary | null = null;
  let knownSummary: KnownPositionsSummary | null = null;
  let combinedError: string | undefined;

  try {
    // ===== Step 1: fast discover =====
    const tFast0 = Date.now();
    fastSummary = await runFastDiscover({
      lastBlockByChain: s.lastFastScanBlockByChain,
      blockTimeByChain: s.blockTimeByChain,
      isFirstScan: !s.hasFastScanFirstDone,
    });
    s.hasFastScanFirstDone = true;
    console.log(`[scheduler-enhanced] fast discover done: new=${fastSummary.newInserted} source_changed=${fastSummary.sourceChanged} closed=${fastSummary.closed} (${Date.now()-tFast0}ms)`);

    // ===== Step 1.5: 收藏池监控（CEX 价差告警，独立 try/catch 失败不影响后续步骤）=====
    const tFav0 = Date.now();
    try {
      favPoolsSummary = await scanFavoritePools();
      console.log(`[scheduler-enhanced] fav pools done: checked=${favPoolsSummary.checked} alerted=${favPoolsSummary.alerted} (${Date.now()-tFav0}ms)`);
    } catch (e: any) {
      console.error("[scheduler-enhanced] fav pools scan failed:", e);
    }

    // ===== Step 2: known scan =====
    const tKnown0 = Date.now();
    knownSummary = await scanKnownPositions();
    console.log(`[scheduler-enhanced] known scan done: ${knownSummary.positions} positions, ${knownSummary.active} active, ${knownSummary.alertsSent} alerts, (${Date.now()-tKnown0}ms)`);
  } catch (e: any) {
    combinedError = e?.message ?? String(e);
    console.error("[scheduler-enhanced] combined scan failed:", e);
  } finally {
    s.combinedRunning = false;
  }

  const summary: CombinedScanSummary = {
    fast: fastSummary,
    favPools: favPoolsSummary ?? undefined,
    known: knownSummary,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    error: combinedError,
  };
  s.lastCombined = summary;
  console.log(`[scheduler-enhanced] combined done: total ${summary.durationMs}ms${summary.error ? ` error=${summary.error}` : ""}`);
  return summary;
}

/**
 * wrapper for 深度扫描（手动按钮触发，与原 runScan 一致；完全独立于合并扫描）。
 */
async function runFullScanWrapper() {
  const s = getState();
  if (s.fullRunning || s.combinedRunning) {
    console.log(`[scheduler-enhanced] full scan skipped: ${s.fullRunning ? "full" : "combined"} running`);
    return { skipped: true, reason: "another scan already running" };
  }
  s.fullRunning = true;
  try {
    const summary = await runScan();
    s.lastFull = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler-enhanced] deep scan done: ${summary.positions} positions, ${summary.outOfRange} out of range, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler-enhanced] deep scan failed:", e);
    s.lastFull = {
      wallets: 0, positions: 0, discovered: 0, outOfRange: 0, alertsSent: 0, errors: [],
      startedAt: new Date().toISOString(), durationMs: 0,
      error: e?.message ?? String(e),
      at: new Date().toISOString()
    };
    throw e;
  } finally {
    s.fullRunning = false;
  }
}

/** 手动触发合并扫描（fast + known 串行一次） */
export async function triggerCombinedScan() {
  return await runCombinedScanWrapper();
}

/** 向后兼容：triggerFullScan 仍出发深度扫描（保留原行为，与手动"完整扫描"按钮对应） */
export async function triggerFullScan() {
  return await runFullScanWrapper();
}

/** 向后兼容：旧名保留为合并扫描的别名 */
export async function triggerKnownPositionsScan() {
  return await runCombinedScanWrapper();
}

/** 向后兼容：旧名 runFastScanWrapper 已被合并 wrapper 取代 */
export async function triggerFastScan() {
  return await runCombinedScanWrapper();
}