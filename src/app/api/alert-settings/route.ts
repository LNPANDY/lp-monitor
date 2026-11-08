import { ok, fail, getBody } from "@/lib/api";
import { setSetting } from "@/lib/db/settings";
import {
  getTickMoveThreshold,
  isTickMoveEnabled,
  isCexPriceEnabled,
  getPushCooldownMinutes,
  getBaseAlertCooldownMinutes,
  getNightModeConfig,
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

/** 读取三类日间基准冷却的配置值 */
function readCooldownGroups() {
  return {
    cooldown_cex: getBaseAlertCooldownMinutes("cex_price"),
    cooldown_range_state: getBaseAlertCooldownMinutes("out_of_range"),
    cooldown_tick_move: getBaseAlertCooldownMinutes("tick_move"),
  };
}

function buildAlertSettingsPayload() {
  const night = getNightModeConfig();
  return {
    tick_move_enabled: isTickMoveEnabled(),
    tick_move_threshold: getTickMoveThreshold(),
    cex_price_enabled: isCexPriceEnabled(),
    push_cooldown_minutes: getPushCooldownMinutes(),
    ...readCooldownGroups(),
    night_mode_enabled: night.enabled,
    night_mode_start_hour: night.startHour,
    night_mode_end_hour: night.endHour,
    night_cooldown_out_of_range: night.outOfRangeCooldownMin,
    night_mute_noise: night.muteNoise,
    night_mode_active_now: night.isActiveNow,
    beijing_time: night.beijingTimeStr,
  };
}

/** GET: 读取当前告警阈值与夜间模式设置 */
export async function GET() {
  return ok(buildAlertSettingsPayload());
}

/** PUT: 更新告警阈值或夜间模式设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<{
    tick_move_enabled?: string;
    tick_move_threshold?: number;
    cex_price_enabled?: string;
    push_cooldown_minutes?: number;
    cooldown_cex?: number;
    cooldown_range_state?: number;
    cooldown_tick_move?: number;
    night_mode_enabled?: string | boolean;
    night_mode_start_hour?: number;
    night_mode_end_hour?: number;
    night_cooldown_out_of_range?: number;
    night_mute_noise?: string | boolean;
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
    if (!Number.isFinite(v) || v < 0 || v > 60) {
      return fail(`cooldown_${group} 须为 0~60 的数值`);
    }
    for (const type of COOLDOWN_GROUPS[group]) {
      setSetting(`cooldown_${type}`, String(v));
    }
  }

  // 夜间模式配置
  if (body.night_mode_enabled !== undefined) {
    const on = body.night_mode_enabled === true || String(body.night_mode_enabled) === "1";
    setSetting("night_mode_enabled", on ? "1" : "0");
  }
  if (body.night_mode_start_hour !== undefined) {
    const h = Number(body.night_mode_start_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return fail("night_mode_start_hour 须为 0~23 的整点");
    setSetting("night_mode_start_hour", String(h));
  }
  if (body.night_mode_end_hour !== undefined) {
    const h = Number(body.night_mode_end_hour);
    if (!Number.isInteger(h) || h < 0 || h > 23) return fail("night_mode_end_hour 须为 0~23 的整点");
    setSetting("night_mode_end_hour", String(h));
  }
  if (body.night_cooldown_out_of_range !== undefined) {
    const m = Number(body.night_cooldown_out_of_range);
    if (m !== -1 && (!Number.isFinite(m) || m < 60 || m > 720)) {
      return fail("夜间越界重复冷却须不少于 60 分钟（或设为 -1 仅推首次）");
    }
    setSetting("night_cooldown_out_of_range", String(Math.round(m)));
  }
  if (body.night_mute_noise !== undefined) {
    const on = body.night_mute_noise === true || String(body.night_mute_noise) === "1";
    setSetting("night_mute_noise", on ? "1" : "0");
  }

  return ok(buildAlertSettingsPayload());
}
