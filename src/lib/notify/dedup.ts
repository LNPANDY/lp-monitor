/**
 * 统一推送去重模块。
 *
 * 两个扫描器（全量扫描 + 已知仓位快速扫描）+ 收藏池监控共享此模块，
 * 通过 push_states 表按 (entity_type, position_id, alert_type) 去重，
 * 每种告警类型可独立配置冷却时间。
 *
 * entity_type 区分实体：'position'=仓位 | 'fav_pool'=流动性探针收藏池。
 * 两者的 id 空间独立，靠 entity_type 隔离避免撞号。
 */
import { getDb } from "../db";
import { getAlertCooldownMinutes } from "../db/settings";

/** 实体类型：仓位（默认）或收藏池 */
export type PushEntityType = "position" | "fav_pool";

/** 受冷却限制的告警类型白名单（其余类型每次都推） */
const COOLDOWN_TYPES = ["cex_price", "out_of_range", "fav_cex_price"];

/**
 * 判断是否允许推送。
 * @param positionId - 实体ID（仓位ID 或 收藏池ID，由 entityType 决定）
 * @param alertType - 告警类型
 * @param currentState - 当前告警状态（用于状态感知冷却）
 * @param entityType - 实体类型，默认 'position'（现有调用点无需改动）
 * @returns true = 允许推送（未推送过 或 已超过冷却时间 或 状态发生变化）
 */
export function shouldPush(
  positionId: number,
  alertType: string,
  currentState: string,
  entityType: PushEntityType = "position"
): boolean {
  // 仅对特定类型应用冷却
  if (!COOLDOWN_TYPES.includes(alertType)) return true;

  const db = getDb();
  const cooldownMin = getAlertCooldownMinutes(alertType);

  const lastPush = db.prepare(
    `SELECT last_push_time, last_alert_state FROM push_states
     WHERE entity_type = ? AND position_id = ? AND alert_type = ?`
  ).get(entityType, positionId, alertType) as { last_push_time: string; last_alert_state: string } | undefined;

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
}

/**
 * 记录一次推送时间（INSERT 或 UPDATE）。
 * @param positionId - 实体ID（仓位ID 或 收藏池ID，由 entityType 决定）
 * @param alertType - 告警类型
 * @param currentState - 当前告警状态（用于状态感知冷却）
 * @param entityType - 实体类型，默认 'position'（现有调用点无需改动）
 */
export function recordPush(
  positionId: number,
  alertType: string,
  currentState: string,
  entityType: PushEntityType = "position"
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO push_states (entity_type, position_id, alert_type, last_push_time, last_alert_state)
    VALUES (?, ?, ?, datetime('now'), ?)
    ON CONFLICT(entity_type, position_id, alert_type)
    DO UPDATE SET last_push_time = excluded.last_push_time, last_alert_state = excluded.last_alert_state
  `).run(entityType, positionId, alertType, currentState);
  console.log(`[recordPush] Recorded push for ${entityType} ${positionId}, type ${alertType}, state ${currentState}`);
}
