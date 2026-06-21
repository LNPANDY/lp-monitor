/**
 * 独立运行入口：`npm run scan` 执行一次扫描后退出。
 * 用于调试，或在没有 Next 服务时由系统 cron 触发。
 * 注意：ts-node 需 ESM/COMMON 配置，这里用动态编译执行。
 */
import { runScan } from "./scanner";

(async () => {
  const summary = await runScan();
  console.log(JSON.stringify(summary, null, 2));
  process.exit(summary.errors.length > 0 ? 1 : 0);
})();
