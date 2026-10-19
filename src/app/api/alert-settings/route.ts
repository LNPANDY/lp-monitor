import { ok, fail, getBody } from "@/lib/api";
import { setSetting, getSetting } from "@/lib/db/settings";
import {
  getTickMoveThreshold,
  isTickMoveEnabled,
  isCexPriceEnabled,
  getPushCooldownMinutes,
  getAlertCooldownMinutes,
} from "@/lib/db/settings";

export const dynamic = "force-dynamic";

/**
 * 三类告警冷却的分组定义（UI 上一行一个下拉）：
 *   - cex：CEX 价差（仓位 + 收藏池共用）
 *   - range_state：区间状态（越界 out_of_range + 回区间 re_in_range）
 *   - tick_move：区间内波动
 */
const COOLDOWN_GROUPS = {
  cex: ["cex_price", "fav_cex_price"],
  range_state: ["out_of_range", "re_in_range"],
  tick_move: ["tick_move"],
} as const;

type CooldownGroup = keyof typeof COOLDOWN_GROUPS;

/** 读取三类冷却的当前生效值（取组内第一个类型的值作为代表） */
function readCooldownGroups() {
  return {
    cooldown_cex: getAlertCooldownMinutes("cex_price"),
    cooldown_range_state: getAlertCooldownMinutes("out_of_range"),
    cooldown_tick_move: getAlertCooldownMinutes("tick_move"),
  };
}

/** GET: 读取当前告警阈值设置 */
export async function GET() {
  return ok({
    tick_move_enabled: isTickMoveEnabled(),
    tick_move_threshold: getTickMoveThreshold(),
    cex_price_enabled: isCexPriceEnabled(),
    push_cooldown_minutes: getPushCooldownMinutes(),
    ...readCooldownGroups(),
  });
}

/** PUT: 更新告警阈值设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<{
    tick_move_enabled?: string;
    tick_move_threshold?: number;
    cex_price_enabled?: string;
    push_cooldown_minutes?: number;
    cooldown_cex?: number;
    cooldown_range_state?: number;
    cooldown_tick_move?: number;
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
    // 同步 CEX 价差冷却（该配置的语义即控制 CEX 推送频率）
    setSetting("cooldown_cex_price", String(v));
  }

  // 三类分组冷却：写入组内所有类型的独立配置，保证行为一致
  const groups: [CooldownGroup, number | undefined][] = [
    ["cex", body.cooldown_cex],
    ["range_state", body.cooldown_range_state],
    ["tick_move", body.cooldown_tick_move],
  ];
  for (const [group, raw] of groups) {
    if (raw === undefined) continue;
    const v = Number(raw);
    if (!Number.isFinite(v) || v < 1 || v > 60) {
      return fail(`cooldown_${group} 须为 1~60 的数值`);
    }
    for (const type of COOLDOWN_GROUPS[group]) {
      setSetting(`cooldown_${type}`, String(v));
    }
  }

  return ok({
    tick_move_enabled: isTickMoveEnabled(),
    tick_move_threshold: getTickMoveThreshold(),
    cex_price_enabled: isCexPriceEnabled(),
    push_cooldown_minutes: getPushCooldownMinutes(),
    ...readCooldownGroups(),
  });
}
