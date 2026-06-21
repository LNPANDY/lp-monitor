/**
 * Next.js instrumentation hook —— 服务端启动后执行一次。
 * 用于在 dev/prod 启动时自动开启 cron 调度器。
 * 仅在 Node.js runtime 下生效。
 */
export async function register() {
  // 仅服务端运行，避免在 edge/worker 加载
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./lib/db");
    const { startScheduler } = await import("./lib/monitor/scheduler");
    getDb(); // 触发建表/seed
    startScheduler();
  }
}
