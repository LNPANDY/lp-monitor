import { appEnv } from "../db/config";
import type { Notification } from "./types";

/**
 * Bark 推送（iOS）。POST {server}/{key}（JSON body）。
 *
 * 支持多设备：BARK_KEY 用英文逗号分隔多个设备 key，会并行向所有设备推送，
 * 只要至少一台设备成功即视为渠道成功（避免单台故障触发重复告警）。
 * 失败的设备会打印 console.warn 便于排查。
 */
export async function sendBark(n: Notification): Promise<boolean> {
  const { key, server } = appEnv.bark;
  // 英文逗号分隔，trim 并去空值
  const keys = key
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (keys.length === 0) return false;

  const base = server.replace(/\/$/, "");
  const pushOne = async (deviceKey: string): Promise<boolean> => {
    try {
      const res = await fetch(`${base}/${deviceKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: n.title,
          body: n.body,
          url: n.url,
          group: "lp-monitor",
          sound: "alarm",
        }),
        signal: AbortSignal.timeout(10_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  };

  const results = await Promise.all(keys.map(pushOne));
  // 至少一台成功即视为渠道成功
  const anyOk = results.some((ok) => ok);
  // 失败的设备记日志，便于排查（不阻断整体流程）
  if (!anyOk || results.includes(false)) {
    results.forEach((ok, i) => {
      if (!ok) console.warn(`[bark] 推送失败: ${keys[i].slice(0, 8)}…`);
    });
  }
  return anyOk;
}
