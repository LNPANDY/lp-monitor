import { ok, fail, getBody } from "@/lib/api";
import { setSetting } from "@/lib/db/settings";
import {
  getTickMoveThreshold,
  isTickMoveEnabled,
  isCexPriceEnabled,
  getPushCooldownMinutes,
} from "@/lib/db/settings";

export const dynamic = "force-dynamic";

/** GET: 读取当前告警阈值设置 */
export async function GET() {
  return ok({
    tick_move_enabled: isTickMoveEnabled(),
    tick_move_threshold: getTickMoveThreshold(),
    cex_price_enabled: isCexPriceEnabled(),
    push_cooldown_minutes: getPushCooldownMinutes(),
  });
}

/** PUT: 更新告警阈值设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<{
    tick_move_enabled?: string;
    tick_move_threshold?: number;
    cex_price_enabled?: string;
    push_cooldown_minutes?: number;
  }>(req);

  // 注意：前端传的是字符串 "0"/"1"，字符串 "0" 是 truthy，不能用 ?: 判断
  if (body.tick_move_enabled !== undefined) {
    setSetting("tick_move_enabled", String(body.tick_move_enabled) === "1" ? "1" : "0");
  }
  if (body.tick_move_threshold !== undefined) {
    const v = Number(body.tick_move_threshold);
    if (!Number.isFinite(v) || v < 0 || v > 100) return fail("tick_move_threshold 须为 0~100 的数值");
    setSetting("tick_move_threshold", String(v));
  }
  if (body.cex_price_enabled !== undefined) {
    setSetting("cex_price_enabled", String(body.cex_price_enabled) === "1" ? "1" : "0");
  }
  if (body.push_cooldown_minutes !== undefined) {
    const v = Number(body.push_cooldown_minutes);
    if (!Number.isFinite(v) || v < 1 || v > 60) return fail("push_cooldown_minutes 须为 1~60 的数值");
    setSetting("push_cooldown_minutes", String(v));
  }

  return ok({
    tick_move_enabled: isTickMoveEnabled(),
    tick_move_threshold: getTickMoveThreshold(),
    cex_price_enabled: isCexPriceEnabled(),
    push_cooldown_minutes: getPushCooldownMinutes(),
  });
}
