import { appEnv } from "../db/config";
import type { Notification } from "./types";

/**
 * 企业微信群机器人。webhook 形如
 *   https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=<KEY>
 * env 里只存 key 部分。
 */
export async function sendWeCom(n: Notification): Promise<boolean> {
  const { webhookKey } = appEnv.wecom;
  if (!webhookKey) return false;
  try {
    const res = await fetch(
      `https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=${webhookKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          msgtype: "markdown",
          markdown: {
            content: `**${n.title}**\n${n.body}` + (n.url ? `\n[详情](${n.url})` : ""),
          },
        }),
        signal: AbortSignal.timeout(10_000),
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}
