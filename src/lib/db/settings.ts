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

/** 推送冷却时间（分钟）。默认 2 分钟，可选 2, 5, 10, 20, 30。 */
export function getPushCooldownMinutes(): number {
  const v = Number(getSetting("push_cooldown_minutes", ""));
  return [2, 5, 10, 20, 30].includes(v) ? v : 2;
}

// ===== 按告警类型的推送冷却配置（分钟）=====

/** 获取指定告警类型的冷却时间（分钟）。 */
export function getAlertCooldownMinutes(alertType: string): number {
  const key = `cooldown_${alertType}`;
  const v = Number(getSetting(key, ""));
  return Number.isFinite(v) && v > 0 ? v : getDefaultCooldown(alertType);
}

/** 告警类型冷却默认值映射。 */
	function getDefaultCooldown(alertType: string): number {
	  const map: Record<string, number> = {
	    out_of_range: 30,
	    re_in_range: 30,
	    cex_price: 2,
	    tick_move: 10,
	  };
	  return map[alertType] ?? getPushCooldownMinutes(); // 回退到全局默认
	}
