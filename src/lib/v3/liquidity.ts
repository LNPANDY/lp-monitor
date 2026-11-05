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
  sqrtPriceX96ToHumanPrice,
  FEE_TO_TICK_SPACING,
} from "./math";

import { resolveTokens } from "../chains/tokens";

// Pool ABI 补充：liquidity()、tickSpacing()、fee()、token0()、token1()、factory()
const POOL_EXTRA_ABI = [
  { name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128" }] },
  { name: "tickSpacing", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "int24" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
] as const;

export interface PoolStaticMeta {
  fee: number;
  tickSpacing: number;
  token0: `0x${string}`;
  token1: `0x${string}`;
  factory: string;
  decimals0: number;
  decimals1: number;
  symbol0: string;
  symbol1: string;
}

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
export async function readPoolState(client: PublicClient, pool: `0x${string}`) {
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

/** HMR 安全的全局池子静态元数据缓存（fee / tickSpacing / token0 / token1 / factory / decimals / symbol 永不改变） */
function getPoolStaticCache(): Map<string, PoolStaticMeta> {
  const g = globalThis as any;
  if (!g.__lpMonitorPoolStaticCache__) {
    g.__lpMonitorPoolStaticCache__ = new Map<string, PoolStaticMeta>();
  }
  return g.__lpMonitorPoolStaticCache__;
}

const poolInfoCache = new Map<
  string,
  { fee: number; tickSpacing: number; token0: `0x${string}`; token1: `0x${string}`; factory: string }
>();

/** NFT 静态池子与区间缓存（token0 / token1 / fee / tickLower / tickUpper 铸造后永不改变） */
const nftStaticCache = new Map<
  string,
  { poolKey: string; tickLower: number; tickUpper: number }
>();

/** 已平仓（liquidity === 0）NFT 集合缓存，避免重复链上读取 */
const closedNftSet = new Set<string>();

/** Vault 持有 tokenId 列表短期缓存（15 秒 TTL，避免连续切换探针时重复枚举） */
const ownedTokenIdsCache = new Map<string, { ts: number; ids: bigint[] }>();

/** 读取 pool 的 fee / tickSpacing / token0 / token1 / factory（带永久内存缓存）。 */
async function readPoolInfo(client: PublicClient, pool: `0x${string}`) {
  const k = pool.toLowerCase();
  const cached = poolInfoCache.get(k);
  if (cached) return cached;
  const [fee, tickSpacing, token0, token1, factory] = await Promise.all([
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "fee" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "tickSpacing" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "token0" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "token1" }),
    client.readContract({ address: pool, abi: POOL_EXTRA_ABI, functionName: "factory" }).catch(() => ""),
  ]);
  const info = {
    fee: Number(fee),
    tickSpacing: Number(tickSpacing) || FEE_TO_TICK_SPACING[Number(fee)] || 1,
    token0: (token0 as string).toLowerCase() as `0x${string}`,
    token1: (token1 as string).toLowerCase() as `0x${string}`,
    factory: String(factory || "").toLowerCase(),
  };
  poolInfoCache.set(k, info);
  return info;
}

/**
 * 获取池子完整静态元数据（含 token0/token1 的 symbol 与 decimals），进程级永久缓存。
 * 命中缓存后 0 RPC 调用！
 */
export async function getPoolStaticMeta(
  client: PublicClient,
  chainId: number,
  pool: `0x${string}`
): Promise<PoolStaticMeta> {
  const key = `${chainId}:${pool.toLowerCase()}`;
  const cache = getPoolStaticCache();
  const hit = cache.get(key);
  if (hit) return hit;

  const info = await readPoolInfo(client, pool);
  const tokenMap = await resolveTokens(client, chainId, [info.token0, info.token1]);
  const m0 = tokenMap.get(info.token0.toLowerCase());
  const m1 = tokenMap.get(info.token1.toLowerCase());
  const meta: PoolStaticMeta = {
    ...info,
    decimals0: m0?.decimals ?? 18,
    decimals1: m1?.decimals ?? 18,
    symbol0: m0?.symbol || info.token0.slice(0, 8),
    symbol1: m1?.symbol || info.token1.slice(0, 8),
  };
  cache.set(key, meta);
  return meta;
}

/**
 * 枚举 owner（vault 或钱包）在 NPM 上持有的全部 LP NFT tokenId。
 * 用 balanceOf + tokenOfOwnerByIndex，带 15 秒短期缓存。
 */
async function enumerateOwnedTokenIds(
  client: PublicClient,
  npm: `0x${string}`,
  owner: `0x${string}`,
  maxCount = 500
): Promise<bigint[]> {
  const cacheKey = `${npm.toLowerCase()}:${owner.toLowerCase()}`;
  const cached = ownedTokenIdsCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < 15_000) {
    return cached.ids;
  }
  const count = Number(
    (await client.readContract({ address: npm, abi: V3_NPM_ABI, functionName: "balanceOf", args: [owner] })) as bigint
  );
  if (count === 0) return [];
  const limit = Math.min(count, maxCount);
  const ids: bigint[] = [];
  const BATCH = 25;
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
  ownedTokenIdsCache.set(cacheKey, { ts: Date.now(), ids });
  return ids;
}

/**
 * 带静态池子/区间前置过滤的 positions(tokenId) 读取：
 * 若已知该 NFT 属于其它池子、或 tick 区间不覆盖目标窗口、或已平仓，直接 0 RPC 跳过！
 */
async function readMatchingPositionLiquidity(
  client: PublicClient,
  npm: `0x${string}`,
  tokenId: bigint,
  targetPoolKey: string,
  targetTickLower: number,
  targetTickUpper: number
): Promise<bigint | null> {
  const nftKey = `${npm.toLowerCase()}:${tokenId.toString()}`;
  if (closedNftSet.has(nftKey)) return null;

  const staticMeta = nftStaticCache.get(nftKey);
  if (staticMeta) {
    if (staticMeta.poolKey !== targetPoolKey) return null;
    if (staticMeta.tickLower > targetTickLower || staticMeta.tickUpper < targetTickUpper) {
      return null;
    }
  }

  const meta = await readPositionMeta(client, npm, tokenId);
  if (!meta) return null;

  const lpPoolKey = `${meta.token0.toLowerCase()}-${meta.token1.toLowerCase()}-${meta.fee}`;
  nftStaticCache.set(nftKey, {
    poolKey: lpPoolKey,
    tickLower: meta.tickLower,
    tickUpper: meta.tickUpper,
  });

  if (meta.liquidity === 0n) {
    closedNftSet.add(nftKey);
    return null;
  }
  if (lpPoolKey !== targetPoolKey) return null;
  if (meta.tickLower > targetTickLower || meta.tickUpper < targetTickUpper) return null;
  return meta.liquidity;
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
    const liq = await readMatchingPositionLiquidity(
      client,
      npm,
      tokenId,
      poolKey,
      tickLower,
      tickUpper
    );
    if (!liq || liq === 0n) return;
    aggregatedLiquidity += liq;
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
  /** 当前 sqrtPriceX96 字符串（供建仓面板直接复用） */
  sqrtPriceX96?: string;
  /** 原始活跃流动性字符串（供建仓面板直接复用） */
  rawLiquidity?: string;
  /** 该最小窗口内的流动性（token0/token1） */
  liquidity: LiquidityBreakdown;
  /** 价格区间 [low, high] */
  priceLow: string;
  priceHigh: string;
  /** 当前 tick 对应价格（1 token0 = ? token1，与 priceLow/priceHigh 同口径） */
  priceCurrent: string;
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
 * 直接使用 V3 Pool.liquidity()（当前 tick 活跃净流动性，含直持与质押在 Vault 中的所有 LP，仅需 1 次 RPC）。
 */
export async function probeMinRange(
  client: PublicClient,
  pool: `0x${string}`,
  decimals0: number,
  decimals1: number,
  symbol0: string,
  symbol1: string,
  _npm?: `0x${string}`,
  _stakerAddr?: `0x${string}`
): Promise<MinRangeProbeResult> {
  const [{ sqrtPriceX96, currentTick, liquidity: poolLiquidity }, info] = await Promise.all([
    readPoolState(client, pool),
    readPoolInfo(client, pool),
  ]);
  const tickSpacing = info.tickSpacing || FEE_TO_TICK_SPACING[info.fee] || 1;

  // 最小区间：当前 tick 向下取整到 tickSpacing 倍数，宽 tickSpacing
  const tickLower = Math.floor(currentTick / tickSpacing) * tickSpacing;
  const tickUpper = tickLower + tickSpacing;
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);

  const liquidity = getAmountsForLiquidity(
    sqrtPriceX96,
    sqrtA,
    sqrtB,
    poolLiquidity,
    decimals0,
    decimals1
  );

  return {
    tickSpacing,
    tickLower,
    tickUpper,
    currentTick,
    sqrtPriceX96: sqrtPriceX96.toString(),
    rawLiquidity: poolLiquidity.toString(),
    liquidity,
    priceLow: tickToPriceDisplay(tickLower, decimals0, decimals1),
    priceHigh: tickToPriceDisplay(tickUpper, decimals0, decimals1),
    priceCurrent: sqrtPriceX96ToHumanPrice(sqrtPriceX96, decimals0, decimals1),
    priceLabel: `${symbol0}/${symbol1}`,
    fee: info.fee,
    token0Symbol: symbol0,
    token1Symbol: symbol1,
    sampledAt: new Date().toISOString(),
  };
}

