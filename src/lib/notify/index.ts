import { appEnv } from "../db/config";
import { sendTelegram } from "./telegram";
import { sendBark } from "./bark";
import { sendServerChan } from "./serverchan";
import { sendWeCom } from "./wecom";
import type { ChannelInfo, ChannelKey, Notification } from "./types";

const SENDERS: Record<ChannelKey, (n: Notification) => Promise<boolean>> = {
  telegram: sendTelegram,
  bark: sendBark,
  serverchan: sendServerChan,
  wecom: sendWeCom,
};

/** 返回所有渠道及其当前是否已配置（前端用于显示状态 + 测试按钮）。 */
export function channelStatus(): ChannelInfo[] {
  return [
    { key: "telegram", name: "Telegram Bot", configured: !!(appEnv.telegram.botToken && appEnv.telegram.chatId) },
    { key: "bark", name: "Bark (iOS)", configured: !!appEnv.bark.key },
    { key: "serverchan", name: "Server酱 (微信)", configured: !!appEnv.serverchan.key },
    { key: "wecom", name: "企业微信机器人", configured: !!appEnv.wecom.webhookKey },
  ];
}

export interface SendResult {
  sent: ChannelKey[];
  failed: ChannelKey[];
}

/** 并行向所有已配置渠道发送，返回成功/失败的渠道列表。 */
export async function notifyAll(n: Notification): Promise<SendResult> {
  const tasks = (Object.keys(SENDERS) as ChannelKey[]).map(async (k) => {
    const ok = await SENDERS[k](n);
    return [k, ok] as const;
  });
  const results = await Promise.all(tasks);
  const sent: ChannelKey[] = [];
  const failed: ChannelKey[] = [];
  for (const [k, ok] of results) {
    (ok ? sent : failed).push(k);
  }
  return { sent, failed };
}

/** 只测试单个渠道（配置页「测试」按钮用）。 */
export async function testChannel(k: ChannelKey): Promise<boolean> {
  return SENDERS[k]({
    title: "LP Monitor 测试",
    body: "✅ 这是一条来自 LP Monitor 的测试消息，渠道配置成功。",
  });
}
