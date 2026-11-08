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
  /** 当前是否处于睡眠/夜间低频模式生效中 */
  enabled: boolean;
  /** 睡眠模式到期时间戳（毫秒）：0 = 已关闭；-1 = 持续开启直到手动关闭；>0 = 到期自动恢复日间模式 */
  untilMs: number;
  /** 默认一键开启时长（小时，默认 8 小时） */
  defaultHours: number;
  /** 剩余生效分钟数（0 = 未生效，-1 = 持续开启直到手动关闭） */
  remainingMinutes: number;
  /** 到期北京时间字符串（如 "08:30"，未生效为空） */
  expiresAtBeijingStr: string;
  /** 睡眠期间越界重复提醒间隔（分钟，默认 60 分钟，最低 60；若设为 -1 表示仅首次越界推送、不重复推） */
  outOfRangeCooldownMin: number;
  /** 睡眠期间是否静默非核心噪音（自动静默区间内 tick_move 波动、Merkl 高 APR 猎手，并将 CEX 价差冷却拉长至 ≥60 分钟） */
  muteNoise: boolean;
  /** 当前北京时间小时 (0~23) */
  beijingHour: number;
  /** 当前北京时间字符串 (HH:MM) */
  beijingTimeStr: string;
  /** 当前时刻是否处于睡眠/夜间模式生效中 */
  isActiveNow: boolean;
}

/** 将任意毫秒时间戳格式化为北京时间 (UTC+8) 的 HH:MM */
export function formatBeijingTimeMs(ms: number): { hour: number; minute: number; timeStr: string } {
  const d = new Date(ms);
  const hour = (d.getUTCHours() + 8) % 24;
  const minute = d.getUTCMinutes();
  const timeStr = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return { hour, minute, timeStr };
}

/** 获取当前北京时间 (UTC+8) 的小时与格式化时间字符串 */
export function getBeijingTimeNow(): { hour: number; minute: number; timeStr: string } {
  return formatBeijingTimeMs(Date.now());
}

/** 读取当前手动睡眠/夜间低频模式配置及倒计时状态 */
export function getNightModeConfig(): NightModeConfig {
  const nowMs = Date.now();
  const rawUntil = Number(getSetting("night_mode_until_ms", "0"));
  const untilMs = Number.isFinite(rawUntil) ? rawUntil : 0;

  const rawDefaultHours = Number(getSetting("night_mode_default_hours", "8"));
  const defaultHours =
    rawDefaultHours === -1
      ? -1
      : Number.isFinite(rawDefaultHours) && rawDefaultHours >= 0.5 && rawDefaultHours <= 48
      ? rawDefaultHours
      : 8;

  const isActiveNow = untilMs === -1 || untilMs > nowMs;
  const remainingMinutes =
    untilMs === -1
      ? -1
      : untilMs > nowMs
      ? Math.max(1, Math.ceil((untilMs - nowMs) / 60_000))
      : 0;

  const expiresAtBeijingStr =
    untilMs === -1
      ? "手动关闭前持续生效"
      : untilMs > nowMs
      ? formatBeijingTimeMs(untilMs).timeStr
      : "";

  const rawOor = Number(getSetting("night_cooldown_out_of_range", "60"));
  // 支持 -1（睡眠期间仅首次越界推、不重复推）或 >= 60 分钟（默认 60 分钟）
  const outOfRangeCooldownMin =
    rawOor === -1
      ? -1
      : Number.isFinite(rawOor) && rawOor >= 60 && rawOor <= 720
      ? Math.round(rawOor)
      : 60;

  const muteNoise = getSetting("night_mute_noise", "1") === "1";
  const { hour: beijingHour, timeStr: beijingTimeStr } = getBeijingTimeNow();

  return {
    enabled: isActiveNow,
    untilMs: isActiveNow ? untilMs : 0,
    defaultHours,
    remainingMinutes,
    expiresAtBeijingStr,
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
