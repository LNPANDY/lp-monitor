/**
 * V3-fork 适配器 —— 覆盖所有兼容 Uniswap V3 NonfungiblePositionManager 的 DEX：
 * Uniswap V3 / PancakeSwap V3 / QuickSwap V3 / Aerodrome Slipstream / Camelot V3 / BaseSwap 等。
 *
 * 区间判断原理：
 *   1. positions(tokenId) → token0, token1, fee, tickLower, tickUpper, liquidity, ...
 *   2. factory.getPool(token0, token1, fee) → pool 地址
 *   3. pool.slot0().tick → 当前 tick
 *   4. inRange = tickLower <= currentTick < tickUpper
 */
import type { PublicClient } from "viem";

export const V3_FACTORY_ABI = [
  {
    name: "getPool",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "tokenA", type: "address" },
      { name: "tokenB", type: "address" },
      { name: "fee", type: "uint24" },
    ],
    outputs: [{ name: "pool", type: "address" }],
  },
] as const;

export const V3_NPM_ABI = [
  {
    name: "positions",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "nonce", type: "uint96" },
      { name: "operator", type: "address" },
      { name: "token0", type: "address" },
      { name: "token1", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
      { name: "liquidity", type: "uint128" },
      { name: "feeGrowthInside0LastX128", type: "uint256" },
      { name: "feeGrowthInside1LastX128", type: "uint256" },
      { name: "tokensOwed0", type: "uint128" },
      { name: "tokensOwed1", type: "uint128" },
    ],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "balance", type: "uint256" }],
  },
  {
    name: "tokenOfOwnerByIndex",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "index", type: "uint256" },
    ],
    outputs: [{ name: "tokenId", type: "uint256" }],
  },
] as const;

export const V3_POOL_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

export const ERC721_TRANSFER_EVENT = {
  anonymous: false,
  name: "Transfer",
  type: "event",
  inputs: [
    { indexed: true, name: "from", type: "address" },
    { indexed: true, name: "to", type: "address" },
    { indexed: true, name: "tokenId", type: "uint256" },
  ],
} as const;

export interface V3PositionMeta {
  nonce: bigint;
  operator: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  fee: number;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}

export interface V3RangeStatus {
  inRange: boolean;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  pool: `0x${string}`;
  /** token1 / token0 的价格（每 1 token0 = ? token1），由当前 tick 推算 */
  price: string;
  /** 距离区间边界的相对距离：>0 在区间内，<0 越界，单位“比例” */
  marginLower: number; // (currentTick - tickLower) / tickSpacing-ish，归一为相对百分比
  marginUpper: number;
}

/** 读取一个 NFT 仓位的元数据（不包含当前 tick）。 */
export async function readPositionMeta(
  client: PublicClient,
  npm: `0x${string}`,
  tokenId: bigint
): Promise<V3PositionMeta | null> {
  try {
    const res = (await client.readContract({
      address: npm,
      abi: V3_NPM_ABI,
      functionName: "positions",
      args: [tokenId],
    })) as unknown as any[];
    return {
      nonce: res[0],
      operator: res[1],
      token0: res[2],
      token1: res[3],
      fee: Number(res[4]),
      tickLower: Number(res[5]),
      tickUpper: Number(res[6]),
      liquidity: res[7],
    };
  } catch {
    return null; // tokenId 不存在或已销毁
  }
}

/** 由 factory 派生 pool 地址。 */
export async function getPoolAddress(
  client: PublicClient,
  factory: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee: number
): Promise<`0x${string}`> {
  const pool = (await client.readContract({
    address: factory,
    abi: V3_FACTORY_ABI,
    functionName: "getPool",
    args: [token0, token1, fee],
  })) as `0x${string}`;
  return pool;
}

/** 读取 pool 当前 tick。pool 为 0 地址时返回 null。 */
export async function readPoolTick(
  client: PublicClient,
  pool: `0x${string}`
): Promise<number | null> {
  if (pool === "0x0000000000000000000000000000000000000000") return null;
  try {
    const slot0 = (await client.readContract({
      address: pool,
      abi: V3_POOL_ABI,
      functionName: "slot0",
    })) as unknown as any[];
    return Number(slot0[1]);
  } catch {
    return null;
  }
}

/**
 * 综合：给定 npm + tokenId，返回完整区间状态。
 * meta 可选传入以避免重复读取。
 */
export async function readRangeStatus(
  client: PublicClient,
  factory: `0x${string}`,
  npm: `0x${string}`,
  tokenId: bigint,
  meta?: V3PositionMeta
): Promise<{ meta: V3PositionMeta; status: V3RangeStatus } | null> {
  const m = meta ?? (await readPositionMeta(client, npm, tokenId));
  if (!m) return null;
  // liquidity=0 表示仓位已关闭（全部 withdrawn），跳过
  if (m.liquidity === 0n) return null;
  const pool = await getPoolAddress(client, factory, m.token0, m.token1, m.fee);
  const currentTick = await readPoolTick(client, pool);
  if (currentTick === null) return null;

  const inRange = currentTick >= m.tickLower && currentTick < m.tickUpper;
  const price = tickToPrice(currentTick);
  // 用 tick 跨度的相对距离粗略表示接近边界程度
  const span = Math.max(m.tickUpper - m.tickLower, 1);
  const marginLower = (currentTick - m.tickLower) / span;
  const marginUpper = (m.tickUpper - currentTick) / span;

  return {
    meta: m,
    status: { inRange, currentTick, tickLower: m.tickLower, tickUpper: m.tickUpper, pool, price, marginLower, marginUpper },
  };
}

/** tick → 价格 (token1/token0)。1.0001^tick，保留 8 位有效数字。 */
export function tickToPrice(tick: number): string {
  try {
    const p = Math.pow(1.0001, tick);
    if (!isFinite(p)) return "0";
    return p.toPrecision(8);
  } catch {
    return "0";
  }
}

/** 校验地址是否是 NFT 的当前 owner。 */
export async function ownerOf(
  client: PublicClient,
  npm: `0x${string}`,
  tokenId: bigint
): Promise<`0x${string}` | null> {
  try {
    return (await client.readContract({
      address: npm,
      abi: V3_NPM_ABI,
      functionName: "ownerOf",
      args: [tokenId],
    })) as `0x${string}`;
  } catch {
    return null;
  }
}
