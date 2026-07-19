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
 * @param positionId - 仓位ID
 * @param alertType - 告警类型
 * @param currentState - 当前告警状态（用于状态感知冷却）
 * @returns true = 允许推送（未推送过 或 已超过冷却时间 或 状态发生变化）
 */
export function shouldPush(positionId: number, alertType: string, currentState: string): boolean {
  // 仅对特定类型应用冷却
  if (!['cex_price', 'out_of_range'].includes(alertType)) return true;
  
  const db = getDb();
  const cooldownMin = getAlertCooldownMinutes(alertType);
  
  const lastPush = db.prepare(
    `SELECT last_push_time, last_alert_state FROM push_states
     WHERE position_id = ? AND alert_type = ?`
  ).get(positionId, alertType) as { last_push_time: string; last_alert_state: string } | undefined;
  
  if (!lastPush) return true; // 首次推送
  
  // SQLite datetime('now') 返回 UTC 时间字符串 'YYYY-MM-DD HH:MM:SS'（无时区后缀），
  // V8 的 Date 会把无时区字符串按本地时区解析，导致时间偏差（如 UTC+8 会差 8 小时）。
  // 这里把空格替换成 'T' 并补上 'Z' 后缀，强制按 UTC 解析。
  const lastMs = new Date(lastPush.last_push_time.replace(' ', 'T') + 'Z').getTime();
  const cooldownMs = cooldownMin * 60 * 1000;
  
  // 状态相同且冷却时间未到 → 阻止推送
  if (lastPush.last_alert_state === currentState && 
      Date.now() - lastMs < cooldownMs) {
    console.log(`[shouldPush] Blocking push: same state (${currentState}) and within cooldown (${cooldownMin} minutes)`);
    console.log(`[shouldPush] Last push state: ${lastPush.last_alert_state}, Current state: ${currentState}`);
    console.log(`[shouldPush] Last push time: ${lastPush.last_push_time}, Time difference: ${Date.now() - lastMs}ms`);
    return false;
  } else {
    console.log(`[shouldPush] Allowing push: state changed or no previous record`);
    console.log(`[shouldPush] Last push state: ${lastPush.last_alert_state}, Current state: ${currentState}`);
    return true;
  }
  
  return true; // 状态变化或冷却时间已到 → 允许推送
}

/**
 * 记录一次推送时间（INSERT 或 UPDATE）。
 * @param positionId - 仓位ID
 * @param alertType - 告警类型
 * @param currentState - 当前告警状态（用于状态感知冷却）
 */
export function recordPush(positionId: number, alertType: string, currentState: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_states (position_id, alert_type, last_push_time, last_alert_state)
    VALUES (?, ?, datetime('now'), ?)
    ON CONFLICT(position_id, alert_type)
    DO UPDATE SET last_push_time = excluded.last_push_time, last_alert_state = excluded.last_alert_state
  `).run(positionId, alertType, currentState);
  console.log(`[recordPush] Recorded push for position ${positionId}, type ${alertType}, state ${currentState}`);
}
