export interface Notification {
  title: string;
  body: string;
  /** 可选：点击跳转 URL（区块浏览器等） */
  url?: string;
  /** 可选：紧急强提醒（Bark 开启 critical 突破静音 + call=1 持续响铃） */
  urgent?: boolean;
  /** 可选：通知分组 */
  group?: string;
}

export type ChannelKey = "telegram" | "bark" | "serverchan" | "wecom";

export interface ChannelInfo {
  key: ChannelKey;
  name: string;
  configured: boolean;
}
