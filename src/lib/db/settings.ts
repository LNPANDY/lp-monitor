/**
 * 应用设置（键值对存储在 SQLite），用于动态修改运行时配置。
 * 当前支持：scan_cron（扫描频率 cron 表达式）。
 */
import { getDb } from "../db";

export function getSetting(key: string, def = ""): string {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? def;
}

export function setSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).run(key, value);
}

/** 当前生效的扫描 cron 表达式（DB 优先，回退到环境变量，再回退默认）。 */
export function getScanCron(): string {
  const fromDb = getSetting("scan_cron", "");
  if (fromDb) return fromDb;
  return process.env.CRON_EXPRESSION ?? "*/3 * * * *";
}

// ===== 告警阈值设置（DB 优先，回退默认值）=====

/** tick 波动预警阈值：margin 相对位置变化超过该值（百分比，0~100）即告警。默认 10。 */
export function getTickMoveThreshold(): number {
  const v = Number(getSetting("tick_move_threshold", ""));
  return Number.isFinite(v) && v >= 0 ? v : 10;
}

/** tick 波动预警开关。默认开。 */
export function isTickMoveEnabled(): boolean {
  return getSetting("tick_move_enabled", "1") === "1";
}

/** CEX 报价对比开关。默认关（需用户先配置 token 匹配）。 */
export function isCexPriceEnabled(): boolean {
  return getSetting("cex_price_enabled", "0") === "1";
}

/** 推送冷却时间（分钟）。默认 2 分钟。前端可选 2/5/10/20/30，也接受 1~60 任意值。 */
export function getPushCooldownMinutes(): number {
  const v = Number(getSetting("push_cooldown_minutes", ""));
  return Number.isFinite(v) && v >= 1 && v <= 60 ? v : 2;
}

// ===== 按告警类型的推送冷却配置（分钟）=====

export interface NightModeConfig {
  /** 是否启用夜间模式（默认开启 "1"） */
  enabled: boolean;
  /** 夜间开始小时（北京时间 UTC+8，0~23，默认 23 点） */
  startHour: number;
  /** 夜间结束小时（北京时间 UTC+8，0~23，默认 8 点） */
  endHour: number;
  /** 夜间越界重复提醒间隔（分钟，默认 60 分钟，最低 60；若设为 -1 表示夜间仅首次越界推送、不重复推） */
  outOfRangeCooldownMin: number;
  /** 夜间是否静默非核心噪音（自动静默区间内 tick_move 波动、Merkl 高 APR 猎手，并将 CEX 价差冷却拉长至 ≥60 分钟） */
  muteNoise: boolean;
  /** 当前北京时间小时 (0~23) */
  beijingHour: number;
  /** 当前北京时间字符串 (HH:MM) */
  beijingTimeStr: string;
  /** 当前时刻是否处于夜间模式生效中 */
  isActiveNow: boolean;
}

/** 获取当前北京时间 (UTC+8) 的小时与格式化时间字符串 */
export function getBeijingTimeNow(): { hour: number; minute: number; timeStr: string } {
  const now = new Date();
  const hour = (now.getUTCHours() + 8) % 24;
  const minute = now.getUTCMinutes();
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { hour, minute, timeStr };
}

/** 判断指定小时是否落在 [startHour, endHour) 区间（支持跨零点，如 23:00 ~ 08:00） */
export function isHourInWindow(hour: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true; // 全天
  if (startHour < endHour) {
    return hour >= startHour && hour < endHour;
  }
  // 跨午夜（例如 23:00 ~ 08:00）
  return hour >= startHour || hour < endHour;
}

/** 读取当前夜间模式配置及实时生效状态 */
export function getNightModeConfig(): NightModeConfig {
  const enabled = getSetting("night_mode_enabled", "1") === "1";
  const rawStart = Number(getSetting("night_mode_start_hour", "23"));
  const startHour = Number.isInteger(rawStart) && rawStart >= 0 && rawStart <= 23 ? rawStart : 23;
  const rawEnd = Number(getSetting("night_mode_end_hour", "8"));
  const endHour = Number.isInteger(rawEnd) && rawEnd >= 0 && rawEnd <= 23 ? rawEnd : 8;

  const rawOor = Number(getSetting("night_cooldown_out_of_range", "60"));
  // 支持 -1（夜间仅首次越界推、不重复推）或 >= 60 分钟（默认 60 分钟）
  const outOfRangeCooldownMin =
    rawOor === -1
      ? -1
      : Number.isFinite(rawOor) && rawOor >= 60 && rawOor <= 720
      ? Math.round(rawOor)
      : 60;

  const muteNoise = getSetting("night_mute_noise", "1") === "1";
  const { hour: beijingHour, timeStr: beijingTimeStr } = getBeijingTimeNow();
  const isActiveNow = enabled && isHourInWindow(beijingHour, startHour, endHour);

  return {
    enabled,
    startHour,
    endHour,
    outOfRangeCooldownMin,
    muteNoise,
    beijingHour,
    beijingTimeStr,
    isActiveNow,
  };
}

/** 读取日间基准冷却时间（分钟，不受夜间模式动态放大影响，用于设置面板展示） */
export function getBaseAlertCooldownMinutes(alertType: string): number {
  const globalCooldown = getPushCooldownMinutes();
  const key = `cooldown_${alertType}`;
  const v = Number(getSetting(key, ""));
  if (!Number.isFinite(v) || v <= 0) return globalCooldown;
  return v;
}

/**
 * 获取指定告警类型当前实际生效的冷却时间（分钟）。
 * - 日间模式：独立配置 cooldown_<type> > 全局 push_cooldown_minutes > 默认 2。
 * - 夜间模式生效时：
 *   - out_of_range / re_in_range：强制不少于 night_cooldown_out_of_range（默认 60 分钟；若为 -1 则返回 720 分钟即整晚不重复推）
 *   - cex_price / fav_cex_price：若开启夜间降噪，冷却拉长至不少于 60 分钟
 */
export function getAlertCooldownMinutes(alertType: string): number {
  const base = getBaseAlertCooldownMinutes(alertType);
  const night = getNightModeConfig();
  if (!night.isActiveNow) return base;

  if (alertType === "out_of_range" || alertType === "re_in_range") {
    if (night.outOfRangeCooldownMin === -1) return 720; // 12小时内不重复推（仅首次推）
    return Math.max(base, night.outOfRangeCooldownMin, 60);
  }

  if (night.muteNoise && (alertType === "cex_price" || alertType === "fav_cex_price")) {
    return Math.max(base, 60);
  }

  return base;
}

// ===== 快速全量扫描配置 =====

/**
 * 快速全量扫描：首次扫描回溯多少小时。默认 1（1 小时）。
 * 之后扫描走"上次扫描结束块-冗余"逻辑，与本值无关。
 * 范围 1~24。
 */
export function getFullScanFirstHours(): number {
  const v = Number(getSetting("fullscan_first_hours", ""));
  return Number.isFinite(v) && v >= 1 && v <= 24 ? v : 1;
}

/**
 * 快速全量扫描：每次扫描相对于上次扫描结束块的冗余秒数（防漏块）。
 * 默认 10 秒。范围 1~120。
 */
export function getFullScanPaddingSec(): number {
  const v = Number(getSetting("fullscan_padding_sec", ""));
  return Number.isFinite(v) && v >= 1 && v <= 120 ? v : 10;
}

/**
 * 快速全量扫描：兜底 ownerOf 反查的节流时间（分钟）。
 * 同一仓位在 N 分钟内已反查过的，跳过。
 * 默认 5 分钟。范围 1~60。
 */
export function getFullScanRecoverThrottleMin(): number {
  const v = Number(getSetting("fullscan_recover_throttle_min", ""));
  return Number.isFinite(v) && v >= 1 && v <= 60 ? v : 5;
}
