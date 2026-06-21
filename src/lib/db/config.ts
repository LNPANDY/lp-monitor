/** 统一读取环境变量，提供带默认值的访问。所有可选配置都从 .env.local 读取。 */
export const appEnv = {
  rpc: {
    alchemyKey: process.env.ALCHEMY_KEY ?? "",
    infuraKey: process.env.INFURA_KEY ?? "",
  },
  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN ?? "",
    chatId: process.env.TELEGRAM_CHAT_ID ?? "",
  },
  bark: {
    key: process.env.BARK_KEY ?? "",
    server: process.env.BARK_SERVER ?? "https://api.day.app",
  },
  serverchan: {
    key: process.env.SERVERCHAN_KEY ?? "",
  },
  wecom: {
    webhookKey: process.env.WECOM_WEBHOOK_KEY ?? "",
  },
  monitor: {
    cron: process.env.CRON_EXPRESSION ?? "*/3 * * * *",
    cooldownMs: Number(process.env.ALERT_COOLDOWN_MS ?? 3600000),
  },
  dbPath: process.env.DB_PATH ?? "./data/app.db",
};

export const dbPath = appEnv.dbPath;
