/**
 * 应用设置管理
 */

import { getDb } from "./db";

export interface AppSettings {
  push_cooldown_minutes: number;
}

interface SettingRow { key: string; value: string }

export function getSettings(): Partial<AppSettings> {
  const db = getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings").all() as SettingRow[];

  const settings: Partial<AppSettings> = {};

  for (const row of rows) {
    const key = row.key as keyof AppSettings;
    const value = row.value;

    switch (key) {
      case "push_cooldown_minutes":
        const cooldown = parseInt(value);
        if (!isNaN(cooldown) && cooldown >= 1) {
          settings[key] = cooldown;
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
  db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?, ?)").run(key, String(value));
}

export function updateSettings(updates: Partial<AppSettings>): void {
  const db = getDb();

  for (const [key, value] of Object.entries(updates)) {
    setSetting(key as keyof AppSettings, value as AppSettings[keyof AppSettings]);
  }
}

/**
 * 获取推送冷却时间（分钟）
 */
export function getPushCooldownMinutes(): number {
  const cooldown = getSetting("push_cooldown_minutes") || 2;
  return Math.min(Math.max(cooldown, 1), 60); // 限制在1-60分钟之间
}