/**
 * ZIA / 0G 专属功能总开关（质押合约安全哨兵、Merkl W0G 奖励精算、Zia 新激励抢跑哨兵、顶部 ZIA 胶囊与抽屉）。
 *
 * 默认关闭：保留全部底层实现代码，但不再在后台调度、API 冷启动或首页轮询中消耗 RPC / API / 页面空间。
 * 若未来需要重新启用，在 .env.local 设置 ENABLE_ZIA_FEATURES=1 和 NEXT_PUBLIC_ENABLE_ZIA_FEATURES=1 即可。
 */
export const ZIA_FEATURES_ENABLED =
  process.env.ENABLE_ZIA_FEATURES === "1" ||
  process.env.NEXT_PUBLIC_ENABLE_ZIA_FEATURES === "1";
