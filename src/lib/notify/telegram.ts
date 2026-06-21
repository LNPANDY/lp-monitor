import { appEnv } from "../db/config";
import type { Notification } from "./types";

/** Telegram Bot API 发消息。需要 botToken + chatId。 */
export async function sendTelegram(n: Notification): Promise<boolean> {
  const { botToken, chatId } = appEnv.telegram;
  if (!botToken || !chatId) return false;
  try {
    const text = n.title ? `*${n.title}*\n${n.body}` : n.body;
    const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
