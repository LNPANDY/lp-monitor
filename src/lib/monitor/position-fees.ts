/**
 * 实时链上手续费 & 真实收益测算引擎（支持 Uniswap V4 + Uniswap V3/v3-fork）
 *
 * 为主面板每个活跃仓位提供：
 *   1. 精确链上未领取手续费（fees0 / fees1，0 Gas 静态读取）：
 *      - V4：StateView.getFeeGrowthInside + StateView.getPositionInfo(poolId, npm, tickLower, tickUpper, bytes32(tokenId))
 *      - V3：NPM.positions + pool.feeGrowthGlobal0/1X128 + pool.ticks(tickLower/tickUpper)
 *   2. 本仓占池子当前活跃流动性比例（activeLShare = posLiq / poolActiveLiq）与集中倍数估算
 *   3. 池子实时 24h 成交量（DexScreener 5 分钟缓存）→ 基于本仓精准 activeLShare 推算理论日产 & 理论手续费 APR
 *   4. 基于建仓/上次领取时间（自动从 positions.created_at 初始化并持久化在 app_settings，支持手续费归零自动重置与手动重置）
 *      推算已实现真实手续费速度（$/时、$/天、已实现真实 APR）
 */
import {
  encodeAbiParameters,
  formatUnits,
  keccak256,
  pad,
  parseAbi,
  parseAbiParameters,
  toHex,
  type Address,
  type PublicClient,
} from "viem";
import { getDb } from "../db";
import { getClient } from "../chains";
import { resolveTokens } from "../chains/tokens";
import { getSetting, setSetting } from "../db/settings";

const Q128 = 1n << 128n;
const MASK256 = (1n << 256n) - 1n;

const V4_PM_ABI = parseAbi([
  "function getPoolAndPositionInfo(uint256) view returns ((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks), uint256)",
]);

const V4_STATEVIEW_ABI = parseAbi([
  "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32) view returns (uint128)",
  "function getFeeGrowthInside(bytes32, int24, int24) view returns (uint256 feeGrowthInside0X128, uint256 feeGrowthInside1X128)",
  "function getPositionInfo(bytes32, address, int24, int24, bytes32) view returns (uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128)",
]);

const V3_NPM_ABI = parseAbi([
  "function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56, uint160, uint32, bool)",
]);

const DEXSCREENER_CHAIN_MAP: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  137: "polygon",
  143: "monad",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  130: "unichain",
};

export interface PositionFeeMetrics {
  positionId: number;
  dexType: string;
  poolIdOrAddr: string;
  feeRate: number;            // 0.0005 = 0.05%
  inRange: boolean;
  /** 精确未领取手续费（整币数量） */
  fees0: number;
  fees1: number;
  fees0Raw: string;
  fees1Raw: string;
  /** 本仓流动性占当前活跃池比例（0~1，越界时为 0） */
  activeLShare: number;
  poolActiveLiquidity: string;
  positionLiquidity: string;
  /** 池子实时成交量（来自 DexScreener，5分钟缓存） */
  poolVolume24hUsd: number | null;
  poolVolume6hUsd: number | null;
  poolTvlUsd: number | null;
  /** 按本仓 activeLShare × 池子 24h 成交量 × 费率 推算的理论手续费日产（USD） */
  estDailyFeeUsd: number | null;
  estHourlyFeeUsd: number | null;
  /** 按近 6h 成交量年化推算的短期理论日产（USD，更能反映当下行情活跃度） */
  estDailyFee6hUsd: number | null;
  /** 已实现手续费计息起点（毫秒时间戳，UTC） */
  feeSinceMs: number;
  /** 已运行小时数 */
  elapsedHours: number;
  updatedAt: string;
  error?: string;
}

interface PoolVolumeCacheEntry {
  fetchedAt: number;
  volume24hUsd: number | null;
  volume6hUsd: number | null;
  tvlUsd: number | null;
}

interface FeeCacheGlobal {
  map: Record<number, PositionFeeMetrics>;
  fetchedAt: number;
  volCache: Record<string, PoolVolumeCacheEntry>;
}

const GLOBAL_FEE_KEY = "__lpMonitorPositionFees__";
const FEE_CACHE_TTL_MS = 45_000;
const VOL_CACHE_TTL_MS = 5 * 60_000;

function getCache(): FeeCacheGlobal {
  const g = globalThis as any;
  if (!g[GLOBAL_FEE_KEY]) {
    g[GLOBAL_FEE_KEY] = { map: {}, fetchedAt: 0, volCache: {} } as FeeCacheGlobal;
  }
  return g[GLOBAL_FEE_KEY] as FeeCacheGlobal;
}

function parseSqliteUtcMs(s?: string | null): number {
  if (!s) return Date.now();
  const normalized = s.includes("T") ? s : s.replace(" ", "T") + "Z";
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : Date.now();
}

function feeBaselineKey(positionId: number): string {
  return `pos_fee_baseline_${positionId}`;
}

interface FeeBaseline {
  sinceMs: number;
  lastFees0Raw: string;
  lastFees1Raw: string;
}

function loadFeeBaseline(positionId: number): FeeBaseline | null {
  const raw = getSetting(feeBaselineKey(positionId), "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.sinceMs === "number") return parsed as FeeBaseline;
  } catch {}
  return null;
}

function saveFeeBaseline(positionId: number, b: FeeBaseline): void {
  setSetting(feeBaselineKey(positionId), JSON.stringify(b));
}

/** 手动重置某仓位的已实现手续费计息起点（领取手续费后可一键清零重新计时）。 */
export function resetPositionFeeSince(positionId: number, sinceMs = Date.now()): void {
  saveFeeBaseline(positionId, { sinceMs, lastFees0Raw: "0", lastFees1Raw: "0" });
  const cache = getCache();
  cache.fetchedAt = 0; // 失效缓存以便下次立即重算
}

async function fetchDexScreenerVolume(chainId: number, poolAddr: string): Promise<PoolVolumeCacheEntry> {
  const cache = getCache();
  const key = `${chainId}:${poolAddr.toLowerCase()}`;
  const now = Date.now();
  const hit = cache.volCache[key];
  if (hit && now - hit.fetchedAt < VOL_CACHE_TTL_MS) return hit;

  const slug = DEXSCREENER_CHAIN_MAP[chainId];
  if (!slug || !poolAddr) {
    return { fetchedAt: now, volume24hUsd: null, volume6hUsd: null, tvlUsd: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const res = await fetch(
      `https://api.dexscreener.com/latest/dex/pairs/${slug}/${poolAddr}`,
      { signal: controller.signal, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const pair = j.pair ?? j.pairs?.[0];
    const entry: PoolVolumeCacheEntry = {
      fetchedAt: now,
      volume24hUsd: pair?.volume?.h24 != null ? Number(pair.volume.h24) : null,
      volume6hUsd: pair?.volume?.h6 != null ? Number(pair.volume.h6) : null,
      tvlUsd: pair?.liquidity?.usd != null ? Number(pair.liquidity.usd) : null,
    };
    cache.volCache[key] = entry;
    return entry;
  } catch {
    return hit ?? { fetchedAt: now, volume24hUsd: null, volume6hUsd: null, tvlUsd: null };
  } finally {
    clearTimeout(timer);
  }
}

function subMod256(a: bigint, b: bigint): bigint {
  return (a - b) & MASK256;
}

async function readV4Fees(
  client: PublicClient,
  npm: Address,
  stateview: Address,
  tokenId: bigint,
  tickLower: number,
  tickUpper: number,
  knownPoolId?: string
): Promise<{
  poolId: `0x${string}`;
  fees0Raw: bigint;
  fees1Raw: bigint;
  posLiq: bigint;
  poolActiveLiq: bigint;
  currentTick: number;
  lpFee: number;
}> {
  let poolId =
    knownPoolId && /^0x[0-9a-fA-F]{64}$/.test(knownPoolId)
      ? (knownPoolId as `0x${string}`)
      : null;

  if (!poolId) {
    const [poolKey] = await client.readContract({
      address: npm,
      abi: V4_PM_ABI,
      functionName: "getPoolAndPositionInfo",
      args: [tokenId],
    });
    poolId = keccak256(
      encodeAbiParameters(
        parseAbiParameters("address, address, uint24, int24, address"),
        [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks]
      )
    );
  }

  const salt = pad(toHex(tokenId), { size: 32 });
  const [slot0, poolActiveLiq, fgInside, posInfo] = await Promise.all([
    client.readContract({ address: stateview, abi: V4_STATEVIEW_ABI, functionName: "getSlot0", args: [poolId] }),
    client.readContract({ address: stateview, abi: V4_STATEVIEW_ABI, functionName: "getLiquidity", args: [poolId] }),
    client.readContract({
      address: stateview,
      abi: V4_STATEVIEW_ABI,
      functionName: "getFeeGrowthInside",
      args: [poolId, tickLower, tickUpper],
    }),
    client.readContract({
      address: stateview,
      abi: V4_STATEVIEW_ABI,
      functionName: "getPositionInfo",
      args: [poolId, npm, tickLower, tickUpper, salt],
    }),
  ]);

  const posLiq = posInfo[0];
  const d0 = subMod256(fgInside[0], posInfo[1]);
  const d1 = subMod256(fgInside[1], posInfo[2]);
  const fees0Raw = (d0 * posLiq) / Q128;
  const fees1Raw = (d1 * posLiq) / Q128;

  return {
    poolId,
    fees0Raw,
    fees1Raw,
    posLiq,
    poolActiveLiq,
    currentTick: Number(slot0[1]),
    lpFee: Number(slot0[3]),
  };
}

async function readV3Fees(
  client: PublicClient,
  npm: Address,
  poolAddr: Address,
  tokenId: bigint
): Promise<{
  fees0Raw: bigint;
  fees1Raw: bigint;
  posLiq: bigint;
  poolActiveLiq: bigint;
  currentTick: number;
}> {
  const [pos, slot0, poolActiveLiq, fg0, fg1] = await Promise.all([
    client.readContract({ address: npm, abi: V3_NPM_ABI, functionName: "positions", args: [tokenId] }),
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "slot0" }),
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "liquidity" }),
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
  ]);

  const tickLower = Number(pos[5]);
  const tickUpper = Number(pos[6]);
  const posLiq = pos[7];
  const fgLast0 = pos[8];
  const fgLast1 = pos[9];
  const owed0 = pos[10];
  const owed1 = pos[11];
  const currentTick = Number(slot0[1]);

  const [lowerInfo, upperInfo] = await Promise.all([
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "ticks", args: [tickLower] }),
    client.readContract({ address: poolAddr, abi: V3_POOL_ABI, functionName: "ticks", args: [tickUpper] }),
  ]);

  const lowerOut0 = lowerInfo[2];
  const lowerOut1 = lowerInfo[3];
  const upperOut0 = upperInfo[2];
  const upperOut1 = upperInfo[3];

  const below0 = currentTick >= tickLower ? lowerOut0 : subMod256(fg0, lowerOut0);
  const below1 = currentTick >= tickLower ? lowerOut1 : subMod256(fg1, lowerOut1);
  const above0 = currentTick < tickUpper ? upperOut0 : subMod256(fg0, upperOut0);
  const above1 = currentTick < tickUpper ? upperOut1 : subMod256(fg1, upperOut1);

  const inside0 = subMod256(subMod256(fg0, below0), above0);
  const inside1 = subMod256(subMod256(fg1, below1), above1);

  const fees0Raw = owed0 + (subMod256(inside0, fgLast0) * posLiq) / Q128;
  const fees1Raw = owed1 + (subMod256(inside1, fgLast1) * posLiq) / Q128;

  return { fees0Raw, fees1Raw, posLiq, poolActiveLiq, currentTick };
}

interface ActivePosRow {
  id: number;
  chain_id_ref: number;
  chain_id: number;
  token_id: string;
  token0: string;
  token1: string;
  pool: string;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  created_at: string;
  dex_type: string | null;
  dex_npm: string | null;
  dex_stateview: string | null;
  token0_decimals: number | null;
  token1_decimals: number | null;
}

/** 批量读取所有活跃仓位的精确未领手续费、活跃流动性占比和理论日产。 */
export async function fetchAllActivePositionFees(opts?: {
  force?: boolean;
}): Promise<Record<number, PositionFeeMetrics>> {
  const cache = getCache();
  const now = Date.now();
  if (!opts?.force && cache.fetchedAt > 0 && now - cache.fetchedAt < FEE_CACHE_TTL_MS) {
    return cache.map;
  }

  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id, p.chain_id_ref, c.chain_id, p.token_id, p.token0, p.token1, p.pool, p.fee,
              p.tick_lower, p.tick_upper, p.created_at,
              d.type AS dex_type, d.npm AS dex_npm, d.stateview AS dex_stateview,
              t0.decimals AS token0_decimals, t1.decimals AS token1_decimals
       FROM positions p
       JOIN chains c ON c.id = p.chain_id_ref
       LEFT JOIN dexes d ON d.id = p.dex_id
       LEFT JOIN tokens t0 ON t0.chain_id_ref = p.chain_id_ref AND LOWER(t0.address) = LOWER(p.token0)
       LEFT JOIN tokens t1 ON t1.chain_id_ref = p.chain_id_ref AND LOWER(t1.address) = LOWER(p.token1)
       WHERE p.notify_state != 'closed'`
    )
    .all() as ActivePosRow[];

  const out: Record<number, PositionFeeMetrics> = {};

  await Promise.all(
    rows.map(async (r) => {
      let dexType = r.dex_type || "v3-fork";
      let npm = r.dex_npm as Address | null;
      let stateview = r.dex_stateview as Address | null;
      const isV4PoolId = /^0x[0-9a-fA-F]{64}$/.test(r.pool || "");
      if ((!npm || !stateview) && isV4PoolId) {
        const v4Dex = db
          .prepare("SELECT type, npm, stateview FROM dexes WHERE chain_id_ref=? AND type='v4' ORDER BY enabled DESC LIMIT 1")
          .get(r.chain_id_ref) as { type: string; npm: string; stateview: string } | undefined;
        if (v4Dex) {
          dexType = v4Dex.type;
          npm = v4Dex.npm as Address;
          stateview = v4Dex.stateview as Address;
        }
      }
      const nowMs = Date.now();

      if (!npm || !/^0x[0-9a-fA-F]{40}$/.test(npm)) return;

      try {
        const { client } = getClient(r.chain_id_ref);
        let dec0 = r.token0_decimals;
        let dec1 = r.token1_decimals;
        if (dec0 == null || dec1 == null) {
          const meta = await resolveTokens(client, r.chain_id_ref, [r.token0, r.token1]);
          dec0 = dec0 ?? meta.get(r.token0.toLowerCase())?.decimals ?? 18;
          dec1 = dec1 ?? meta.get(r.token1.toLowerCase())?.decimals ?? 18;
        }
        let fees0Raw = 0n;
        let fees1Raw = 0n;
        let posLiq = 0n;
        let poolActiveLiq = 0n;
        let currentTick = 0;
        let poolIdOrAddr = r.pool || "";
        let effectiveFeePpm = Number(r.fee) || 0;

        if (dexType === "v4" || isV4PoolId) {
          const sv = stateview;
          if (!sv || !/^0x[0-9a-fA-F]{40}$/.test(sv)) return;
          const v4 = await readV4Fees(
            client,
            npm,
            sv,
            BigInt(r.token_id),
            r.tick_lower,
            r.tick_upper,
            r.pool
          );
          poolIdOrAddr = v4.poolId;
          fees0Raw = v4.fees0Raw;
          fees1Raw = v4.fees1Raw;
          posLiq = v4.posLiq;
          poolActiveLiq = v4.poolActiveLiq;
          currentTick = v4.currentTick;
          if (v4.lpFee > 0 && v4.lpFee < 0x800000) effectiveFeePpm = v4.lpFee;
        } else {
          if (!r.pool || !/^0x[0-9a-fA-F]{40}$/.test(r.pool)) return;
          const v3 = await readV3Fees(client, npm, r.pool as Address, BigInt(r.token_id));
          fees0Raw = v3.fees0Raw;
          fees1Raw = v3.fees1Raw;
          posLiq = v3.posLiq;
          poolActiveLiq = v3.poolActiveLiq;
          currentTick = v3.currentTick;
        }

        const inRange = currentTick >= r.tick_lower && currentTick < r.tick_upper;
        const activeLShare =
          inRange && poolActiveLiq > 0n ? Number(posLiq) / Number(poolActiveLiq) : 0;

        const fees0 = Number(formatUnits(fees0Raw, dec0));
        const fees1 = Number(formatUnits(fees1Raw, dec1));
        const feeRate = effectiveFeePpm > 0 && effectiveFeePpm < 0x800000 ? effectiveFeePpm / 1_000_000 : 0.0005;

        // 维护计息起点：首次用 positions.created_at，若检测到已领取手续费（两边明显回落）则自动重置
        let baseline = loadFeeBaseline(r.id);
        if (!baseline) {
          baseline = {
            sinceMs: parseSqliteUtcMs(r.created_at),
            lastFees0Raw: fees0Raw.toString(),
            lastFees1Raw: fees1Raw.toString(),
          };
          saveFeeBaseline(r.id, baseline);
        } else {
          const prev0 = BigInt(baseline.lastFees0Raw || "0");
          const prev1 = BigInt(baseline.lastFees1Raw || "0");
          const dropped0 = prev0 > 0n && fees0Raw * 5n < prev0;
          const dropped1 = prev1 > 0n && fees1Raw * 5n < prev1;
          if ((dropped0 && fees1Raw <= prev1) || (dropped1 && fees0Raw <= prev0)) {
            baseline = {
              sinceMs: nowMs,
              lastFees0Raw: fees0Raw.toString(),
              lastFees1Raw: fees1Raw.toString(),
            };
            saveFeeBaseline(r.id, baseline);
          } else if (fees0Raw !== prev0 || fees1Raw !== prev1) {
            baseline = {
              ...baseline,
              lastFees0Raw: fees0Raw.toString(),
              lastFees1Raw: fees1Raw.toString(),
            };
            saveFeeBaseline(r.id, baseline);
          }
        }

        const elapsedHours = Math.max(0, (nowMs - baseline.sinceMs) / 3_600_000);

        // 拉取池子实时 24h / 6h 成交量（5 分钟缓存）
        const vol = await fetchDexScreenerVolume(r.chain_id, poolIdOrAddr);
        const estDailyFeeUsd =
          vol.volume24hUsd !== null ? vol.volume24hUsd * feeRate * activeLShare : null;
        const estHourlyFeeUsd = estDailyFeeUsd !== null ? estDailyFeeUsd / 24 : null;
        const estDailyFee6hUsd =
          vol.volume6hUsd !== null ? vol.volume6hUsd * 4 * feeRate * activeLShare : null;

        out[r.id] = {
          positionId: r.id,
          dexType,
          poolIdOrAddr,
          feeRate,
          inRange,
          fees0,
          fees1,
          fees0Raw: fees0Raw.toString(),
          fees1Raw: fees1Raw.toString(),
          activeLShare,
          poolActiveLiquidity: poolActiveLiq.toString(),
          positionLiquidity: posLiq.toString(),
          poolVolume24hUsd: vol.volume24hUsd,
          poolVolume6hUsd: vol.volume6hUsd,
          poolTvlUsd: vol.tvlUsd,
          estDailyFeeUsd,
          estHourlyFeeUsd,
          estDailyFee6hUsd,
          feeSinceMs: baseline.sinceMs,
          elapsedHours,
          updatedAt: new Date(nowMs).toISOString(),
        };
      } catch (e: any) {
        out[r.id] = {
          positionId: r.id,
          dexType,
          poolIdOrAddr: r.pool || "",
          feeRate: (Number(r.fee) || 500) / 1_000_000,
          inRange: true,
          fees0: 0,
          fees1: 0,
          fees0Raw: "0",
          fees1Raw: "0",
          activeLShare: 0,
          poolActiveLiquidity: "0",
          positionLiquidity: "0",
          poolVolume24hUsd: null,
          poolVolume6hUsd: null,
          poolTvlUsd: null,
          estDailyFeeUsd: null,
          estHourlyFeeUsd: null,
          estDailyFee6hUsd: null,
          feeSinceMs: parseSqliteUtcMs(r.created_at),
          elapsedHours: 0,
          updatedAt: new Date(nowMs).toISOString(),
          error: e?.shortMessage || e?.message || String(e),
        };
      }
    })
  );

  cache.map = out;
  cache.fetchedAt = Date.now();
  return out;
}
