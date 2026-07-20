import {
  ensureEnhancedScheduler,
  isCombinedRunning,
  isFullRunning,
  lastCombinedSummary,
  lastFullScanSummary,
  currentFullScanCron,
  getCombinedScanCron,
  rescheduleCombinedScan,
  triggerCombinedScan,
  triggerFullScan,
} from "@/lib/monitor/enhanced-scheduler";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 返回当前调度状态与上次扫描摘要。 */
export async function GET() {
  ensureEnhancedScheduler();
  return ok({
    combinedRunning: isCombinedRunning(),
    fullRunning: isFullRunning(),
    combinedCron: getCombinedScanCron(),
    fullCron: currentFullScanCron(),  // 保留别名供前端向后兼容展示
    lastCombined: lastCombinedSummary(),
    lastFull: lastFullScanSummary(),
  });
}

/**
 * 手动触发一次扫描。
 * body: { mode?: "deep" | "combined" } —— 默认 "deep"（保留向后兼容；前端"完整扫描"按钮走 deep）。
 *  - deep: 深度扫描，原版慢速逻辑（100k 块窗口 + balanceOf 枚举钱包所有 NFT + readRange 全部仓位）
 *  - combined: 与 cron 自动触发一致——先 fast discover（发现新仓位+标 closed），再 known 扫描（更新状态+告警）
 */
export async function POST(req: Request) {
  const b = await getBody<{ mode?: string }>(req).catch(() => ({ mode: "deep" } as any));
  const mode = b?.mode === "combined" ? "combined" : "deep";

  if (mode === "combined") {
    if (isCombinedRunning() || isFullRunning()) return fail("已有扫描在进行中", 409);
    try {
      const summary = await triggerCombinedScan();
      return ok(summary);
    } catch (e: any) {
      return fail(e?.message ?? "scan failed", 500);
    }
  }

  // deep
  if (isFullRunning() || isCombinedRunning()) return fail("已有扫描在进行中", 409);
  try {
    const summary = await triggerFullScan();
    return ok(summary);
  } catch (e: any) {
    return fail(e?.message ?? "scan failed", 500);
  }
}

// 修改扫描频率。body: { cron: "cron-expr" } 或 { intervalMin: 5 }
// 合并模式下 type=known/full 都改的就是同一个 cron
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
    // 合并模式下 known 与 full 用同一 cron，无需区分 type
    rescheduleCombinedScan(newCron);
    return ok({ type: b.type ?? "combined", cron: newCron });
  } catch (e: any) {
    return fail(e?.message ?? "reschedule failed", 400);
  }
}