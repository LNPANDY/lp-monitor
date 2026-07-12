/**
 * 统一推送去重模块。
 *
 * 两个扫描器（全量扫描 + 已知仓位快速扫描）共享此模块，
 * 通过 push_states 表按 (position_id, alert_type) 去重，
 * 每种告警类型可独立配置冷却时间。
 */
import { getDb } from "../db";
import { getAlertCooldownMinutes } from "../db/settings";

/**
 * 判断是否允许推送。
 * @returns true = 允许推送（未推送过 或 已超过冷却时间）
 */
export function shouldPush(positionId: number, alertType: string): boolean {
  const db = getDb();
  const cooldownMin = getAlertCooldownMinutes(alertType);

  const lastPush = db.prepare(
    `SELECT last_push_time FROM push_states
     WHERE position_id = ? AND alert_type = ?`
  ).get(positionId, alertType) as { last_push_time: string } | undefined;

  if (!lastPush) return true;

  const lastMs = new Date(lastPush.last_push_time).getTime();
  const cooldownMs = cooldownMin * 60 * 1000;
  return Date.now() - lastMs >= cooldownMs;
}

/**
 * 记录一次推送时间（INSERT 或 UPDATE）。
 */
export function recordPush(positionId: number, alertType: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO push_states (position_id, alert_type, last_push_time)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(position_id, alert_type)
     DO UPDATE SET last_push_time = excluded.last_push_time`
  ).run(positionId, alertType);
}
