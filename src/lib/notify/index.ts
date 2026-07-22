import { appEnv } from "../db/config";
import { sendTelegram } from "./telegram";
import { sendBark } from "./bark";
import { sendServerChan } from "./serverchan";
import { sendWeCom } from "./wecom";
import type { ChannelInfo, ChannelKey, Notification } from "./types";
import os from "os";

const SENDERS: Record<ChannelKey, (n: Notification) => Promise<boolean>> = {
  telegram: sendTelegram,
  bark: sendBark,
  serverchan: sendServerChan,
  wecom: sendWeCom,
};

/**
 * 推送来源标识：区分本地 vs VPS 运行实例。
 * 优先用 .env.local 的 PUSH_SOURCE_LABEL（用户自定义名称）；
 * 否则用主机 hostname + 首个外网 IP 拼接。
 * 缓存一次避免每条推送都 os.networkInterfaces()。
 */
let _sourceTag = "";
function getSourceTag(): string {
  if (_sourceTag) return _sourceTag;
  // 用户可在 .env.local 中设 PUSH_SOURCE_LABEL=vps / PUSH_SOURCE_LABEL=local 等
  const custom = process.env.PUSH_SOURCE_LABEL ?? "";
  if (custom) { _sourceTag = custom; return _sourceTag; }
  // 自动推导：hostname + 首个非内网 IP
  try {
    const hostname = os.hostname();
    const nets = os.networkInterfaces();
    let ip = "";
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] ?? []) {
        if (net.family === "IPv4" && !net.internal) {
          ip = net.address;
          break;
        }
      }
      if (ip) break;
    }
    _sourceTag = ip ? `${hostname}/${ip}` : hostname;
  } catch {
    _sourceTag = "unknown";
  }
  return _sourceTag;
}

/**
 * 在 body 末尾统一追加来源标识。
 * 所有渠道（bark/telegram/serverchan/wecom）都自动带上。
 */
function appendSource(n: Notification): Notification {
  const tag = getSourceTag();
  const suffix = `\n[来源: ${tag}]`;
  // 不要对已有 suffix 的重复追加（测试推送时可能多次调用）
  if (n.body && n.body.endsWith(suffix)) return n;
  return {
    ...n,
    body: (n.body ?? "") + suffix,
  };
}

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
  const tagged = appendSource(n);
  const tasks = (Object.keys(SENDERS) as ChannelKey[]).map(async (k) => {
    const ok = await SENDERS[k](tagged);
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
  return SENDERS[k](appendSource({
    title: "LP Monitor 测试",
    body: "✅ 这是一条来自 LP Monitor 的测试消息，渠道配置成功。",
  }));
}

/** 获取当前推送来源标识（前端可调用于展示）。 */
export function getPushSourceTag(): string {
  return getSourceTag();
}
