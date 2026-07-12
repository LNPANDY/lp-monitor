/**
 * Next.js instrumentation hook —— 服务端启动后执行一次。
 * 用于在 dev/prod 启动时自动开启 cron 调度器。
 * 仅在 Node.js runtime 下生效。
 *
 * 注意：Next.js 14+ 只要本文件存在即自动加载，无需在 next.config.js 配置
 * experimental.instrumentationHook（那是 13 的写法，14 里会报警告）。
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { getDb } = await import("./lib/db");
    const { startEnhancedScheduler } = await import("./lib/monitor/enhanced-scheduler");
    getDb(); // 触发建表/seed
    startEnhancedScheduler();
    console.log("[instrumentation] register() executed, enhanced dual-frequency scheduler started");
  }
}
