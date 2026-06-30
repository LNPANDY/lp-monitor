/**
 * 应用设置管理
 */

import { getDb } from "./db";

export interface AppSettings {
  staking_scan_method: "transfer_scan" | "contract_direct" | "hybrid";
  staking_scan_fallback_enabled: boolean;
  staking_scan_contract_batch_size: number;
  staking_scan_concurrent_limit: number;
}

interface SettingRow { key: string; value: string }

export function getSettings(): Partial<AppSettings> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as SettingRow[];

  const settings: Partial<AppSettings> = {};

  for (const row of rows) {
    const key = row.key as keyof AppSettings;
    const value = row.value;

    // 根据字段类型进行转换
    switch (key) {
      case "staking_scan_method":
        if (["transfer_scan", "contract_direct", "hybrid"].includes(value)) {
          settings[key] = value as AppSettings["staking_scan_method"];
        }
        break;
      case "staking_scan_fallback_enabled":
        settings[key] = value === "true" || value === "1";
        break;
      case "staking_scan_contract_batch_size":
        const num = parseInt(value);
        if (!isNaN(num) && num > 0) {
          settings[key] = num;
        }
        break;
      case "staking_scan_concurrent_limit":
        const concurrent = parseInt(value);
        if (!isNaN(concurrent) && concurrent > 0) {
          settings[key] = concurrent;
        }
        break;
    }
  }

  return settings;
}

export function getSetting<T extends keyof AppSettings>(key: T): AppSettings[T] | null {
  const settings = getSettings();
  return settings[key] || null;
}

export function setSetting<T extends keyof AppSettings>(key: T, value: AppSettings[T]): void {
  const db = getDb();
  
  // 根据类型转换值
  let stringValue: string;
  switch (key) {
    case "staking_scan_method":
    case "staking_scan_fallback_enabled":
      stringValue = String(value);
      break;
    case "staking_scan_contract_batch_size":
    case "staking_scan_concurrent_limit":
      stringValue = String(value);
      break;
    default:
      stringValue = String(value);
  }
  
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, stringValue);
}

export function updateSettings(updates: Partial<AppSettings>): void {
  const db = getDb();
  
  for (const [key, value] of Object.entries(updates)) {
    setSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
  }
}

/**
 * 获取质押扫描方式设置
 */
export function getStakingScanMethod(): "transfer_scan" | "contract_direct" | "hybrid" {
  const method = getSetting("staking_scan_method") || "transfer_scan";
  return method;
}

/**
 * 获取质押扫描并发限制
 */
export function getStakingConcurrentLimit(): number {
  const limit = getSetting("staking_scan_concurrent_limit") || 6;
  return Math.min(Math.max(limit, 1), 20); // 限制在1-20之间
}

/**
 * 获取合约直查的批量大小
 */
export function getContractBatchSize(): number {
  const batchSize = getSetting("staking_scan_contract_batch_size") || 50;
  return Math.min(Math.max(batchSize, 10), 200); // 限制在10-200之间
}

/**
 * 是否启用兜底机制
 */
export function isStakingFallbackEnabled(): boolean {
  return getSetting("staking_scan_fallback_enabled") || true;
}