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
    night_mode_active_now: night.isActiveNow,
    night_mode_until_ms: night.untilMs,
    night_mode_default_hours: night.defaultHours,
    night_mode_remaining_minutes: night.remainingMinutes,
    night_mode_expires_beijing: night.expiresAtBeijingStr,
    night_cooldown_out_of_range: night.outOfRangeCooldownMin,
    night_mute_noise: night.muteNoise,
    beijing_time: night.beijingTimeStr,
  };
}

/** GET: 读取当前告警阈值与夜间模式设置 */
export async function GET() {
  return ok(buildAlertSettingsPayload());
}

/** PUT: 更新告警阈值或手动睡眠模式设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<{
    tick_move_enabled?: string;
    tick_move_threshold?: number;
    cex_price_enabled?: string;
    push_cooldown_minutes?: number;
    cooldown_cex?: number;
    cooldown_range_state?: number;
    cooldown_tick_move?: number;
    night_action?: "start" | "stop" | "extend";
    night_hours?: number;
    night_mode_default_hours?: number;
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

  // 手动睡眠/夜间模式操作
  if (body.night_mode_default_hours !== undefined) {
    const h = Number(body.night_mode_default_hours);
    if (h !== -1 && (!Number.isFinite(h) || h < 0.5 || h > 48)) {
      return fail("开启时长须为 0.5~48 小时（或 -1 持续开启）");
    }
    setSetting("night_mode_default_hours", String(h));
  }

  if (body.night_action === "stop") {
    setSetting("night_mode_until_ms", "0");
  } else if (body.night_action === "start") {
    const cur = getNightModeConfig();
    const hours =
      body.night_hours !== undefined ? Number(body.night_hours) : cur.defaultHours;
    if (hours === -1) {
      setSetting("night_mode_default_hours", "-1");
      setSetting("night_mode_until_ms", "-1");
    } else if (Number.isFinite(hours) && hours >= 0.5 && hours <= 48) {
      setSetting("night_mode_default_hours", String(hours));
      const untilMs = Date.now() + Math.round(hours * 3600 * 1000);
      setSetting("night_mode_until_ms", String(untilMs));
    } else {
      return fail("开启时长须为 0.5~48 小时（或 -1 持续开启）");
    }
  } else if (body.night_action === "extend") {
    const cur = getNightModeConfig();
    const addHours = Number(body.night_hours ?? 2);
    if (!Number.isFinite(addHours) || addHours <= 0 || addHours > 24) {
      return fail("延长时长须为 1~24 小时");
    }
    const baseMs = cur.untilMs > Date.now() ? cur.untilMs : Date.now();
    const untilMs = baseMs + Math.round(addHours * 3600 * 1000);
    setSetting("night_mode_until_ms", String(untilMs));
  }

  if (body.night_cooldown_out_of_range !== undefined) {
    const m = Number(body.night_cooldown_out_of_range);
    if (m !== -1 && (!Number.isFinite(m) || m < 60 || m > 720)) {
      return fail("睡眠模式越界重复冷却须不少于 60 分钟（或设为 -1 仅推首次）");
    }
    setSetting("night_cooldown_out_of_range", String(Math.round(m)));
  }
  if (body.night_mute_noise !== undefined) {
    const on = body.night_mute_noise === true || String(body.night_mute_noise) === "1";
    setSetting("night_mute_noise", on ? "1" : "0");
  }

  return ok(buildAlertSettingsPayload());
}
