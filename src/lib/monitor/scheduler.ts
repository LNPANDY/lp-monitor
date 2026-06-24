import cron from "node-cron";
import { runScan } from "./scanner";
import { getScanCron } from "../db/settings";

let _scheduled: cron.ScheduledTask | null = null;
let _running = false;
let _lastSummary: any = null;

/** 当前生效的 cron 表达式（DB 优先，回退环境变量，再回退默认）。 */
export function currentCron(): string {
  return getScanCron();
}

/** 启动定时扫描。在 Next.js 服务端 instrumentation 或 dev ready 时调用，幂等。 */
export function startScheduler() {
  if (_scheduled) return _scheduled;
  const expr = currentCron();
  if (!cron.validate(expr)) {
    console.warn(`[scheduler] invalid cron expression: ${expr}, fallback to */3 * * * *`);
    _scheduled = cron.schedule("*/3 * * * *", () => {
      tick().catch((e) => console.error("[scheduler] tick error:", e));
    });
    return _scheduled;
  }
  _scheduled = cron.schedule(expr, () => {
    tick().catch((e) => console.error("[scheduler] tick error:", e));
  });
  console.log(`[scheduler] started with cron "${expr}"`);
  return _scheduled;
}

/**
 * 自愈：确保 scheduler 处于运行态。
 *
 * 背景：cron 任务存在进程内存里。Next.js 生产模式下进程可能被回收/重启，
 * 或 instrumentation hook 因配置问题未执行，导致内存里的 _scheduled 丢失，
 * 表现为「DB 里 scan_cron 还在，但就是不自动扫描」。
 *
 * 策略：在每次 /api/monitor 请求进来时调用一次，发现 _scheduled 为空就重建。
 * 这样即使启动时 instrumentation 没跑，第一次访问监控页也能恢复定时扫描。
 * 幂等：已运行时直接返回。
 */
export function ensureScheduler() {
  if (_scheduled) return _scheduled;
  console.warn("[scheduler] _scheduled missing, self-healing...");
  return startScheduler();
}

/**
 * 用新的 cron 表达式重启调度器（运行时动态修改扫描频率）。
 * 写入 DB 后重建任务。表达式非法时抛错。
 */
export function reschedule(newCron: string) {
  if (!cron.validate(newCron)) {
    throw new Error(`非法 cron 表达式: ${newCron}`);
  }
  // 写入 DB（setSetting 在此 import 避免循环依赖）
  const { setSetting } = require("../db/settings");
  setSetting("scan_cron", newCron);
  if (_scheduled) {
    _scheduled.stop();
    _scheduled = null;
  }
  startScheduler();
  console.log(`[scheduler] rescheduled to "${newCron}"`);
}

export function stopScheduler() {
  if (_scheduled) {
    _scheduled.stop();
    _scheduled = null;
  }
}

export function isRunning() {
  return _running;
}

export function lastSummary() {
  return _lastSummary;
}

/** 执行一次扫描，带并发锁防止重叠。 */
export async function tick() {
  if (_running) {
    return { skipped: true, reason: "another scan is running" };
  }
  _running = true;
  try {
    const summary = await runScan();
    _lastSummary = { ...summary, at: new Date().toISOString() };
    console.log(`[scheduler] scan done: ${summary.positions} positions, ${summary.outOfRange} out of range, ${summary.alertsSent} alerts, ${summary.durationMs}ms`);
    return summary;
  } catch (e: any) {
    console.error("[scheduler] scan failed:", e);
    _lastSummary = { error: e?.message ?? String(e), at: new Date().toISOString() };
    throw e;
  } finally {
    _running = false;
  }
}
