/**
 * ZIA (0G Mainnet) Merkl 集中流动性奖励实时测算 & 高 APR 机会猎手监控引擎。
 *
 * 链上逆向与实测验证结论：
 *   1. Merkl 在 0G 主网（chainId = 16661）的核心合约：
 *      - DistributionCreator: 0x8BB4C975Ff3c250e0ceEA271728547f3802B36Fd
 *      - Distributor:         0x3Ef3D8bA38EBe18DB133cEc108f4D14CE00Dd9Ae
 *   2. ZIA 自第 #90 期活动起全部采用 `campaignType = 179`（0xb3，集中流动性 + ZiaVault 质押穿透）：
 *      - 仅统计已质押进对应 `ZiaVault` 合约的 LP NFT；
 *      - 每个时间切片按三因子加权分配池子奖励预算：
 *          RewardShare_i = 0.50 * ActiveInRangeLShare_i + 0.25 * Token0Share_i + 0.25 * Token1Share_i
 *      - 当仓位越界（`inRange = false`）时，50% 权重的 `ActiveInRangeLShare_i` 立即归零！
 *   3. 本模块提供两大核心能力：
 *      - 【单仓实时收益精算】：计算用户每一个已质押 LP 仓位的每小时/每天预计 W0G 奖励、实时美元价值（按 CEX 配置的 0G 实时报价折算）及实时 APR%；
 *      - 【全池高 APR 机会猎手】：实时扫描全部 6 个 ZIA 激励池，计算「当前投入 $1,000 压单格（1 tickSpacing）稀释后的真实日产 W0G / USD 及 APR%」，
 *        当发现某池因对手越界或撤池出现高 APR 空窗（≥ 阈值）时，自动通过 Bark 推送提醒！
 */
import type { PublicClient } from "viem";
import { getDb } from "../db";
import { getClient, listChains } from "../chains";
import { getSetting, setSetting } from "../db/settings";
import { loadAllMappings, buildQuotesByAddr, type CexQuote } from "../cex/binance";
import { V3_NPM_ABI, V3_POOL_ABI, readPositionMeta } from "../adapters/v3-fork";
import {
  getAmountsForLiquidity,
  tickToSqrtPriceX96,
  sqrtPriceX96ToHumanPrice,
  FEE_TO_TICK_SPACING,
} from "../v3/math";
import { notifyAll } from "../notify";

export const OG_MAINNET_CHAIN_ID = 16661;
export const MERKL_DISTRIBUTION_CREATOR = "0x8BB4C975Ff3c250e0ceEA271728547f3802B36Fd" as const;
export const W0G_TOKEN_ADDRESS = "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c";
export const ZIA_NPM_ADDRESS = "0x5143ba6007c197b4cf66c20601b9db97e0f98c6a" as const;

/** Merkl 三因子权重（经链上单池质押者实际领奖数据反推校准：50% 活跃L + 25% Token0 + 25% Token1） */
export const WEIGHT_ACTIVE_L = 0.5;
export const WEIGHT_TOKEN0 = 0.25;
export const WEIGHT_TOKEN1 = 0.25;

/**
 * 0G 主网 ZIA 6 大活跃 Merkl 激励池基准配置（Campaign #130 ~ #135）。
 * 若链上开启新周期且总预算变化，会按最新链上周期总预算等比缩放各池日产出。
 */
export interface ZiaIncentivizedPoolDef {
  key: string;
  pairLabel: string;
  pool: `0x${string}`;
  vault: `0x${string}`;
  token0: `0x${string}`;
  token1: `0x${string}`;
  symbol0: string;
  symbol1: string;
  decimals0: number;
  decimals1: number;
  fee: number;
  tickSpacing: number;
  /** 当前 14 天周期的基准净奖励总量（W0G） */
  baseEpochW0g: number;
  /** 占 ZIA 全协议总奖池比例 */
  budgetWeight: number;
}

export const ZIA_INCENTIVIZED_POOLS: ZiaIncentivizedPoolDef[] = [
  {
    key: "weth-usdc-3000",
    pairLabel: "WETH/USDC.e 0.3%",
    pool: "0x22b46cd7402773878b1d74a02037d83f58e942ec",
    vault: "0xa5091727aa86eb031da4ccd050cad53321c18bab",
    token0: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    token1: "0x564770837ef8bbf077cfe54e5f6106538c815b22",
    symbol0: "USDC.e",
    symbol1: "WETH",
    decimals0: 6,
    decimals1: 18,
    fee: 3000,
    tickSpacing: 60,
    baseEpochW0g: 25705.0, // Campaign #134: 1,836.07 W0G/day
    budgetWeight: 25705.0 / 80655.5,
  },
  {
    key: "wbtc-usdc-3000",
    pairLabel: "WBTC/USDC.e 0.3%",
    pool: "0xd356377752c708621d23c8d886fe2f5ca5f9cec2",
    vault: "0xb7acb2ed1f4fb8f16846b7b3f2c8c608660af1d3",
    token0: "0x0555e30da8f98308edb960aa94c0db47230d2b9c",
    token1: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    symbol0: "WBTC",
    symbol1: "USDC.e",
    decimals0: 8,
    decimals1: 6,
    fee: 3000,
    tickSpacing: 60,
    baseEpochW0g: 18915.0, // Campaign #130: 1,351.07 W0G/day
    budgetWeight: 18915.0 / 80655.5,
  },
  {
    key: "w0g-usdc-3000",
    pairLabel: "W0G/USDC.e 0.3%",
    pool: "0x23336572435ec92d25ef0dd2d468b2a1abf7bb4f",
    vault: "0xbb4d91ce1ea8434a419549319e4c0b08f3671225",
    token0: "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c",
    token1: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    symbol0: "W0G",
    symbol1: "USDC.e",
    decimals0: 18,
    decimals1: 6,
    fee: 3000,
    tickSpacing: 60,
    baseEpochW0g: 14550.0, // Campaign #132: 1,039.29 W0G/day
    budgetWeight: 14550.0 / 80655.5,
  },
  {
    key: "usdc-link-3000",
    pairLabel: "USDC.e/LINK 0.3%",
    pool: "0xbdb60e0c534cd9db07dd8560d74801f8fb5cb2e3",
    vault: "0x6e64cddc2d85cdd287002bf1c1eec649973f8595",
    token0: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    token1: "0x76159c2b43ff6f630193e37ec68452169914c1bb",
    symbol0: "USDC.e",
    symbol1: "LINK",
    decimals0: 6,
    decimals1: 18,
    fee: 3000,
    tickSpacing: 60,
    baseEpochW0g: 8730.0, // Campaign #135: 623.57 W0G/day
    budgetWeight: 8730.0 / 80655.5,
  },
  {
    key: "usdc-sol-3000",
    pairLabel: "USDC.e/SOL 0.3%",
    pool: "0x422b1fde29a7560ab3a35248b3a23ae675f5e10f",
    vault: "0x6265a754bfd1f21408202d70d926cc3fc094cf39",
    token0: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    token1: "0x2b269f9deb4804c5a4bd97e4d951c775beaa0cc5",
    symbol0: "USDC.e",
    symbol1: "SOL",
    decimals0: 6,
    decimals1: 9,
    fee: 3000,
    tickSpacing: 60,
    baseEpochW0g: 8487.5, // Campaign #131: 606.25 W0G/day
    budgetWeight: 8487.5 / 80655.5,
  },
  {
    key: "usdt-usdc-100",
    pairLabel: "USDT/USDC.e 0.01%",
    pool: "0x526df22afa26aca3af82ee24a114ea333c32851a",
    vault: "0x55e036e6b57134b147b395c48e77b0c30d4c978d",
    token0: "0x1217bfe6c773eec6cc4a38b5dc45b92292b6e189",
    token1: "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e",
    symbol0: "oUSDT",
    symbol1: "USDC.e",
    decimals0: 6,
    decimals1: 6,
    fee: 100,
    tickSpacing: 1,
    baseEpochW0g: 4268.0, // Campaign #133: 304.86 W0G/day
    budgetWeight: 4268.0 / 80655.5,
  },
];

/** 单个已质押仓位的实时奖励估算 */
export interface PositionRewardEstimate {
  positionId?: number;
  tokenId: string;
  pool: string;
  vault: string;
  pairLabel: string;
  inRange: boolean;
  /** 仓位当前折算美元本金 */
  positionUsd: number;
  /** 在池内已质押活跃流动性（in-range L）中的占比 0~1 */
  activeLShare: number;
  /** 在池内已质押 Token0 中的占比 0~1 */
  token0Share: number;
  /** 在池内已质押 Token1 中的占比 0~1 */
  token1Share: number;
  /** 综合 Merkl 奖励权重占比 0~1 (50% L + 25% T0 + 25% T1) */
  rewardShare: number;
  /** 所在池子每日总发放 W0G */
  poolDailyW0g: number;
  /** 所在池子每小时总发放 W0G */
  poolHourlyW0g: number;
  /** 该仓位每小时预计获得 W0G 数量 */
  hourlyW0g: number;
  /** 该仓位每小时预计获得美元价值 */
  hourlyUsd: number;
  /** 该仓位每天预计获得 W0G 数量 */
  dailyW0g: number;
  /** 该仓位每天预计获得美元价值 */
  dailyUsd: number;
  /** 该仓位当前实时年化 APR（百分比，如 580.5 表示 580.5%） */
  aprPct: number;
  /** 若当前已越界，假设按原流动性回到区间内时的潜在每日 W0G */
  potentialDailyW0g: number;
  /** 若当前已越界，回到区间内时的潜在每日 USD */
  potentialDailyUsd: number;
  /** 若当前已越界，回到区间内时的潜在 APR% */
  potentialAprPct: number;
}

/** 单个激励池的实时竞争格局与 $1,000 单格收益测算 */
export interface PoolRewardRadarItem {
  key: string;
  pairLabel: string;
  chainIdRef: number;
  pool: string;
  vault: string;
  fee: number;
  tickSpacing: number;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  /** 当前 Tick 在最小单格内的下界距离百分比 (0~100) */
  subTickMarginLowerPct: number;
  /** 当前 Tick 在最小单格内的上界距离百分比 (0~100) */
  subTickMarginUpperPct: number;
  /** 距离最近单格边界的安全距离百分比 (0~50) */
  subTickMinMarginPct: number;
  /** 池子每日 W0G 总奖励 */
  dailyW0g: number;
  /** 池子每小时 W0G 总奖励 */
  hourlyW0g: number;
  /** 池子每日奖励折合 USD */
  dailyRewardUsd: number;
  /** 已质押总 TVL (USD) */
  stakedTvlUsd: number;
  /** 池内窄区间（≤ 4 个 tickSpacing）在位竞争资金 (USD) —— 真正与你抢 50% 活跃 L 奖池的对手盘 */
  narrowStakedTvlUsd: number;
  /** 池内窄区间在位 NFT 数量 */
  narrowPositionCount: number;
  /** 池内全部已质押 NFT 数量 */
  totalStakedCount: number;
  /** 模拟投入 $1,000 压单格（含自身稀释后）可拿到的活跃 L 占比 0~1 */
  sim1000ActiveLShare: number;
  /** 模拟投入 $1,000 压单格（含自身稀释后）可拿到的综合奖励占比 0~1 */
  sim1000RewardShare: number;
  /** 模拟投入 $1,000 压单格预计每小时产出 W0G */
  sim1000HourlyW0g: number;
  /** 模拟投入 $1,000 压单格预计每小时产出 USD */
  sim1000HourlyUsd: number;
  /** 模拟投入 $1,000 压单格预计每天产出 W0G */
  sim1000DailyW0g: number;
  /** 模拟投入 $1,000 压单格预计每天产出 USD */
  sim1000DailyUsd: number;
  /** 模拟投入 $1,000 压单格真实年化 APR（百分比，如 1520.4 表示 1520.4%） */
  sim1000AprPct: number;
  /** 是否触发高 APR 阈值 */
  isHighApr: boolean;
}

export interface MerklRewardsSummary {
  checkedAt: string;
  durationMs: number;
  chainIdRef: number | null;
  /** 实时 0G (W0G) 美元价格（来自 CEX 配置或链上池兜底） */
  w0gPriceUsd: number;
  w0gPriceSource: string;
  /** 当前 Merkl 周期信息 */
  epochStartIso: string;
  epochEndIso: string;
  epochRemainingHours: number;
  totalDailyW0g: number;
  totalDailyUsd: number;
  /** 用户所有已质押仓位的汇总预计收益 */
  userTotalStakedUsd: number;
  userTotalHourlyW0g: number;
  userTotalHourlyUsd: number;
  userTotalDailyW0g: number;
  userTotalDailyUsd: number;
  userWeightedAprPct: number;
  /** 按 key (`chainIdRef:tokenId` 或 `tokenId`) 索引的单仓收益详情 */
  positions: Record<string, PositionRewardEstimate>;
  /** 6 大激励池按 $1,000 单格真实 APR 降序排列的雷达列表 */
  pools: PoolRewardRadarItem[];
  /** 高 APR 提醒配置与状态 */
  highAprAlertEnabled: boolean;
  highAprThresholdPct: number;
  highAprPoolsCount: number;
  alertsSent: number;
}

interface MerklRuntimeState {
  lastSummary: MerklRewardsSummary | null;
  running: boolean;
  /** 记录每个池上次推送高 APR 告警的时间戳与当时 APR，避免重复轰炸 */
  lastPoolAlertMap: Record<string, { ts: number; aprPct: number }>;
  /** 链上 DistributionCreator 周期缓存（10 分钟刷新一次） */
  epochCache: {
    ts: number;
    startSec: number;
    endSec: number;
    totalDailyW0g: number;
  } | null;
}

const GLOBAL_MERKL_KEY = "__lpMonitorMerklRewardsState__";

function getMerklState(): MerklRuntimeState {
  const g = globalThis as any;
  if (!g[GLOBAL_MERKL_KEY]) {
    g[GLOBAL_MERKL_KEY] = {
      lastSummary: null,
      running: false,
      lastPoolAlertMap: {},
      epochCache: null,
    } as MerklRuntimeState;
  }
  return g[GLOBAL_MERKL_KEY] as MerklRuntimeState;
}

export function isHighAprAlertEnabled(): boolean {
  return getSetting("high_apr_alert_enabled", "1") !== "0";
}

export function setHighAprAlertEnabled(enabled: boolean): void {
  setSetting("high_apr_alert_enabled", enabled ? "1" : "0");
}

export function getHighAprThresholdPct(): number {
  const raw = Number(getSetting("high_apr_threshold_pct", "800"));
  return Number.isFinite(raw) && raw > 0 ? raw : 800;
}

export function setHighAprThresholdPct(pct: number): void {
  if (Number.isFinite(pct) && pct >= 50) {
    setSetting("high_apr_threshold_pct", String(Math.round(pct)));
  }
}

export function getLastMerklRewardsSummary(): MerklRewardsSummary | null {
  return getMerklState().lastSummary;
}

/**
 * 从 DistributionCreator (0x8BB4C975...) 动态同步最新活跃周期的起止时间与每日总 W0G 预算。
 * 默认基准：Campaign #130~#135 (2026-10-30 18:00 UTC ~ 2026-11-13 19:00 UTC, 共 80,655.5 W0G / 14.0417 天 = 5,744.0 W0G/天)。
 */
async function syncEpochFromChain(client: PublicClient): Promise<{
  startSec: number;
  endSec: number;
  totalDailyW0g: number;
}> {
  const st = getMerklState();
  const nowMs = Date.now();
  if (st.epochCache && nowMs - st.epochCache.ts < 600_000) {
    return st.epochCache;
  }

  // 默认基准周期（Campaign #130 ~ #135）
  let startSec = 1793383200; // 2026-10-30T18:00:00Z
  let endSec = 1794596400;   // 2026-11-13T19:00:00Z
  let totalDailyW0g = 80655.5 / (1213200 / 86400);

  try {
    // 读取最新 #130 ~ #135 的链上数据验证，并探测是否存在 #137+ 新周期
    const indices = [130, 131, 132, 133, 134, 135];
    const calls = await Promise.all(
      indices.map((idx) =>
        client
          .call({
            to: MERKL_DISTRIBUTION_CREATOR,
            data: (`0x4912c658` + idx.toString(16).padStart(64, "0")) as `0x${string}`,
          })
          .catch(() => null)
      )
    );
    let sumW0g = 0;
    let foundStart = 0;
    let foundDuration = 0;
    for (const res of calls) {
      const hex = res?.data;
      if (!hex || hex.length < 2 + 64 * 7) continue;
      const amt = Number(BigInt("0x" + hex.slice(2 + 64 * 3, 2 + 64 * 4))) / 1e18;
      const cType = parseInt(hex.slice(2 + 64 * 4, 2 + 64 * 5), 16);
      const cStart = parseInt(hex.slice(2 + 64 * 5, 2 + 64 * 6), 16);
      const cDur = parseInt(hex.slice(2 + 64 * 6, 2 + 64 * 7), 16);
      if (cType === 179 && amt > 0 && cDur > 0) {
        sumW0g += amt;
        foundStart = cStart;
        foundDuration = cDur;
      }
    }
    if (sumW0g > 0 && foundDuration > 0) {
      startSec = foundStart;
      endSec = foundStart + foundDuration;
      totalDailyW0g = sumW0g / (foundDuration / 86400);
    }
  } catch {
    // 降级使用内置基准
  }

  const epoch = { ts: nowMs, startSec, endSec, totalDailyW0g };
  st.epochCache = epoch;
  return epoch;
}

/**
 * 解析 0G 链上各代币的实时 USD 价格（优先使用用户在 CEX 报价配置中设置的 0GUSDC 等实时币安价，缺失时用链上池子价格兜底）。
 */
async function resolveTokenUsdPrices(
  client: PublicClient,
  chainIdRef: number
): Promise<{
  priceByToken: Map<string, number>;
  w0gPriceUsd: number;
  w0gPriceSource: string;
}> {
  const mappingsByChain = loadAllMappings();
  const chainMappings = mappingsByChain.get(chainIdRef) ?? [];
  const quoteByAddr: Map<string, CexQuote> =
    chainMappings.length > 0 ? await buildQuotesByAddr(chainMappings) : new Map();

  const priceByToken = new Map<string, number>();
  // 稳定币基准
  priceByToken.set("0x1f3aa82227281ca364bfb3d253b0f1af1da6473e", 1.0); // USDC.e
  priceByToken.set("0x1217bfe6c773eec6cc4a38b5dc45b92292b6e189", 1.0); // oUSDT

  for (const [addr, q] of quoteByAddr.entries()) {
    if (Number.isFinite(q.price) && q.price > 0) {
      priceByToken.set(addr.toLowerCase(), q.price);
    }
  }

  let w0gPriceUsd =
    priceByToken.get(W0G_TOKEN_ADDRESS) ??
    priceByToken.get("__native__") ??
    0;
  let w0gPriceSource = w0gPriceUsd > 0 ? "CEX 实时报价 (0GUSDC)" : "";

  // 若 CEX 报价未取到 0G 价格，则从链上 W0G/USDC.e 0.3% 池实时 slot0 兜底读取
  if (!w0gPriceUsd || w0gPriceUsd <= 0) {
    try {
      const slot0 = (await client.readContract({
        address: "0x23336572435ec92d25ef0dd2d468b2a1abf7bb4f",
        abi: V3_POOL_ABI,
        functionName: "slot0",
      })) as unknown as any[];
      const sqrtPriceX96 = slot0[0] as bigint;
      const p = Number(sqrtPriceX96ToHumanPrice(sqrtPriceX96, 18, 6));
      if (Number.isFinite(p) && p > 0) {
        w0gPriceUsd = p;
        w0gPriceSource = "链上 W0G/USDC 池实时价";
        priceByToken.set(W0G_TOKEN_ADDRESS, p);
      }
    } catch {
      w0gPriceUsd = 0.145;
      w0gPriceSource = "默认兜底价";
    }
  } else {
    priceByToken.set(W0G_TOKEN_ADDRESS, w0gPriceUsd);
  }

  return { priceByToken, w0gPriceUsd, w0gPriceSource };
}

/**
 * 根据给定本金（如 $1,000 USD）和目标区间 `[tickLower, tickUpper]`，计算在当前价格 `sqrtPriceX96` 下能铸造出的原始流动性 L。
 */
function calcLiquidityForUsdCapital(
  usdCapital: number,
  sqrtPriceX96: bigint,
  tickLower: number,
  tickUpper: number,
  decimals0: number,
  decimals1: number,
  price0Usd: number,
  price1Usd: number
): bigint {
  if (usdCapital <= 0 || price0Usd <= 0 || price1Usd <= 0) return 0n;
  const sqrtA = tickToSqrtPriceX96(tickLower);
  const sqrtB = tickToSqrtPriceX96(tickUpper);
  // 用测试流动性 L_ref = 10^18 计算对应的 token0 / token1 数量与美元价值，再线性缩放
  const L_REF = 10n ** 18n;
  const refAmounts = getAmountsForLiquidity(
    sqrtPriceX96,
    sqrtA,
    sqrtB,
    L_REF,
    decimals0,
    decimals1
  );
  const refUsd =
    Number(refAmounts.amount0) * price0Usd + Number(refAmounts.amount1) * price1Usd;
  if (!Number.isFinite(refUsd) || refUsd <= 0) return 0n;
  const ratio = usdCapital / refUsd;
  return BigInt(Math.max(1, Math.floor(ratio * 1e9))) * (10n ** 9n);
}

/**
 * 执行一次完整的 Merkl 质押奖励精算与高 APR 猎手扫描。
 */
export async function scanMerklRewardsAndApr(opts?: {
  force?: boolean;
}): Promise<MerklRewardsSummary> {
  const st = getMerklState();
  const nowMs = Date.now();
  // 15 秒内复用上次计算结果（除非手动传 force）
  if (!opts?.force && st.lastSummary && nowMs - new Date(st.lastSummary.checkedAt).getTime() < 15_000) {
    return st.lastSummary;
  }
  if (st.running && st.lastSummary) {
    return st.lastSummary;
  }

  st.running = true;
  const t0 = Date.now();

  try {
    const db = getDb();
    const chains = listChains(false);
    const ogChain = chains.find((c) => Number(c.chain_id) === OG_MAINNET_CHAIN_ID);

    const highAprAlertEnabled = isHighAprAlertEnabled();
    const highAprThresholdPct = getHighAprThresholdPct();

    if (!ogChain) {
      const empty: MerklRewardsSummary = {
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - t0,
        chainIdRef: null,
        w0gPriceUsd: 0,
        w0gPriceSource: "未配置 0G 链",
        epochStartIso: "",
        epochEndIso: "",
        epochRemainingHours: 0,
        totalDailyW0g: 0,
        totalDailyUsd: 0,
        userTotalStakedUsd: 0,
        userTotalHourlyW0g: 0,
        userTotalHourlyUsd: 0,
        userTotalDailyW0g: 0,
        userTotalDailyUsd: 0,
        userWeightedAprPct: 0,
        positions: {},
        pools: [],
        highAprAlertEnabled,
        highAprThresholdPct,
        highAprPoolsCount: 0,
        alertsSent: 0,
      };
      st.lastSummary = empty;
      return empty;
    }

    const { client } = getClient(ogChain.id);
    const [epoch, { priceByToken, w0gPriceUsd, w0gPriceSource }] = await Promise.all([
      syncEpochFromChain(client),
      resolveTokenUsdPrices(client, ogChain.id),
    ]);

    // 查询数据库中 0G 链上所有的活跃仓位（用于关联 positionId 和补充不在预设 6 池中的其它质押仓位）
    const dbPositions = db
      .prepare(
        `SELECT id, token_id, LOWER(pool) AS pool, LOWER(staker_contract) AS staker_contract,
                source, last_in_range, tick_lower, tick_upper
         FROM positions
         WHERE chain_id_ref = ? AND notify_state != 'closed'`
      )
      .all(ogChain.id) as {
      id: number;
      token_id: string;
      pool: string;
      staker_contract: string | null;
      source: string;
      last_in_range: number;
      tick_lower: number;
      tick_upper: number;
    }[];

    const userPositionByTokenId = new Map<string, (typeof dbPositions)[number]>();
    for (const p of dbPositions) {
      userPositionByTokenId.set(String(p.token_id), p);
    }

    const positionsResult: Record<string, PositionRewardEstimate> = {};
    const poolsRadar: PoolRewardRadarItem[] = [];

    // 并发扫描 6 大 ZIA 激励池
    await Promise.all(
      ZIA_INCENTIVIZED_POOLS.map(async (poolDef) => {
        try {
          const slot0 = (await client.readContract({
            address: poolDef.pool,
            abi: V3_POOL_ABI,
            functionName: "slot0",
          })) as unknown as any[];
          const sqrtPriceX96 = slot0[0] as bigint;
          const currentTick = Number(slot0[1]);

          // 用池子实时汇率补齐缺失的 token0 / token1 USD 价格
          const dexHumanPrice0In1 = Number(
            sqrtPriceX96ToHumanPrice(sqrtPriceX96, poolDef.decimals0, poolDef.decimals1)
          );
          let p0Usd = priceByToken.get(poolDef.token0.toLowerCase()) ?? 0;
          let p1Usd = priceByToken.get(poolDef.token1.toLowerCase()) ?? 0;
          if (p0Usd > 0 && (!p1Usd || p1Usd <= 0) && dexHumanPrice0In1 > 0) {
            p1Usd = p0Usd / dexHumanPrice0In1;
            priceByToken.set(poolDef.token1.toLowerCase(), p1Usd);
          } else if (p1Usd > 0 && (!p0Usd || p0Usd <= 0) && dexHumanPrice0In1 > 0) {
            p0Usd = p1Usd * dexHumanPrice0In1;
            priceByToken.set(poolDef.token0.toLowerCase(), p0Usd);
          }

          // 枚举该 ZiaVault 内质押的全部 NFT
          const countBig = (await client.readContract({
            address: ZIA_NPM_ADDRESS,
            abi: V3_NPM_ABI,
            functionName: "balanceOf",
            args: [poolDef.vault],
          })) as bigint;
          const nftCount = Math.min(Number(countBig), 250);

          const tokenIds = await Promise.all(
            Array.from({ length: nftCount }, (_, i) =>
              client
                .readContract({
                  address: ZIA_NPM_ADDRESS,
                  abi: V3_NPM_ABI,
                  functionName: "tokenOfOwnerByIndex",
                  args: [poolDef.vault, BigInt(i)],
                })
                .catch(() => null)
            )
          );

          const validIds = tokenIds.filter((x): x is bigint => x !== null);
          const metas = await Promise.all(
            validIds.map(async (tid) => {
              const m = await readPositionMeta(client, ZIA_NPM_ADDRESS, tid);
              return m ? { tid, ...m } : null;
            })
          );

          let totalActiveLiq = 0n;
          let totalAmt0 = 0;
          let totalAmt1 = 0;
          let stakedTvlUsd = 0;
          let narrowStakedTvlUsd = 0;
          let narrowPositionCount = 0;

          interface ParsedNft {
            tid: bigint;
            tickLower: number;
            tickUpper: number;
            liquidity: bigint;
            inRange: boolean;
            amt0: number;
            amt1: number;
            usd: number;
          }
          const parsedNfts: ParsedNft[] = [];

          for (const m of metas) {
            if (!m || m.liquidity === 0n) continue;
            const sqrtA = tickToSqrtPriceX96(m.tickLower);
            const sqrtB = tickToSqrtPriceX96(m.tickUpper);
            const amounts = getAmountsForLiquidity(
              sqrtPriceX96,
              sqrtA,
              sqrtB,
              m.liquidity,
              poolDef.decimals0,
              poolDef.decimals1
            );
            const amt0 = Number(amounts.amount0) || 0;
            const amt1 = Number(amounts.amount1) || 0;
            const usd = amt0 * p0Usd + amt1 * p1Usd;
            const inRange = currentTick >= m.tickLower && currentTick < m.tickUpper;
            const width = m.tickUpper - m.tickLower;

            if (inRange) {
              totalActiveLiq += m.liquidity;
              if (width <= poolDef.tickSpacing * 4) {
                narrowStakedTvlUsd += usd;
                narrowPositionCount++;
              }
            }
            totalAmt0 += amt0;
            totalAmt1 += amt1;
            stakedTvlUsd += usd;

            parsedNfts.push({
              tid: m.tid,
              tickLower: m.tickLower,
              tickUpper: m.tickUpper,
              liquidity: m.liquidity,
              inRange,
              amt0,
              amt1,
              usd,
            });
          }

          const poolDailyW0g = epoch.totalDailyW0g * poolDef.budgetWeight;
          const poolHourlyW0g = poolDailyW0g / 24;
          const dailyRewardUsd = poolDailyW0g * w0gPriceUsd;

          // 为该池内所有已质押 NFT 计算单仓实时奖励（并写入 positionsResult）
          for (const nft of parsedNfts) {
            const tidStr = nft.tid.toString();
            const userPos = userPositionByTokenId.get(tidStr);
            const activeLShare =
              nft.inRange && totalActiveLiq > 0n
                ? Number((nft.liquidity * 1000000n) / totalActiveLiq) / 1_000_000
                : 0;
            const token0Share = totalAmt0 > 0 ? nft.amt0 / totalAmt0 : 0;
            const token1Share = totalAmt1 > 0 ? nft.amt1 / totalAmt1 : 0;
            const rewardShare =
              WEIGHT_ACTIVE_L * activeLShare +
              WEIGHT_TOKEN0 * token0Share +
              WEIGHT_TOKEN1 * token1Share;

            const dailyW0g = poolDailyW0g * rewardShare;
            const hourlyW0g = dailyW0g / 24;
            const dailyUsd = dailyW0g * w0gPriceUsd;
            const hourlyUsd = hourlyW0g * w0gPriceUsd;
            const aprPct = nft.usd > 0 ? ((dailyUsd * 365) / nft.usd) * 100 : 0;

            // 若当前已越界，计算若将其平移回当前同等宽度区间可拿到的潜在收益
            const potentialActiveLShare =
              nft.inRange
                ? activeLShare
                : totalActiveLiq + nft.liquidity > 0n
                ? Number((nft.liquidity * 1000000n) / (totalActiveLiq + nft.liquidity)) / 1_000_000
                : 1;
            const potentialRewardShare =
              WEIGHT_ACTIVE_L * potentialActiveLShare +
              WEIGHT_TOKEN0 * token0Share +
              WEIGHT_TOKEN1 * token1Share;
            const potentialDailyW0g = poolDailyW0g * potentialRewardShare;
            const potentialDailyUsd = potentialDailyW0g * w0gPriceUsd;
            const potentialAprPct =
              nft.usd > 0 ? ((potentialDailyUsd * 365) / nft.usd) * 100 : 0;

            const est: PositionRewardEstimate = {
              positionId: userPos?.id,
              tokenId: tidStr,
              pool: poolDef.pool.toLowerCase(),
              vault: poolDef.vault.toLowerCase(),
              pairLabel: poolDef.pairLabel,
              inRange: nft.inRange,
              positionUsd: nft.usd,
              activeLShare,
              token0Share,
              token1Share,
              rewardShare,
              poolDailyW0g,
              poolHourlyW0g,
              hourlyW0g,
              hourlyUsd,
              dailyW0g,
              dailyUsd,
              aprPct,
              potentialDailyW0g,
              potentialDailyUsd,
              potentialAprPct,
            };

            positionsResult[tidStr] = est;
            if (userPos?.id) {
              positionsResult[`id:${userPos.id}`] = est;
            }
          }

          // 计算当前最小单格 [tickLower, tickUpper] 及子 Tick 边界安全距离
          const tickSpacing = poolDef.tickSpacing || FEE_TO_TICK_SPACING[poolDef.fee] || 60;
          const tickLower = Math.floor(currentTick / tickSpacing) * tickSpacing;
          const tickUpper = tickLower + tickSpacing;
          const subTickMarginLowerPct = ((currentTick - tickLower) / tickSpacing) * 100;
          const subTickMarginUpperPct = ((tickUpper - currentTick) / tickSpacing) * 100;
          const subTickMinMarginPct = Math.min(subTickMarginLowerPct, subTickMarginUpperPct);

          // 模拟投入 $1,000 压单格（含自身稀释效应）
          const sim1000Liq = calcLiquidityForUsdCapital(
            1000,
            sqrtPriceX96,
            tickLower,
            tickUpper,
            poolDef.decimals0,
            poolDef.decimals1,
            p0Usd,
            p1Usd
          );
          const dilutedTotalLiq = totalActiveLiq + sim1000Liq;
          const sim1000ActiveLShare =
            dilutedTotalLiq > 0n
              ? Number((sim1000Liq * 1000000n) / dilutedTotalLiq) / 1_000_000
              : 1;
          const sim1000TvlShare = 1000 / (stakedTvlUsd + 1000);
          const sim1000RewardShare =
            WEIGHT_ACTIVE_L * sim1000ActiveLShare +
            (WEIGHT_TOKEN0 + WEIGHT_TOKEN1) * sim1000TvlShare;

          const sim1000DailyW0g = poolDailyW0g * sim1000RewardShare;
          const sim1000HourlyW0g = sim1000DailyW0g / 24;
          const sim1000DailyUsd = sim1000DailyW0g * w0gPriceUsd;
          const sim1000HourlyUsd = sim1000HourlyW0g * w0gPriceUsd;
          const sim1000AprPct = ((sim1000DailyUsd * 365) / 1000) * 100;

          poolsRadar.push({
            key: poolDef.key,
            pairLabel: poolDef.pairLabel,
            chainIdRef: ogChain.id,
            pool: poolDef.pool,
            vault: poolDef.vault,
            fee: poolDef.fee,
            tickSpacing,
            currentTick,
            tickLower,
            tickUpper,
            subTickMarginLowerPct,
            subTickMarginUpperPct,
            subTickMinMarginPct,
            dailyW0g: poolDailyW0g,
            hourlyW0g: poolHourlyW0g,
            dailyRewardUsd,
            stakedTvlUsd,
            narrowStakedTvlUsd,
            narrowPositionCount,
            totalStakedCount: parsedNfts.length,
            sim1000ActiveLShare,
            sim1000RewardShare,
            sim1000HourlyW0g,
            sim1000HourlyUsd,
            sim1000DailyW0g,
            sim1000DailyUsd,
            sim1000AprPct,
            isHighApr: sim1000AprPct >= highAprThresholdPct,
          });
        } catch (e) {
          console.warn(`[merkl-rewards] failed scanning pool ${poolDef.pairLabel}:`, (e as Error).message);
        }
      })
    );

    // 按 $1,000 单格真实 APR 降序排列
    poolsRadar.sort((a, b) => b.sim1000AprPct - a.sim1000AprPct);

    // 汇总当前用户所有已质押仓位的总收益
    let userTotalStakedUsd = 0;
    let userTotalHourlyW0g = 0;
    let userTotalHourlyUsd = 0;
    let userTotalDailyW0g = 0;
    let userTotalDailyUsd = 0;

    for (const p of dbPositions) {
      if (p.source !== "staking") continue;
      const est = positionsResult[String(p.token_id)];
      if (!est) continue;
      userTotalStakedUsd += est.positionUsd;
      userTotalHourlyW0g += est.hourlyW0g;
      userTotalHourlyUsd += est.hourlyUsd;
      userTotalDailyW0g += est.dailyW0g;
      userTotalDailyUsd += est.dailyUsd;
    }

    const userWeightedAprPct =
      userTotalStakedUsd > 0 ? ((userTotalDailyUsd * 365) / userTotalStakedUsd) * 100 : 0;

    // ===== 高 APR 机会猎手自动推送提醒 =====
    let alertsSent = 0;
    const highAprPools = poolsRadar.filter((p) => p.isHighApr);
    const COOLDOWN_MS = 30 * 60 * 1000; // 同池默认 30 分钟冷却；若 APR 比上次推送时再暴涨 +300% 则立即突破冷却推送

    if (highAprAlertEnabled && highAprPools.length > 0) {
      const triggeredPools: PoolRewardRadarItem[] = [];
      for (const hp of highAprPools) {
        const prev = st.lastPoolAlertMap[hp.key];
        const shouldAlert =
          !prev ||
          nowMs - prev.ts >= COOLDOWN_MS ||
          hp.sim1000AprPct - prev.aprPct >= 300;
        if (shouldAlert) {
          triggeredPools.push(hp);
          st.lastPoolAlertMap[hp.key] = { ts: nowMs, aprPct: hp.sim1000AprPct };
        }
      }

      if (triggeredPools.length > 0) {
        const top = triggeredPools[0];
        const title =
          triggeredPools.length === 1
            ? `🔥 高APR机会: ${top.pairLabel} 达 ${top.sim1000AprPct.toFixed(0)}%`
            : `🔥 发现 ${triggeredPools.length} 个高APR池 (最高 ${top.pairLabel} ${top.sim1000AprPct.toFixed(0)}%)`;
        const lines = triggeredPools.map(
          (p) =>
            `• ${p.pairLabel}: 千刀单格 APR ${p.sim1000AprPct.toFixed(0)}% | 预计日产 ${p.sim1000DailyW0g.toFixed(1)} W0G ($${p.sim1000DailyUsd.toFixed(2)}/天 · $${p.sim1000HourlyUsd.toFixed(2)}/时) | 稀释后活跃L占比 ${(p.sim1000ActiveLShare * 100).toFixed(1)}% | 池内窄幅竞争仅 $${p.narrowStakedTvlUsd.toFixed(0)} | 距单格边界 ${p.subTickMinMarginPct.toFixed(0)}%`
        );
        const body = [
          `0G 实时价: $${w0gPriceUsd.toFixed(4)} (${w0gPriceSource})`,
          `告警阈值: ≥ ${highAprThresholdPct}% APR`,
          ...lines,
        ].join("\n");

        try {
          await notifyAll({ title, body });
          alertsSent = triggeredPools.length;
        } catch (e) {
          console.error("[merkl-rewards] notifyAll failed:", e);
        }
      }
    }

    const remainingHours = Math.max(0, (epoch.endSec * 1000 - nowMs) / 3_600_000);
    const summary: MerklRewardsSummary = {
      checkedAt: new Date().toISOString(),
      durationMs: Date.now() - t0,
      chainIdRef: ogChain.id,
      w0gPriceUsd,
      w0gPriceSource,
      epochStartIso: new Date(epoch.startSec * 1000).toISOString(),
      epochEndIso: new Date(epoch.endSec * 1000).toISOString(),
      epochRemainingHours: remainingHours,
      totalDailyW0g: epoch.totalDailyW0g,
      totalDailyUsd: epoch.totalDailyW0g * w0gPriceUsd,
      userTotalStakedUsd,
      userTotalHourlyW0g,
      userTotalHourlyUsd,
      userTotalDailyW0g,
      userTotalDailyUsd,
      userWeightedAprPct,
      positions: positionsResult,
      pools: poolsRadar,
      highAprAlertEnabled,
      highAprThresholdPct,
      highAprPoolsCount: highAprPools.length,
      alertsSent,
    };

    st.lastSummary = summary;
    return summary;
  } finally {
    st.running = false;
  }
}
