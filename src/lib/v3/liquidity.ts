/**
 * V3 流动性分析业务层 —— 计算指定 tick 区间内的流动性（token0/token1 形式）。
 *
 * 三种场景：
 *   A. analyzeDirect : 直接持有的 LP，用 Pool.liquidity() + slot0() 算全池在你区间的流动性
 *   B. analyzeStaked : 已质押的 LP，枚举质押合约(vault)在 NPM 上持有的全部 NFT，筛同池子累加
 *   C. probeMinRange : 给定池子地址，算 fee 对应 tickSpacing 的最小窗口流动性 + 价格区间
 *
 * 设计要点：
 *   - vault 合约（ZIA 风格）的 NFT 托管方式：vault 作为 owner 持有 LP NFT（在 NPM 上），
 *     因此用 NPM.balanceOf(vault) + NPM.tokenOfOwnerByIndex(vault, i) 即可枚举全部，
 *     比扫 Transfer 事件快且完整。
 *   - 单个 LP 的 tick/liquidity 从 NPM.positions(tokenId) 读取。
 *   - 同池子判定：token0 + token1 + fee 三者一致（地址小写比较，忽略顺序——positions 返回的
 *     token0/token1 已排序，同池子必然一致）。
 */
import type { PublicClient } from "viem";
import {
  V3_NPM_ABI,
  V3_POOL_ABI,
  readPositionMeta,
  type V3PositionMeta,
} from "../adapters/v3-fork";
import {
  getAmountsForLiquidity,
  tickToSqrtPriceX96,
  tickToPriceDisplay,
  FEE_TO_TICK_SPACING,
} from "./math";

// Pool ABI 补充：liquidity()、tickSpacing()、fee()、token0()、token1()
const POOL_EXTRA_ABI = [
  { name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128" }] },
  { name: "tickSpacing", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

// ==================== 公共类型 ====================

export interface LiquidityBreakdown {
  amount0: string; // 可读数量（已 / 10^decimals）
  amount1: string;
}

export interface LiquidityResult {
  /** 区间内总流动性（token0/token1 形式） */
  total: LiquidityBreakdown;
  /** 你自己的流动性（仅 direct 场景有，staked 场景为 total 的副本） */
  mine: LiquidityBreakdown;
  /** 你的占比 0~1 */
  share: number;
  /** 区间对应的价格范围 [low, high]，含义：1 token0 = [low, high] token1 */
  priceLow: string;
  priceHigh: string;
  /** 价格的展示方向标签，如 "0G/USDC" */
  priceLabel: string;
  /** 当前 tick */
  currentTick: number;
  /** 区间 [tickLower, tickUpper] */
  tickLower: number;
  tickUpper: number;
  /** token 符号 */
  token0Symbol: string;
  token1Symbol: string;
  /** 参与统计的 LP 数量 */
  positionCount: number;
  /** 采样时间 ISO */
  sampledAt: string;
}

// ==================== 读取链上数据 ====================

/**
 * 受控并发地映射数组。viem 的 multicall 批处理会把同一批次多个 readContract 合并成
 * 一个 eth_call；若对上百个 tokenId 一次性 Promise.all，会产生一个超大 payload 的
 * multicall，超出节点 gas/size 上限 → 挂起或报错 → API 502/空响应。
 * 这里限制同时进行的 RPC 读数量，避免触发巨型 multicall。
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const i = cursor++;
      results[i] = await fn(items[i], i);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/** 读取 pool 的 slot0（sqrtPriceX96 + tick）和当前流动性 L。 */
async function readPoolState(client: PublicClient, pool: `0x${string}`) {
  const [slot0, liquidity] = await Promise.all([
    client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "liquidity" }),
  ]);
  const slot0Arr = slot0 as unknown as any[];
  return {
    sqrtPriceX96: slot0Arr[0] as bigint,
    currentTick: Number(slot0Arr[1]),
    liquidity: liquidity as bigint,
  };
}

/** 读取 pool 的 fee / tickSpacing / token0 / token1。 */
async function readPoolInfo(client: PublicClient, pool: `0x${string}`) {
  const [fee, tickSpacing, token0, token1] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "fee" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "tickSpacing" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "token0" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "token1" }),
  ]);
  return {
    fee: Number(fee),
    tickSpacing: Number(tickSpacing),
    token0: token0 as `0x${string}`,
    token1: token1 as `0x${string}`,
  };
}

/**
 * 枚举 owner（vault 或钱包）在 NPM 上持有的全部 LP NFT tokenId。
 * 用 balanceOf + tokenOfOwnerByIndex，比扫 Transfer 事件快且完整。
 */
async function enumerateOwnedTokenIds(
  client: PublicClient,
  npm: `0x${string}`,
  owner: `0x${string}`,
  maxCount = 500
): Promise<bigint[]> {
  const count = Number(
    (await client.readContract({ address: npm, abi: V3_NPM_ABI, functionName: "balanceOf", args: [owner] })) as bigint
  );
  if (count === 0) return [];
  const limit = Math.min(count, maxCount);
  const ids: bigint[] = [];
  // 并发读取 tokenOfOwnerByIndex（分批，避免单次 RPC 太多请求）
  const BATCH = 20;
  for (let i = 0; i < limit; i += BATCH) {
    const batch = Array.from({ length: Math.min(BATCH, limit - i) }, async (_, j) => {
      const idx = i + j;
      try {
        const id = (await client.readContract({
          address: npm,
          abi: V3_NPM_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [owner, BigInt(idx)],
        })) as bigint;
        return id;
      } catch {
        return null;
      }
    });
    const results = await Promise.all(batch);
    for (const r of results) if (r !== null) ids.push(r);
  }
  return ids;
}

// ==================== 场景 A：直接持有 ====================

/**
 * 场景A：算全池在你区间的流动性 + 你的占比。
 *
 * 全池流动性用 Pool.liquidity()（当前价格的活跃净流动性，1 次 eth_call），
 * 然后用 getAmountsForLiquidity 把它换算成你区间内的 token0/token1。
 *
 * @param decimals0/decimals1  token 的精度
 * @param myLiquidity          你自己的 liquidity（从 positions.tokenId 读到）
 */
export async function analyzeDirect(
  client: PublicClient,
  pool: `0x${string}`,
  decimals0: number,
  decimals1: number,
  myLiquidity: bigint,
  tickLower: number,
  tickUpper: number,
  symbol0: string,
  symbol1: string
): Promise<LiquidityResult> {
  const { sqrtPriceX96, currentTick, liquidity: poolLiquidity } = await readPoolState(client, pool);
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);

  const total = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, poolLiquidity, decimals0, decimals1);
  const mine = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, myLiquidity, decimals0, decimals1);
  const share = poolLiquidity > 0n ? Number((myLiquidity * 10000n) / poolLiquidity) / 10000 : 0;

  return {
    total,
    mine,
    share,
    priceLow: tickToPriceDisplay(tickLower, decimals0, decimals1),
    priceHigh: tickToPriceDisplay(tickUpper, decimals0, decimals1),
    priceLabel: `${symbol0}/${symbol1}`,
    currentTick,
    tickLower,
    tickUpper,
    token0Symbol: symbol0,
    token1Symbol: symbol1,
    positionCount: 1,
    sampledAt: new Date().toISOString(),
  };
}

// ==================== 场景 B：已质押 ====================

/**
 * 场景B：枚举 vault 在 NPM 上持有的全部 LP，筛同池子（token0+token1+fee）且 tick 区间覆盖
 * 目标窗口的 LP，累加流动性。
 *
 * 策略（已验证可行）：
 *   1. vault 合约持有 LP NFT（NFT 的 owner 是 vault）
 *   2. NPM.balanceOf(vault) + NPM.tokenOfOwnerByIndex(vault, i) 枚举全部 tokenId
 *   3. 逐个 NPM.positions(tokenId) 取 token0/token1/fee/liquidity/tick
 *   4. 筛同池子（positions 返回的 token0/token1 已排序，同池子必然一致）
 *   5. 再筛 tick 区间覆盖目标窗口 [tickLower, tickUpper] 的（L 是针对各自区间定义的，
 *      跨区间不可相加——见下文累加处注释）
 *   6. 累加 liquidity，用 getAmountsForLiquidity 换算 token0/token1
 *
 * @param npm            NFT Position Manager 地址
 * @param vault          质押合约（vault）地址，作为 NFT 的 owner
 * @param pool           目标池子地址
 * @param decimals0/1    token 精度
 * @param tickLower/Upper 目标 tick 窗口（用于覆盖判定）
 * @param myLiquidity    你自己的流动性（用于算占比，可为 0n）
 */
export async function analyzeStaked(
  client: PublicClient,
  npm: `0x${string}`,
  vault: `0x${string}`,
  pool: `0x${string}`,
  decimals0: number,
  decimals1: number,
  tickLower: number,
  tickUpper: number,
  symbol0: string,
  symbol1: string,
  myLiquidity: bigint = 0n
): Promise<LiquidityResult> {
  const { sqrtPriceX96, currentTick } = await readPoolState(client, pool);
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);

  // 枚举 vault 持有的全部 LP NFT
  const tokenIds = await enumerateOwnedTokenIds(client, npm, vault);

  // 读 pool 的 token0/token1/fee，用于判定同池子
  const poolInfo = await readPoolInfo(client, pool);
  const poolKey = `${poolInfo.token0.toLowerCase()}-${poolInfo.token1.toLowerCase()}-${poolInfo.fee}`;

  // 逐个读 positions，筛同池子 + tick 区间覆盖目标窗口，再累加 liquidity。
  // 注意1：不能 Promise.all 全部并发——viem multicall 会把它们合并成一个巨型 eth_call
  //        超出节点上限而挂起。用 mapWithConcurrency 控制同时进行的 RPC 数。
  // 注意2：必须同时按 tick 区间过滤。LP 的 liquidity L 是针对「其自身的 tick 区间」定义的，
  //        不同区间的 L 不可直接相加。例如同一池子里 tick 相距甚远的宽区间 LP，其 L 可能
  //        高达 1e33，但它在你目标窗口内的活跃流动性近乎 0；若不过滤就会把这种巨型 L
  //        累加进来，导致 total 被 ~1e14 放大、share 归零（精度完全失真）。
  //        正确语义：只累加 tick 区间「覆盖目标窗口」的 LP（与 POOL.liquidity() 语义一致，
  //        即活跃流动性贯穿你所在区间），与场景C probeMinRange 的判定保持统一。
  let aggregatedLiquidity = 0n;
  let matchedCount = 0;
  await mapWithConcurrency(tokenIds, 8, async (tokenId) => {
    const meta = await readPositionMeta(client, npm, tokenId);
    if (!meta || meta.liquidity === 0n) return;
    const lpPoolKey = `${meta.token0.toLowerCase()}-${meta.token1.toLowerCase()}-${meta.fee}`;
    if (lpPoolKey !== poolKey) return;
    // tick 区间必须完整覆盖目标窗口 [tickLower, tickUpper]，L 才在窗口内有效
    if (meta.tickLower > tickLower || meta.tickUpper < tickUpper) return;
    aggregatedLiquidity += meta.liquidity;
    matchedCount++;
  });

  const total = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, aggregatedLiquidity, decimals0, decimals1);
  const mine = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, myLiquidity, decimals0, decimals1);
  const share = aggregatedLiquidity > 0n ? Number((myLiquidity * 10000n) / aggregatedLiquidity) / 10000 : 0;

  return {
    total,
    mine,
    share,
    priceLow: tickToPriceDisplay(tickLower, decimals0, decimals1),
    priceHigh: tickToPriceDisplay(tickUpper, decimals0, decimals1),
    priceLabel: `${symbol0}/${symbol1}`,
    currentTick,
    tickLower,
    tickUpper,
    token0Symbol: symbol0,
    token1Symbol: symbol1,
    positionCount: matchedCount,
    sampledAt: new Date().toISOString(),
  };
}

// ==================== 场景 C：最小区间探针 ====================

export interface MinRangeProbeResult {
  /** tickSpacing（fee 决定的最小粒度） */
  tickSpacing: number;
  /** 最小区间的 [tickLower, tickUpper] */
  tickLower: number;
  tickUpper: number;
  /** 当前 tick */
  currentTick: number;
  /** 该最小窗口内的流动性（token0/token1） */
  liquidity: LiquidityBreakdown;
  /** 价格区间 [low, high] */
  priceLow: string;
  priceHigh: string;
  priceLabel: string;
  fee: number;
  token0Symbol: string;
  token1Symbol: string;
  sampledAt: string;
}

/**
 * 场景C：给定池子地址，算 fee 对应 tickSpacing 的最小窗口流动性 + 价格区间。
 *
 * 最小区间 = [当前 tick 向下取整到 tickSpacing 的倍数, +tickSpacing]
 * 用 Pool.liquidity()（当前价格净流动性）作为该窗口的流动性近似。
 *
 * @param stakerAddr 可选。若提供，则额外用 vault 枚举统计该窗口内同池子 LP 的总流动性；
 *                   否则只用 Pool.liquidity()。
 */
export async function probeMinRange(
  client: PublicClient,
  pool: `0x${string}`,
  decimals0: number,
  decimals1: number,
  symbol0: string,
  symbol1: string,
  npm?: `0x${string}`,
  stakerAddr?: `0x${string}`
): Promise<MinRangeProbeResult> {
  const { sqrtPriceX96, currentTick, liquidity: poolLiquidity } = await readPoolState(client, pool);
  const info = await readPoolInfo(client, pool);
  const tickSpacing = info.tickSpacing || FEE_TO_TICK_SPACING[info.fee] || 1;

  // 最小区间：当前 tick 向下取整到 tickSpacing 倍数，宽 tickSpacing
  const tickLower = Math.floor(currentTick / tickSpacing) * tickSpacing;
  const tickUpper = tickLower + tickSpacing;
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);

  let effectiveLiquidity = poolLiquidity;
  if (npm && stakerAddr) {
    // vault 场景：枚举并统计该窗口内同池子 LP 流动性
    const tokenIds = await enumerateOwnedTokenIds(client, npm, stakerAddr);
    const poolKey = `${info.token0.toLowerCase()}-${info.token1.toLowerCase()}-${info.fee}`;
    let agg = 0n;
    await mapWithConcurrency(tokenIds, 8, async (tokenId) => {
      const meta = await readPositionMeta(client, npm, tokenId);
      if (!meta || meta.liquidity === 0n) return;
      const lpPoolKey = `${meta.token0.toLowerCase()}-${meta.token1.toLowerCase()}-${meta.fee}`;
      if (lpPoolKey !== poolKey) return;
      // 只统计落在该最小窗口内的（tick 范围被当前最小窗口完全包含）
      if (meta.tickLower <= tickLower && meta.tickUpper >= tickUpper) {
        agg += meta.liquidity;
      }
    });
    if (agg > 0n) effectiveLiquidity = agg;
  }

  const liquidity = getAmountsForLiquidity(sqrtPriceX96, sqrtA, sqrtB, effectiveLiquidity, decimals0, decimals1);

  return {
    tickSpacing,
    tickLower,
    tickUpper,
    currentTick,
    liquidity,
    priceLow: tickToPriceDisplay(tickLower, decimals0, decimals1),
    priceHigh: tickToPriceDisplay(tickUpper, decimals0, decimals1),
    priceLabel: `${symbol0}/${symbol1}`,
    fee: info.fee,
    token0Symbol: symbol0,
    token1Symbol: symbol1,
    sampledAt: new Date().toISOString(),
  };
}
