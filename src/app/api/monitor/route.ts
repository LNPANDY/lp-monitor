import { tick, isRunning, lastSummary, currentCron, reschedule } from "@/lib/monitor/scheduler";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 返回当前调度状态与上次扫描摘要。 */
export async function GET() {
  return ok({
    running: isRunning(),
    cron: currentCron(),
    cooldownMs: Number(process.env.ALERT_COOLDOWN_MS ?? 3600000),
    last: lastSummary(),
  });
}

/** 手动触发一次扫描。 */
export async function POST() {
  if (isRunning()) return fail("已有扫描在进行中", 409);
  try {
    const summary = await tick();
    return ok(summary);
  } catch (e: any) {
    return fail(e?.message ?? "scan failed", 500);
  }
}

// 修改扫描频率。body: { cron: "cron-expr" } 或 { intervalMin: 5 }
export async function PUT(req: Request) {
  const b = await getBody<{ cron?: string; intervalMin?: number }>(req);
  let newCron: string;
  if (b.cron) {
    newCron = b.cron.trim();
  } else if (typeof b.intervalMin === "number" && b.intervalMin > 0) {
    // 把「每 N 分钟」转成 cron：N 能整除 60 用 */N，否则用 list
    const n = Math.floor(b.intervalMin);
    newCron = 60 % n === 0 ? `*/${n} * * * *` : `*/${n} * * * *`;
  } else {
    return fail("需要提供 cron 或 intervalMin");
  }
  try {
    reschedule(newCron);
    return ok({ cron: newCron });
  } catch (e: any) {
    return fail(e?.message ?? "reschedule failed", 400);
  }
}
