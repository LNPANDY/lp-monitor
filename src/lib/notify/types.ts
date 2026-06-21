export interface Notification {
  title: string;
  body: string;
  /** 可选：点击跳转 URL（区块浏览器等） */
  url?: string;
}

export type ChannelKey = "telegram" | "bark" | "serverchan" | "wecom";

export interface ChannelInfo {
  key: ChannelKey;
  name: string;
  configured: boolean;
}
