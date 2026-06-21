import { appEnv } from "../db/config";
import type { Notification } from "./types";

/** Server酱（Turbo / 微信推送）。POST https://sctapi.ftqq.com/<SCKEY>.send */
export async function sendServerChan(n: Notification): Promise<boolean> {
  const { key } = appEnv.serverchan;
  if (!key) return false;
  try {
    const res = await fetch(`https://sctapi.ftqq.com/${key}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        title: n.title.slice(0, 32),
        desp: n.body + (n.url ? `\n\n[详情](${n.url})` : ""),
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
