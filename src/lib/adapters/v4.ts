/**
 * Uniswap v4 适配器。
 *
 * v4 架构与 v3 的差异：
 *   - 单例 PoolManager 管理所有池（无独立 pool 合约），poolId = keccak256(abi.encode(poolKey))
 *   - PositionManager（ERC721，无 Enumerable → 不能 tokenOfOwnerByIndex 枚举，
 *     直接持有仓位依赖 Transfer 事件扫描发现；ownerOf/balanceOf 标准可用）
 *   - 池状态经 StateView lens 合约读取（getSlot0(poolId)），地址跨链不同需在 dexes 表配置
 *   - PositionInfo uint256 位布局（v4-periphery PositionInfoLibrary）：
 *       [0-7] hasSubscriber | [8-31] tickLower | [32-55] tickUpper | [56-255] poolId 截断值(高200位)
 *   - poolKey = { currency0, currency1, fee, tickSpacing, hooks }；
 *     fee 可能是 0x800000 动态费标志（hook 管理），此时阈值计算回退 3000（0.3%）
 *   - currency0/currency1 可能为零地址（原生币），由 resolveTokens 特判展示
 *   - tick/价格语义与 v3 完全一致（1.0001^tick），复用 tickToPrice
 *
 * dexes 表字段映射：factory=PoolManager（未使用但保持唯一键），npm=PositionManager，stateview=StateView
 */
import type { PublicClient } from "viem";
import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import type { AdapterCtx, RangeReadResult, V3RangeStatus } from "./index";
import { tickToPrice } from "./v3-fork";

/** v4 PositionManager 读取相关 ABI */
const V4_PM_ABI = [
  {
    name: "getPoolAndPositionInfo",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      {
        name: "poolKey",
        type: "tuple",
        components: [
          { name: "currency0", type: "address" },
          { name: "currency1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickSpacing", type: "int24" },
          { name: "hooks", type: "address" },
        ],
      },
      { name: "info", type: "uint256" },
    ],
  },
  {
    name: "getPositionLiquidity",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "liquidity", type: "uint128" }],
  },
] as const;

const V4_STATEVIEW_ABI = [
  {
    name: "getSlot0",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

/** v4 动态费标志位：hook 管理费率时 poolKey.fee = 0x800000 */
const DYNAMIC_FEE_FLAG = 0x800000;
/** 动态费池的阈值兜底 fee（0.3% → 阈值 0.6%） */
const DYNAMIC_FEE_FALLBACK = 3000;

/** uint24 → int24 符号扩展（tick 是带符号的） */
function toInt24(v: bigint): number {
  const x = v & 0xffffffn;
  return x & 0x800000n ? Number(x) - 0x1000000 : Number(x);
}

/** poolKey → poolId（与 v4-core toId 一致：keccak256(abi.encode(poolKey))） */
function poolKeyToId(key: {
  currency0: string;
  currency1: string;
  fee: bigint | number;
  tickSpacing: bigint | number;
  hooks: string;
}): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      parseAbiParameters("address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks"),
      [
        key.currency0 as `0x${string}`,
        key.currency1 as `0x${string}`,
        Number(key.fee),
        Number(key.tickSpacing),
        key.hooks as `0x${string}`,
      ]
    )
  );
}

/**
 * v4 readRange 实现。
 * @param ctx.factory PoolManager 地址（本实现未直接调用，仅保持接口一致）
 * @param ctx.npm PositionManager 地址
 * @param ctx.stateview StateView lens 地址（必填，缺失返回 unreadable）
 */
export async function readRangeV4(
  client: PublicClient,
  ctx: AdapterCtx,
  tokenId: bigint
): Promise<RangeReadResult> {
  if (!ctx.npm) return { kind: "unreadable" };
  if (!ctx.stateview) {
    console.error(`[v4-adapter] stateview 地址未配置（dex ${ctx.npm}），无法读取池状态`);
    return { kind: "unreadable" };
  }

  try {
    // 1. 读 poolKey + PositionInfo + liquidity（两个 view 并行，类型由 as-const ABI 推断）
    const [pmRes, liqRes] = await Promise.all([
      client.readContract({
        address: ctx.npm as `0x${string}`,
        abi: V4_PM_ABI,
        functionName: "getPoolAndPositionInfo",
        args: [tokenId],
      }),
      client.readContract({
        address: ctx.npm as `0x${string}`,
        abi: V4_PM_ABI,
        functionName: "getPositionLiquidity",
        args: [tokenId],
      }),
    ]);

    const poolKey = (pmRes as readonly [any, bigint])[0] as {
      currency0: string;
      currency1: string;
      fee: number | bigint;
      tickSpacing: number | bigint;
      hooks: string;
    };
    const info = (pmRes as readonly [any, bigint])[1] as bigint;
    const liquidity = liqRes as bigint;

    // 2. 解码 PositionInfo 位布局：[0-7] hasSubscriber | [8-31] tickLower | [32-55] tickUpper
    const infoBig = BigInt(info);
    const tickLower = toInt24(infoBig >> 8n);
    const tickUpper = toInt24(infoBig >> 32n);

    // 3. liquidity=0 → 已平仓
    if (liquidity === 0n) return { kind: "closed" };

    // 4. poolId（链下 keccak256(abi.encode(poolKey))，与 toId 一致）→ StateView 读 tick
    const poolId = poolKeyToId({
      currency0: poolKey.currency0,
      currency1: poolKey.currency1,
      fee: poolKey.fee,
      tickSpacing: poolKey.tickSpacing,
      hooks: poolKey.hooks,
    });
    const slot0 = (await client.readContract({
      address: ctx.stateview as `0x${string}`,
      abi: V4_STATEVIEW_ABI,
      functionName: "getSlot0",
      args: [poolId],
    })) as readonly [bigint, number, number, number];
    const currentTick = Number(slot0[1]);
    if (!Number.isFinite(currentTick)) return { kind: "unreadable" };

    // 5. 判定与 v3 同口径的 status
    const inRange = currentTick >= tickLower && currentTick < tickUpper;
    const span = Math.max(tickUpper - tickLower, 1);
    const status: V3RangeStatus = {
      inRange,
      currentTick,
      tickLower,
      tickUpper,
      // v4 无独立 pool 合约，存 poolId（bytes32 hex）；positions.pool 列是 TEXT 可容纳
      pool: poolId,
      price: tickToPrice(currentTick),
      marginLower: (currentTick - tickLower) / span,
      marginUpper: (tickUpper - currentTick) / span,
    };

    // 6. fee：动态费标志 → 兜底 3000（阈值 0.6%），普通池直接用
    const rawFee = Number(poolKey.fee);
    const fee = (rawFee & DYNAMIC_FEE_FLAG) !== 0 ? DYNAMIC_FEE_FALLBACK : rawFee;

    return {
      kind: "ok",
      status,
      token0: poolKey.currency0,
      token1: poolKey.currency1,
      fee,
      tickLower,
      tickUpper,
      liquidity,
    };
  } catch (e: any) {
    // tokenId 不存在（NFT 已销毁）或 RPC 异常 → unreadable（保留旧状态不误标 closed）
    console.warn(`[v4-adapter] readRange tokenId=${tokenId} failed: ${e?.message ?? e}`);
    return { kind: "unreadable" };
  }
}

export const v4Adapter = {
  type: "v4",
  readRange: readRangeV4,
};
