import { ensureEnhancedScheduler, isKnownRunning, isFullRunning, lastKnownPositionsSummary, lastFullScanSummary, currentFullScanCron, rescheduleFullScan, triggerFullScan, triggerKnownPositionsScan, getKnownPositionsCron } from "@/lib/monitor/enhanced-scheduler";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 返回当前调度状态与上次扫描摘要。 */
export async function GET() {
  ensureEnhancedScheduler();
  return ok({
    knownRunning: isKnownRunning(),
    fullRunning: isFullRunning(),
    fullCron: currentFullScanCron(),
    knownCron: getKnownPositionsCron(),
    lastKnown: lastKnownPositionsSummary(),
    lastFull: lastFullScanSummary(),
  });
}

/** 手动触发一次全量扫描。 */
export async function POST() {
  if (isFullRunning()) return fail("已有全量扫描在进行中", 409);
  try {
    const summary = await triggerFullScan();
    return ok(summary);
  } catch (e: any) {
    return fail(e?.message ?? "scan failed", 500);
  }
}

// 修改扫描频率。body: { cron: "cron-expr" } 或 { intervalMin: 5 } 或 { type: "known"|"full", cron: "..." }
export async function PUT(req: Request) {
  const b = await getBody<{ cron?: string; intervalMin?: number; type?: string }>(req);
  let newCron: string;
  if (b.cron) {
    newCron = b.cron.trim();
  } else if (typeof b.intervalMin === "number" && b.intervalMin > 0) {
    const n = Math.floor(b.intervalMin);
    newCron = 60 % n === 0 ? `*/${n} * * * *` : `*/${n} * * * *`;
  } else {
    return fail("需要提供 cron 或 intervalMin");
  }
  try {
    // type=known 修改已知扫描频率，type=full 或默认修改全量扫描
    if (b.type === "known") {
      const { rescheduleKnownPositions } = await import("@/lib/monitor/enhanced-scheduler");
      rescheduleKnownPositions(newCron);
      return ok({ type: "known", cron: newCron });
    }
    rescheduleFullScan(newCron);
    return ok({ type: "full", cron: newCron });
  } catch (e: any) {
    return fail(e?.message ?? "reschedule failed", 400);
  }
}
