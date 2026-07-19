/**
 * 链平均出块时间运行时探测。
 *
 * 不依赖 chains 表的预设字段（目前没有 block_time 列），运行时取最近 N 个区块
 * 的时间戳差值除以区块数差值，得到平均出块时间（秒/块）。
 *
 * 用途：快速全量扫描首次启动时，把"回溯 N 小时"换算成"回溯 X 个区块"。
 * 之后扫描走"上次扫描结束块-冗余块"逻辑，不再依赖本函数。
 */
import type { PublicClient } from "viem";

/**
 * 探测一条链的平均出块时间（秒/块）。
 * 采样策略：取 [latest, latest-sampleBlocks] 两端的时间戳差除以采样块数。
 * RPC 失败或时间戳非法 → 回退 fallbackSec（默认 12，即 Ethereum 主网出块间隔）。
 */
export async function estimateBlockTimeSec(
  client: PublicClient,
  sampleBlocks = 50n,
  fallbackSec = 12
): Promise<number> {
  try {
    const latest = await client.getBlockNumber();
    if (latest < sampleBlocks) return fallbackSec; // 链太短，直接回退
    const [head, tail] = await Promise.all([
      client.getBlock({ blockNumber: latest, includeTransactions: false }),
      client.getBlock({ blockNumber: latest - sampleBlocks, includeTransactions: false }),
    ]);
    const dt = Number(head.timestamp) - Number(tail.timestamp);
    const dbn = Number(latest) - Number(latest - sampleBlocks);
    if (dt <= 0 || dbn <= 0) return fallbackSec;
    const secPerBlock = dt / dbn;
    // 合理性校验：0.1~120 秒/块（覆盖亚秒级 L2 ~ 慢速 L1）
    // 0G/Avalanche 等高速链出块时间可低至 0.5 秒，下限设 0.1 容错
    if (!Number.isFinite(secPerBlock) || secPerBlock < 0.1 || secPerBlock > 120) return fallbackSec;
    return secPerBlock;
  } catch {
    return fallbackSec;
  }
}

/**
 * 把"回溯 X 秒"换算成"回溯 Y 个区块"。
 * blockTime 为秒/块，向上取整保证窗口足够大。
 */
export function secondsToBlocks(seconds: number, blockTimeSec: number): bigint {
  if (blockTimeSec <= 0) blockTimeSec = 12;
  return BigInt(Math.ceil(seconds / blockTimeSec));
}