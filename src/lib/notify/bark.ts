import { appEnv } from "../db/config";
import type { Notification } from "./types";

/** Bark 推送（iOS）。POST {server}/{key}/{title}/{body} 或 JSON。 */
export async function sendBark(n: Notification): Promise<boolean> {
  const { key, server } = appEnv.bark;
  if (!key) return false;
  try {
    const base = server.replace(/\/$/, "");
    const res = await fetch(`${base}/${key}`, {
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
}
