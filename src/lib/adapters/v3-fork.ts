/**
 * V3-fork 适配器 —— 覆盖所有兼容 Uniswap V3 NonfungiblePositionManager 的 DEX：
 * Uniswap V3 / PancakeSwap V3 / QuickSwap V3 / Aerodrome Slipstream / Camelot V3 / ZIA 等。
 *
 * 性能优化：
 *   1. Pool 地址内存永久缓存（(factory, token0, token1, fee) -> pool 链上不可变），彻底省去重复 factory.getPool RPC
 *   2. 支持传入已批量读取的 knownPool / knownTick，将单仓位状态检查从 3 次串行 RPC 压缩为仅 1 次 positions(tokenId)
 *   3. 提供 batchReadPoolTicks 对同链所有活跃池一次性去重并发读取 slot0()
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
  marginLower: number;
  marginUpper: number;
}

const ZERO_POOL = "0x0000000000000000000000000000000000000000";

/** 不可变 Pool 地址缓存：`${factory}:${token0}:${token1}:${fee}` -> poolAddr */
const poolAddressCache = new Map<string, `0x${string}`>();

function makePoolCacheKey(
  factory: string,
  token0: string,
  token1: string,
  fee: number
): string {
  const a = token0.toLowerCase();
  const b = token1.toLowerCase();
  const [t0, t1] = a < b ? [a, b] : [b, a];
  return `${factory.toLowerCase()}:${t0}:${t1}:${fee}`;
}

/** 用已知的 DB 记录预热 Pool 地址缓存，避免发起 factory.getPool 请求 */
export function primePoolAddressCache(
  factory: string,
  token0: string,
  token1: string,
  fee: number,
  pool: string
): void {
  if (!factory || !token0 || !token1 || !fee || !pool || pool === ZERO_POOL) return;
  poolAddressCache.set(
    makePoolCacheKey(factory, token0, token1, fee),
    pool as `0x${string}`
  );
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
    return null;
  }
}

/** 由 factory 派生 pool 地址（带永久内存缓存）。 */
export async function getPoolAddress(
  client: PublicClient,
  factory: `0x${string}`,
  token0: `0x${string}`,
  token1: `0x${string}`,
  fee: number
): Promise<`0x${string}`> {
  const key = makePoolCacheKey(factory, token0, token1, fee);
  const cached = poolAddressCache.get(key);
  if (cached) return cached;

  const pool = (await client.readContract({
    address: factory,
    abi: V3_FACTORY_ABI,
    functionName: "getPool",
    args: [token0, token1, fee],
  })) as `0x${string}`;
  if (pool && pool !== ZERO_POOL) {
    poolAddressCache.set(key, pool);
  }
  return pool;
}

/** 读取 pool 当前 tick。pool 为 0 地址时返回 null。 */
export async function readPoolTick(
  client: PublicClient,
  pool: `0x${string}`
): Promise<number | null> {
  if (!pool || pool === ZERO_POOL) return null;
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
 * 批量去重并发读取多个 Pool 的当前 tick（slot0）。
 * 同一条链上有 10 个仓位属于 3 个池子时，只需读 3 次 slot0。
 */
export async function batchReadPoolTicks(
  client: PublicClient,
  pools: string[],
  concurrency = 8
): Promise<Map<string, number>> {
  const uniquePools = Array.from(
    new Set(
      pools
        .map((p) => (p || "").trim().toLowerCase())
        .filter((p) => /^0x[a-f0-9]{40}$/.test(p) && p !== ZERO_POOL)
    )
  );
  const out = new Map<string, number>();
  if (uniquePools.length === 0) return out;

  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, uniquePools.length) },
    async () => {
      while (cursor < uniquePools.length) {
        const poolAddr = uniquePools[cursor++];
        const tick = await readPoolTick(client, poolAddr as `0x${string}`);
        if (tick !== null) {
          out.set(poolAddr, tick);
        }
      }
    }
  );
  await Promise.all(workers);
  return out;
}

export interface ReadRangeOptions {
  meta?: V3PositionMeta;
  knownPool?: `0x${string}`;
  knownTick?: number;
}

/**
 * 综合：给定 npm + tokenId，返回完整区间状态。
 * 支持传入已知的 pool 地址与已批量读取的 currentTick，省去重复 getPool 和 slot0 请求。
 */
export async function readRangeStatus(
  client: PublicClient,
  factory: `0x${string}`,
  npm: `0x${string}`,
  tokenId: bigint,
  metaOrOpts?: V3PositionMeta | ReadRangeOptions
): Promise<
  | { kind: "closed" }
  | { kind: "unreadable" }
  | { kind: "ok"; meta: V3PositionMeta; status: V3RangeStatus }
> {
  const isOpts =
    metaOrOpts &&
    ("meta" in metaOrOpts || "knownPool" in metaOrOpts || "knownTick" in metaOrOpts);
  const opts: ReadRangeOptions = isOpts
    ? (metaOrOpts as ReadRangeOptions)
    : { meta: metaOrOpts as V3PositionMeta | undefined };

  const m = opts.meta ?? (await readPositionMeta(client, npm, tokenId));
  if (!m) return { kind: "unreadable" };
  if (m.liquidity === 0n) return { kind: "closed" };

  let pool: `0x${string}`;
  if (opts.knownPool && opts.knownPool !== ZERO_POOL) {
    pool = opts.knownPool;
    primePoolAddressCache(factory, m.token0, m.token1, m.fee, pool);
  } else {
    pool = await getPoolAddress(client, factory, m.token0, m.token1, m.fee);
  }

  const currentTick =
    opts.knownTick !== undefined
      ? opts.knownTick
      : await readPoolTick(client, pool);
  if (currentTick === null) return { kind: "unreadable" };

  const inRange = currentTick >= m.tickLower && currentTick < m.tickUpper;
  const price = tickToPrice(currentTick);
  const span = Math.max(m.tickUpper - m.tickLower, 1);
  const marginLower = (currentTick - m.tickLower) / span;
  const marginUpper = (m.tickUpper - currentTick) / span;

  return {
    kind: "ok",
    meta: m,
    status: {
      inRange,
      currentTick,
      tickLower: m.tickLower,
      tickUpper: m.tickUpper,
      pool,
      price,
      marginLower,
      marginUpper,
    },
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
