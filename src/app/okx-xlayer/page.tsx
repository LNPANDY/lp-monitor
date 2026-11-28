"use client";

import { useCallback, useMemo, useState } from "react";
import useSWR from "swr";
import { encodeFunctionData, parseAbi, type Address } from "viem";
import { fetcher, authHeaders, short } from "@/components/util";
import { toast } from "@/components/toast";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";
import type {
  OkxLedgerEntryType,
  OkxLivePoolMetrics,
  OkxPoolsSnapshotResponse,
  OkxXLayerPortfolioPnl,
  XLayerLivePosition,
} from "@/lib/okx/xlayer-service";
import {
  OKX_BONUS_APY_CAP_PCT,
  XLAYER_CHAIN_ID,
  XLAYER_EXPLORER_BASE,
  XLAYER_V3_NPM,
  type StrategyGroup,
} from "@/lib/okx/xlayer-catalog";

const MAX_UINT128 = (1n << 128n) - 1n;
const CONC_8PCT = 1 / (1 - Math.pow(1.08, -0.25)); // 52.471x

const NPM_REMOVE_ABI = parseAbi([
  "function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) payable returns (uint256 amount0, uint256 amount1)",
  "function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) payable returns (uint256 amount0, uint256 amount1)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
]);

type GroupFilter = "recommended" | "bias95" | "crypto247" | "corr_rwa" | "all";
type PresetMode = "bias95" | "bias88" | "sym50" | "custom";

const GROUP_BADGE: Record<StrategyGroup, { label: string; cls: string }> = {
  bias95: { label: "95/5 躺吃首选", cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300" },
  crypto247: { label: "币圈 7×24 主力", cls: "border-cyan-500/40 bg-cyan-500/15 text-cyan-300" },
  corr_rwa: { label: "股-指蓝海", cls: "border-violet-500/40 bg-violet-500/15 text-violet-300" },
  other: { label: "常规池", cls: "border-slate-600/50 bg-slate-700/30 text-slate-300" },
  avoid: { label: "⚠️ 高卷/陷阱", cls: "border-rose-500/40 bg-rose-500/15 text-rose-300" },
};

const LEDGER_LABELS: Record<OkxLedgerEntryType, { label: string; badge: string; sign: string }> = {
  deposit: { label: "转入本金 (入金)", badge: "bg-sky-500/15 text-sky-300 border-sky-500/30", sign: "+" },
  rwa_buy_cost: { label: "主动买 RWA 成本", badge: "bg-amber-500/15 text-amber-300 border-amber-500/30", sign: "+" },
  withdraw: { label: "提现回笼 (出金)", badge: "bg-slate-500/20 text-slate-300 border-slate-500/30", sign: "-" },
  lp_fee_realized: { label: "已领/平仓 LP 费", badge: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30", sign: "+" },
  okx_bonus: { label: "OKX 补贴 (USDG)", badge: "bg-violet-500/15 text-violet-300 border-violet-500/30", sign: "+" },
};

function fmtUsd(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return "$0.00";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs).toLocaleString()}`;
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function fmtPrice(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "0";
  if (p >= 1000) return p.toFixed(2);
  if (p >= 10) return p.toFixed(4);
  if (p >= 0.1) return p.toFixed(5);
  return p.toFixed(7);
}

interface ComputedPlan {
  tickLower: number;
  tickUpper: number;
  widthTicks: number;
  widthPct: number;
  bonusEligible: boolean;
  displayPriceLow: number;
  displayPriceHigh: number;
  marginDownPct: number;
  marginUpPct: number;
  actualMajorPct: number;
  actualOtherPct: number;
  majorUsd: number;
  otherUsd: number;
  majorQty: number;
  otherQty: number;
  majorSymbol: string;
  otherSymbol: string;
  /** 当前所选宽度对应的池子等价活跃流动性总量（USD） */
  depthAtWidthUsd: number;
  /** 投入本金后占活跃流动性比例 (%) */
  mySharePct: number;
  /** 预期纯 LP 净日手续费 & APR (%) */
  estDailyLpUsd: number;
  estLpAprPct: number;
  /** 预期 OKX 补贴（未封顶理论值 & 100% APY 封顶保守值） */
  estDailyOkxUncappedUsd: number;
  estDailyOkxCappedUsd: number;
  estOkxAprUncappedPct: number;
  estOkxAprCappedPct: number;
  /** 合计日赚 & APR */
  estDailyTotalCappedUsd: number;
  estDailyTotalUncappedUsd: number;
  estTotalAprCappedPct: number;
  estTotalAprUncappedPct: number;
  /** 触及上界（变 100% 主流币）和下界（变 100% RWA）时的相对 HODL 单次 IL ($) */
  ilAtUpperUsd: number;
  ilAtLowerUsd: number;
}

/**
 * 精确计算指定本金、总宽度（ticks）和主流币偏置占比（%）下的最优 tickLower / tickUpper、
 * 双币精确投入数量、当前区间等价流动性总量、预期收益与边界 IL。
 */
function calcPoolPlan(
  pool: OkxLivePoolMetrics,
  capitalUsd: number,
  widthTicksRaw: number,
  targetMajorPctRaw: number
): ComputedPlan {
  const ts = pool.tickSpacing || 10;
  const widthTicks = Math.max(ts * 2, Math.round(widthTicksRaw / ts) * ts);
  const hasMajor = pool.majorSide !== "none";
  const targetMajorPct = hasMajor ? Math.min(97, Math.max(50, targetMajorPctRaw)) : 50;

  // 在「展示方向：1 非主流(RWA) = P 主流」下求解精确上界倍数 u = sqrt(P_high / P_now)
  const r = Math.pow(1.0001, widthTicks / 2);
  const b = targetMajorPct / 100;
  const a = 1 - b;
  const disc = Math.pow((b - a) * r, 2) + 4 * a * b * r;
  const u = a > 1e-6 ? (-(b - a) * r + Math.sqrt(disc)) / (2 * a) : Math.sqrt(r);
  const upTicksIdeal = Math.log(u * u) / Math.log(1.0001);
  // 至少给上界留 1 个 tickSpacing，确保开仓瞬间在区间内
  const upTicks = Math.min(widthTicks - ts, Math.max(ts, Math.round(upTicksIdeal / ts) * ts));
  const downTicks = Math.max(ts, widthTicks - upTicks);

  // 将展示方向的 upTicks / downTicks 映射回池子原始 token0/token1 的 tickLower / tickUpper
  const curAligned = Math.floor(pool.currentTick / ts) * ts;
  let tickLower: number;
  let tickUpper: number;
  if (!pool.displayInverted) {
    // 展示方向与原始 tick 同向：上界 = current + upTicks，下界 = current - downTicks
    tickLower = curAligned - downTicks;
    tickUpper = curAligned + upTicks;
    if (tickUpper <= pool.currentTick) tickUpper += ts;
    if (tickLower >= pool.currentTick) tickLower -= ts;
  } else {
    // 展示方向反转（token0 是主流币，token1 是 RWA）：RWA 价格涨 => 原始 tick 跌！
    // 因此 RWA 上界对应原始 tickLower = current - upTicks；RWA 下界对应原始 tickUpper = current + downTicks
    tickLower = curAligned - upTicks;
    tickUpper = curAligned + downTicks;
    if (tickLower >= pool.currentTick) tickLower -= ts;
    if (tickUpper <= pool.currentTick) tickUpper += ts;
  }
  const actualWidthTicks = tickUpper - tickLower;
  const widthPct = (Math.pow(1.0001, actualWidthTicks) - 1) * 100;

  // 计算展示方向下界与上界价格，并除以 ERC-4626 股息包装乘数与 OKX 原股页面 1:1 对齐
  const rawPriceLow = Math.pow(1.0001, tickLower) * Math.pow(10, pool.dec0 - pool.dec1);
  const rawPriceHigh = Math.pow(1.0001, tickUpper) * Math.pow(10, pool.dec0 - pool.dec1);
  const wrappedLow = pool.displayInverted ? 1 / rawPriceHigh : rawPriceLow;
  const wrappedHigh = pool.displayInverted ? 1 / rawPriceLow : rawPriceHigh;
  const mult = pool.wrapMultiplier > 0 ? pool.wrapMultiplier : 1;
  const displayPriceLow = wrappedLow / mult;
  const displayPriceHigh = wrappedHigh / mult;

  const pNow = pool.unwrappedDexPrice > 0 ? pool.unwrappedDexPrice : (pool.displayPrice > 0 ? pool.displayPrice : 1);
  const marginDownPct = Math.max(0, (1 - displayPriceLow / pNow) * 100);
  const marginUpPct = Math.max(0, (displayPriceHigh / pNow - 1) * 100);

  // 用 V3 精确公式计算实际双币价值占比（展示方向下：主流币 = quote，RWA = base）
  const sNow = Math.sqrt(pNow);
  const sLow = Math.sqrt(Math.max(1e-18, displayPriceLow));
  const sHigh = Math.sqrt(Math.max(sNow * 1.00001, displayPriceHigh));
  const quoteTerm = Math.max(0, sNow - sLow); // 主流币价值比例项（按 L=1）
  const baseTerm = Math.max(0, (1 / sNow - 1 / sHigh) * pNow); // RWA 价值比例项（按 L=1）
  const totTerm = quoteTerm + baseTerm || 1;
  const actualMajorPct = (quoteTerm / totTerm) * 100;
  const actualOtherPct = 100 - actualMajorPct;

  const majorUsd = (capitalUsd * actualMajorPct) / 100;
  const otherUsd = (capitalUsd * actualOtherPct) / 100;
  const majorPriceUsd = pool.displayInverted ? pool.price0Usd : pool.price1Usd;
  const otherPriceUsd = pool.displayInverted ? pool.price1Usd : pool.price0Usd;
  const majorQty = majorPriceUsd > 0 ? majorUsd / majorPriceUsd : 0;
  const otherQty = otherPriceUsd > 0 ? otherUsd / otherPriceUsd : 0;

  // 当前所选宽度下的集中度倍数（相对全区间）与池子等价活跃流动性总量
  // L_unit = 1 / ((2 - sLow/sNow - sNow/sHigh)) * 2
  const userConcMult = 2 / Math.max(1e-6, 2 - sLow / sNow - sNow / sHigh);
  const depthAtWidthUsd =
    pool.depth8pctUsd > 0 ? pool.depth8pctUsd * (CONC_8PCT / userConcMult) : 0;

  const myShare = capitalUsd > 0 && depthAtWidthUsd >= 0 ? capitalUsd / (depthAtWidthUsd + capitalUsd) : 0;
  const bonusEligible = actualWidthTicks > pool.tickWidthRule && widthPct >= 7.8;

  const estDailyLpUsd = pool.poolDailyLpFeeUsd * myShare;
  const estLpAprPct = capitalUsd > 0 ? (estDailyLpUsd * 365 / capitalUsd) * 100 : 0;

  const estDailyOkxUncappedUsd = bonusEligible ? pool.okxDailyUsd * myShare : 0;
  const estOkxAprUncappedPct = capitalUsd > 0 ? (estDailyOkxUncappedUsd * 365 / capitalUsd) * 100 : 0;
  const estOkxAprCappedPct = Math.min(OKX_BONUS_APY_CAP_PCT, estOkxAprUncappedPct);
  const estDailyOkxCappedUsd = (capitalUsd * (estOkxAprCappedPct / 100)) / 365;

  const estDailyTotalCappedUsd = estDailyLpUsd + estDailyOkxCappedUsd;
  const estDailyTotalUncappedUsd = estDailyLpUsd + estDailyOkxUncappedUsd;

  // 触及上界（全变主流币）与触及下界（全变 RWA）相对开仓 HODL 的精确单次 IL（$）
  const Lnorm = capitalUsd / Math.max(1e-12, totTerm * sNow);
  // 上界价 displayPriceHigh 时：LP 全变主流币 = Lnorm * (sHigh - sLow) * sNow? 精确：
  // 设初始 base0 = Lnorm * (1/sNow - 1/sHigh), quote0 = Lnorm * (sNow - sLow), 以 quote 计总价值 = capitalUsd
  const Lq = capitalUsd / Math.max(1e-12, quoteTerm + baseTerm);
  const base0 = Lq * (1 / sNow - 1 / sHigh);
  const quote0 = Lq * (sNow - sLow);
  const lpAtUpper = Lq * (sHigh - sLow);
  const hodlAtUpper = base0 * displayPriceHigh + quote0;
  const ilAtUpperUsd = lpAtUpper - hodlAtUpper; // 负数

  const lpAtLower = Lq * (1 / sLow - 1 / sHigh) * displayPriceLow;
  const hodlAtLower = base0 * displayPriceLow + quote0;
  const ilAtLowerUsd = lpAtLower - hodlAtLower; // 负数

  return {
    tickLower,
    tickUpper,
    widthTicks: actualWidthTicks,
    widthPct,
    bonusEligible,
    displayPriceLow,
    displayPriceHigh,
    marginDownPct,
    marginUpPct,
    actualMajorPct,
    actualOtherPct,
    majorUsd,
    otherUsd,
    majorQty,
    otherQty,
    majorSymbol: pool.displayQuoteSymbol,
    otherSymbol: pool.displayBaseSymbol,
    depthAtWidthUsd: Math.round(depthAtWidthUsd),
    mySharePct: myShare * 100,
    estDailyLpUsd,
    estLpAprPct,
    estDailyOkxUncappedUsd,
    estDailyOkxCappedUsd,
    estOkxAprUncappedPct,
    estOkxAprCappedPct,
    estDailyTotalCappedUsd,
    estDailyTotalUncappedUsd,
    estTotalAprCappedPct: estLpAprPct + estOkxAprCappedPct,
    estTotalAprUncappedPct: estLpAprPct + estOkxAprUncappedPct,
    ilAtUpperUsd,
    ilAtLowerUsd,
  };
}

export default function OkxXLayerPage() {
  const { address: connectedWallet, chainId: walletChainId, switchChain, connect } = useWallet();
  const [activeTab, setActiveTab] = useState<"radar" | "pnl">("radar");
  const [groupFilter, setGroupFilter] = useState<GroupFilter>("recommended");
  const [hideAvoid, setHideAvoid] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [selectedPoolAddr, setSelectedPoolAddr] = useState<string>("");

  // 全局模拟参数
  const [capitalUsd, setCapitalUsd] = useState<number>(2000);
  const [presetMode, setPresetMode] = useState<PresetMode>("bias95");
  const [customWidthTicks, setCustomWidthTicks] = useState<number>(800); // 800 ticks ≈ 8.33% (>750 ticks红线)
  const [customBiasPct, setCustomBiasPct] = useState<number>(95);
  const [refreshingPools, setRefreshingPools] = useState(false);

  // 台账与平仓状态
  const [walletOverride, setWalletOverride] = useState<string>("");
  const [entryType, setEntryType] = useState<OkxLedgerEntryType>("deposit");
  const [entryAmount, setEntryAmount] = useState<string>("");
  const [entryPoolName, setEntryPoolName] = useState<string>("");
  const [entryNote, setEntryNote] = useState<string>("");
  const [submittingLedger, setSubmittingLedger] = useState(false);
  const [removingTokenId, setRemovingTokenId] = useState<string | null>(null);

  const {
    data: poolsResp,
    isLoading: poolsLoading,
    mutate: mutatePools,
  } = useSWR<OkxPoolsSnapshotResponse>("/api/okx-xlayer/pools", fetcher, {
    refreshInterval: 60_000,
    revalidateOnFocus: false,
  });

  const targetWallet = walletOverride.trim() || connectedWallet || "";
  const pnlKey = targetWallet
    ? `/api/okx-xlayer/pnl?wallet=${encodeURIComponent(targetWallet)}`
    : "/api/okx-xlayer/pnl";

  const {
    data: pnlResp,
    isLoading: pnlLoading,
    mutate: mutatePnl,
  } = useSWR<OkxXLayerPortfolioPnl>(pnlKey, fetcher, {
    refreshInterval: 45_000,
    revalidateOnFocus: false,
  });

  const handleForceRefreshPools = useCallback(async () => {
    setRefreshingPools(true);
    try {
      const fresh = await fetcher("/api/okx-xlayer/pools?force=1");
      await mutatePools(fresh, false);
      toast.success("已刷新 X Layer 链上全部 51 池实时数据");
    } catch (e: any) {
      toast.error(e?.message || "刷新失败");
    } finally {
      setRefreshingPools(false);
    }
  }, [mutatePools]);

  const effectiveWidthTicks = useMemo(() => {
    if (presetMode === "custom") return customWidthTicks;
    if (presetMode === "sym50") return 840; // ~8.76% 对称
    return 800; // ~8.33% 稳过 >750 ticks 与 >=8%
  }, [presetMode, customWidthTicks]);

  // 为所有池计算当前参数下的实时计划
  const computedRows = useMemo(() => {
    const pools = poolsResp?.pools || [];
    return pools.map((pool) => {
      const bias =
        presetMode === "bias95"
          ? pool.majorSide !== "none"
            ? pool.recommendedBiasPct
            : 50
          : presetMode === "bias88"
            ? pool.majorSide !== "none"
              ? 88
              : 50
            : presetMode === "sym50"
              ? 50
              : customBiasPct;
      const plan = calcPoolPlan(pool, Math.max(100, capitalUsd || 0), effectiveWidthTicks, bias);
      return { pool, plan };
    });
  }, [poolsResp, capitalUsd, presetMode, effectiveWidthTicks, customBiasPct]);

  const filteredRows = useMemo(() => {
    const q = searchText.trim().toLowerCase();
    return computedRows.filter(({ pool }) => {
      if (hideAvoid && pool.strategyGroup === "avoid" && groupFilter !== "all") return false;
      if (groupFilter === "recommended") {
        if (!["bias95", "crypto247", "corr_rwa"].includes(pool.strategyGroup)) return false;
      } else if (groupFilter !== "all") {
        if (pool.strategyGroup !== groupFilter) return false;
      }
      if (q && !pool.name.toLowerCase().includes(q) && !pool.auditNote.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [computedRows, groupFilter, hideAvoid, searchText]);

  const activeSelected = useMemo(() => {
    if (!filteredRows.length) return computedRows[0] || null;
    const hit = computedRows.find((r) => r.pool.poolAddress === selectedPoolAddr);
    return hit || filteredRows[0];
  }, [computedRows, filteredRows, selectedPoolAddr]);

  const countdownText = useMemo(() => {
    const endMs = poolsResp?.phase6EndMs || Date.parse("2026-12-01T07:00:00.000Z");
    const diff = endMs - Date.now();
    if (diff <= 0) return "第 6 期已结束（请关注第 7 期公告）";
    const days = Math.floor(diff / 86_400_000);
    const hrs = Math.floor((diff % 86_400_000) / 3_600_000);
    return `第 6 期剩余 ${days} 天 ${hrs} 小时（12/01 15:00 截止）`;
  }, [poolsResp?.phase6EndMs]);

  const copyText = (val: string, label: string) => {
    navigator.clipboard?.writeText(val);
    toast.success(`已复制 ${label}: ${val}`);
  };

  const handleAddLedgerEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    const w = pnlResp?.walletAddress || targetWallet;
    if (!w) {
      toast.error("请先填写或连接钱包地址");
      return;
    }
    const amt = Number(entryAmount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("请输入大于 0 的 USD 金额");
      return;
    }
    setSubmittingLedger(true);
    try {
      const res = await fetch("/api/okx-xlayer/pnl", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          walletAddress: w,
          entryType,
          amountUsd: amt,
          poolName: entryPoolName.trim(),
          note: entryNote.trim(),
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "保存失败");
      await mutatePnl(j.data, false);
      setEntryAmount("");
      setEntryNote("");
      toast.success("已记入真实收益台账");
    } catch (err: any) {
      toast.error(err?.message || "保存失败");
    } finally {
      setSubmittingLedger(false);
    }
  };

  const handleDeleteEntry = async (id: number) => {
    const w = pnlResp?.walletAddress || targetWallet;
    try {
      const res = await fetch(
        `/api/okx-xlayer/pnl?id=${id}&wallet=${encodeURIComponent(w)}`,
        { method: "DELETE", headers: authHeaders() }
      );
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || "删除失败");
      await mutatePnl(j.data, false);
      toast.success("已删除流水记录");
    } catch (err: any) {
      toast.error(err?.message || "删除失败");
    }
  };

  /** 链上一键平仓撤资（X Layer Uniswap V3 NPM multicall: decreaseLiquidity 100% + collect） */
  const handleOneClickRemove = async (pos: XLayerLivePosition) => {
    try {
      let walletAddr = connectedWallet;
      if (!walletAddr) {
        walletAddr = (await connect()) || null;
      }
      if (!walletAddr) {
        toast.error("请先连接钱包（推荐使用 OKX Wallet 插件）");
        return;
      }
      const okConfirm = window.confirm(
        `确认一键平仓撤出 #${pos.tokenId}（${pos.poolName}，当前估值 ${fmtUsd(pos.valueUsd)} + 待领手续费 ${fmtUsd(pos.uncollectedFeesUsd)}）？\n\n提示：撤池不影响历史已结算小时的 OKX 奖励；若需继续挖矿请先在 OKX 开好新仓再撤旧仓，避免撞上随机快照持仓为 0。`
      );
      if (!okConfirm) return;

      setRemovingTokenId(pos.tokenId);
      if (walletChainId !== XLAYER_CHAIN_ID) {
        await switchChain(XLAYER_CHAIN_ID, {
          chainName: "X Layer Mainnet",
          rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
          nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
          blockExplorerUrls: [XLAYER_EXPLORER_BASE],
        });
      }

      const eth = (window as any).ethereum;
      if (!eth) throw new Error("未检测到浏览器钱包插件");

      const calls: `0x${string}`[] = [];
      const liq = BigInt(pos.liquidity || "0");
      if (liq > 0n) {
        calls.push(
          encodeFunctionData({
            abi: NPM_REMOVE_ABI,
            functionName: "decreaseLiquidity",
            args: [
              {
                tokenId: BigInt(pos.tokenId),
                liquidity: liq,
                amount0Min: 0n,
                amount1Min: 0n,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 1200),
              },
            ],
          })
        );
      }
      calls.push(
        encodeFunctionData({
          abi: NPM_REMOVE_ABI,
          functionName: "collect",
          args: [
            {
              tokenId: BigInt(pos.tokenId),
              recipient: walletAddr as Address,
              amount0Max: MAX_UINT128,
              amount1Max: MAX_UINT128,
            },
          ],
        })
      );

      const data = encodeFunctionData({
        abi: NPM_REMOVE_ABI,
        functionName: "multicall",
        args: [calls],
      });

      const txHash: string = await eth.request({
        method: "eth_sendTransaction",
        params: [{ from: walletAddr, to: XLAYER_V3_NPM, data }],
      });
      toast.info(`已发送平仓交易 ${short(txHash)}，等待链上确认...`);
      await waitForTxReceipt(txHash, 60_000);
      toast.success(`#${pos.tokenId} 已成功平仓撤回双币与手续费！`);
      // 若本次有可观待领手续费，自动提示预填到「已领 LP 费」表单方便一键记账
      if (pos.uncollectedFeesUsd >= 0.01) {
        setEntryType("lp_fee_realized");
        setEntryAmount(pos.uncollectedFeesUsd.toFixed(2));
        setEntryPoolName(pos.poolName);
        setEntryNote(`一键平仓 #${pos.tokenId} 实收手续费`);
      }
      await mutatePnl();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "平仓交易失败");
    } finally {
      setRemovingTokenId(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* 顶部标题与规则警报条 */}
      <section className="rounded-2xl border border-white/10 bg-slate-900/70 p-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-lg font-bold text-white">OKX Boost X-Liquidity 作战台</h1>
              <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-300">
                X Layer · 51 个 V3 池全配置
              </span>
              <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-300">
                {countdownText}
              </span>
            </div>
            <p className="mt-1 text-xs text-slate-400">
              内置 95% 主流币 + 5% RWA 极端偏置计算、当前区间活跃流动性总量核算、OKX 官方申购页直达，以及跨多仓真实净收益总账（含买 RWA 成本 / IL / LP 费 / OKX 补贴）。
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setActiveTab("radar")}
              className={`rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                activeTab === "radar"
                  ? "bg-cyan-500/20 text-cyan-200 ring-1 ring-cyan-400/40"
                  : "bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
              }`}
            >
              🎯 池子雷达 & 95/5 计算器 ({poolsResp?.totalPools ?? 51})
            </button>
            <button
              onClick={() => setActiveTab("pnl")}
              className={`rounded-xl px-3.5 py-2 text-xs font-semibold transition ${
                activeTab === "pnl"
                  ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40"
                  : "bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
              }`}
            >
              📊 真实总收益台账 & 一键平仓 ({pnlResp?.activePositions?.length ?? 0} 活跃仓)
            </button>
            <button
              onClick={handleForceRefreshPools}
              disabled={refreshingPools}
              className="rounded-xl border border-white/10 bg-white/[0.04] px-3 py-2 text-xs text-slate-200 transition hover:bg-white/[0.1] disabled:opacity-50"
            >
              {refreshingPools ? "链上刷新中..." : "↻ 刷新链上"}
            </button>
          </div>
        </div>

        {/* 关键规则底线提示 */}
        <div className="mt-3 grid grid-cols-1 gap-2 text-[11px] sm:grid-cols-4">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-1.5 text-amber-200/90">
            <span className="font-semibold">宽度红线：</span>51 个 V3 池必须 <span className="font-mono font-bold">&gt;750 ticks (≥8%)</span> 且非全范围才亮 Bonus 灯
          </div>
          <div className="rounded-lg border border-cyan-500/25 bg-cyan-500/[0.06] px-3 py-1.5 text-cyan-200/90">
            <span className="font-semibold">净费口径：</span>X Layer V3 已开 25% 协议费，LP 净到手 <span className="font-mono font-bold">0.0375%</span>（下方已扣净）
          </div>
          <div className="rounded-lg border border-violet-500/25 bg-violet-500/[0.06] px-3 py-1.5 text-violet-200/90">
            <span className="font-semibold">补贴上限：</span>OKX 奖励金最高 <span className="font-mono font-bold">100% APY</span>，须从 OKX 官方页下单
          </div>
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3 py-1.5 text-emerald-200/90">
            <span className="font-semibold">防快照清零：</span>换仓请先在 OKX 开新仓再点本页一键撤旧，切忌空仓撞快照
          </div>
        </div>
      </section>

      {activeTab === "radar" ? (
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-12">
          {/* 左侧：全局参数 + 51 池筛选表 */}
          <div className="space-y-3 xl:col-span-8">
            {/* 全局参数控制栏 */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-3.5">
              <div className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400">计划投入本金 (USD)</label>
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      type="number"
                      min={100}
                      step={100}
                      value={capitalUsd}
                      onChange={(e) => setCapitalUsd(Math.max(0, Number(e.target.value) || 0))}
                      className="w-28 rounded-lg border border-white/15 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-white focus:border-cyan-400 focus:outline-none"
                    />
                    {[500, 1000, 2000, 5000].map((v) => (
                      <button
                        key={v}
                        onClick={() => setCapitalUsd(v)}
                        className={`rounded-lg px-2 py-1.5 font-mono text-[11px] transition ${
                          capitalUsd === v
                            ? "bg-cyan-500/25 text-cyan-200 ring-1 ring-cyan-400/40"
                            : "bg-white/[0.04] text-slate-400 hover:bg-white/[0.08] hover:text-white"
                        }`}
                      >
                        ${v >= 1000 ? `${v / 1000}k` : v}
                      </button>
                    ))}
                  </div>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-400">区间与偏置策略</label>
                  <div className="mt-1 flex flex-wrap gap-1.5">
                    {(
                      [
                        ["bias95", "95% 主流 + 5% RWA (800t)"],
                        ["bias88", "88% 主流 + 12% RWA (800t)"],
                        ["sym50", "50/50 对称 (840t)"],
                        ["custom", "自定义宽度/比例"],
                      ] as const
                    ).map(([k, label]) => (
                      <button
                        key={k}
                        onClick={() => setPresetMode(k)}
                        className={`rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition ${
                          presetMode === k
                            ? "bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/40"
                            : "bg-white/[0.04] text-slate-300 hover:bg-white/[0.08]"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {presetMode === "custom" && (
                  <div className="flex flex-wrap items-end gap-3 border-t border-white/5 pt-2.5 w-full">
                    <div>
                      <label className="block text-[11px] text-slate-400">
                        总宽度 (ticks，&gt;750 才享 OKX 补贴)
                      </label>
                      <div className="mt-1 flex items-center gap-2">
                        <input
                          type="number"
                          min={20}
                          max={4000}
                          step={10}
                          value={customWidthTicks}
                          onChange={(e) => setCustomWidthTicks(Math.max(20, Number(e.target.value) || 20))}
                          className="w-24 rounded-lg border border-white/15 bg-slate-950 px-2 py-1 font-mono text-xs text-white"
                        />
                        <span className="font-mono text-[11px] text-slate-400">
                          ≈ {((Math.pow(1.0001, customWidthTicks) - 1) * 100).toFixed(2)}%
                        </span>
                        {customWidthTicks <= 750 && (
                          <span className="rounded bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-rose-300">
                            ≤750t 无 OKX 补贴
                          </span>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-[11px] text-slate-400">
                        主流币占比 ({customBiasPct}% 主流 / {100 - customBiasPct}% RWA)
                      </label>
                      <input
                        type="range"
                        min={50}
                        max={97}
                        value={customBiasPct}
                        onChange={(e) => setCustomBiasPct(Number(e.target.value))}
                        className="mt-2 w-40 accent-emerald-400"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* 池子分类筛选条 */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-white/10 pt-3">
                <div className="flex flex-wrap gap-1.5">
                  {(
                    [
                      ["recommended", "⭐ 全部精选"],
                      ["bias95", "🔥 95/5 躺吃池"],
                      ["crypto247", "💎 币圈 7×24"],
                      ["corr_rwa", "📈 股-指蓝海"],
                      ["all", "全量 51 池"],
                    ] as const
                  ).map(([k, label]) => (
                    <button
                      key={k}
                      onClick={() => setGroupFilter(k)}
                      className={`rounded-lg px-2.5 py-1 text-[11px] font-medium transition ${
                        groupFilter === k
                          ? "bg-white/15 text-white"
                          : "bg-white/[0.03] text-slate-400 hover:bg-white/[0.07] hover:text-slate-200"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                  {groupFilter !== "all" && (
                    <label className="ml-2 flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-400">
                      <input
                        type="checkbox"
                        checked={hideAvoid}
                        onChange={(e) => setHideAvoid(e.target.checked)}
                        className="accent-rose-400"
                      />
                      隐藏高卷/陷阱池
                    </label>
                  )}
                </div>
                <input
                  type="text"
                  placeholder="搜索池子如 GME / MCD / MSTR / OKB..."
                  value={searchText}
                  onChange={(e) => setSearchText(e.target.value)}
                  className="w-56 rounded-lg border border-white/10 bg-slate-950/80 px-2.5 py-1 text-xs text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
                />
              </div>
            </div>

            {/* 池子实时数据表 */}
            <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-900/60">
              <div className="overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 bg-slate-950/60 text-[11px] text-slate-400">
                    <tr>
                      <th className="px-3 py-2.5">池子 / 定位</th>
                      <th className="px-2 py-2.5 text-right">真股价 / 折溢价</th>
                      <th className="px-2 py-2.5 text-right">集中度</th>
                      <th className="px-2 py-2.5 text-right">当前区间总量</th>
                      <th className="px-2 py-2.5 text-right">推荐资金</th>
                      <th className="px-2 py-2.5 text-right">你的占比</th>
                      <th className="px-2 py-2.5 text-right">预期 APR (纯LP+补贴)</th>
                      <th className="px-3 py-2.5 text-right">预期日赚 (封顶/理论)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.05]">
                    {poolsLoading ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-10 text-center text-slate-400">
                          正在连接 X Layer 主网 RPC 与 Yahoo Finance 拉取实时深度及盘前/盘后美股报价...
                        </td>
                      </tr>
                    ) : filteredRows.length === 0 ? (
                      <tr>
                        <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                          没有匹配的池子
                        </td>
                      </tr>
                    ) : (
                      filteredRows.map(({ pool, plan }) => {
                        const selected = activeSelected?.pool.poolAddress === pool.poolAddress;
                        const badge = GROUP_BADGE[pool.strategyGroup];
                        const isOverCap = capitalUsd > pool.recMaxUsd;
                        const sp = pool.spreadVsExtPct;
                        return (
                          <tr
                            key={pool.poolAddress}
                            onClick={() => setSelectedPoolAddr(pool.poolAddress)}
                            className={`cursor-pointer transition ${
                              selected
                                ? "bg-cyan-500/[0.12]"
                                : "hover:bg-white/[0.04]"
                            }`}
                          >
                            <td className="px-3 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <span className="font-semibold text-white">{pool.name}</span>
                                <span className={`rounded border px-1.5 py-0.5 text-[10px] ${badge.cls}`}>
                                  {badge.label}
                                </span>
                              </div>
                              <div className="mt-0.5 text-[10px] text-slate-400">
                                DEX {fmtPrice(pool.unwrappedDexPrice || pool.displayPrice)} {pool.displayQuoteSymbol} · TVL {fmtUsd(pool.okxTvlUsd, 0)} · OKX {fmtUsd(pool.okxDailyUsd, 0)}/d
                              </div>
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono">
                              {pool.realExtPrice !== null && sp !== null ? (
                                <div>
                                  <span
                                    className={`font-semibold ${
                                      sp <= -0.5
                                        ? "text-emerald-300"
                                        : sp >= 0.5
                                          ? "text-rose-300"
                                          : "text-slate-200"
                                    }`}
                                  >
                                    {sp >= 0 ? "+" : ""}
                                    {sp.toFixed(2)}%
                                  </span>
                                  <div className="text-[10px] text-slate-400">
                                    {pool.realExtSession === "POST"
                                      ? "盘后"
                                      : pool.realExtSession === "PRE"
                                        ? "盘前"
                                        : pool.realExtSession === "24/7"
                                          ? "现货"
                                          : "收盘"}{" "}
                                    {fmtPrice(pool.realExtPrice)}
                                  </div>
                                </div>
                              ) : (
                                <span className="text-[10px] text-slate-500">
                                  {pool.tag === "RWA" ? "Pre-IPO" : "—"}
                                </span>
                              )}
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono">
                              <span
                                className={
                                  pool.effConc <= 8
                                    ? "font-semibold text-emerald-300"
                                    : pool.effConc >= 16
                                      ? "text-rose-300"
                                      : "text-amber-300"
                                }
                              >
                                {pool.effConc.toFixed(1)}x
                              </span>
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono text-slate-200">
                              {fmtUsd(plan.depthAtWidthUsd, 0)}
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono text-[11px]">
                              <span className={isOverCap ? "text-amber-300" : "text-slate-300"}>
                                {fmtUsd(pool.recMinUsd, 0)}~{fmtUsd(pool.recMaxUsd, 0)}
                              </span>
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono">
                              <span className={plan.mySharePct > 25 ? "text-amber-300" : "text-cyan-300"}>
                                {plan.mySharePct.toFixed(2)}%
                              </span>
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono">
                              <div className="font-semibold text-emerald-300">
                                {plan.estTotalAprCappedPct.toFixed(0)}%
                                {plan.estOkxAprUncappedPct > OKX_BONUS_APY_CAP_PCT + 5 && (
                                  <span className="ml-1 text-[10px] font-normal text-slate-400">
                                    (理论 {plan.estTotalAprUncappedPct.toFixed(0)}%)
                                  </span>
                                )}
                              </div>
                              <div className="text-[10px] text-slate-400">
                                LP {plan.estLpAprPct.toFixed(0)}% + 补 {plan.estOkxAprCappedPct.toFixed(0)}%
                              </div>
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono">
                              <div className="font-semibold text-white">
                                {fmtUsd(plan.estDailyTotalCappedUsd)}/d
                              </div>
                              {plan.estDailyTotalUncappedUsd > plan.estDailyTotalCappedUsd + 0.5 && (
                                <div className="text-[10px] text-emerald-400/80">
                                  未封顶 {fmtUsd(plan.estDailyTotalUncappedUsd)}/d
                                </div>
                              )}
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* 右侧：选中池子的 95/5 偏置精准开仓计算器 & 一键直达 OKX 面板 */}
          <div className="xl:col-span-4">
            {activeSelected ? (
              <div className="sticky top-16 space-y-3 rounded-2xl border border-cyan-500/25 bg-slate-900/80 p-4 backdrop-blur">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-2">
                      <h2 className="text-base font-bold text-white">{activeSelected.pool.name}</h2>
                      <span
                        className={`rounded border px-1.5 py-0.5 text-[10px] ${
                          GROUP_BADGE[activeSelected.pool.strategyGroup].cls
                        }`}
                      >
                        {GROUP_BADGE[activeSelected.pool.strategyGroup].label}
                      </span>
                    </div>
                    <p className="mt-1 text-[11px] leading-relaxed text-slate-300">
                      {activeSelected.pool.auditNote}
                    </p>
                  </div>
                </div>

                {/* Bonus 亮灯状态校验 */}
                <div
                  className={`rounded-xl border px-3 py-2 text-xs ${
                    activeSelected.plan.bonusEligible
                      ? "border-emerald-500/35 bg-emerald-500/10 text-emerald-200"
                      : "border-rose-500/40 bg-rose-500/15 text-rose-200"
                  }`}
                >
                  {activeSelected.plan.bonusEligible ? (
                    <>
                      ✅ <strong>满足 OKX 奖励门槛</strong>：总宽{" "}
                      <span className="font-mono font-bold">
                        {activeSelected.plan.widthTicks} ticks ({activeSelected.plan.widthPct.toFixed(2)}%)
                      </span>{" "}
                      &gt; 750 ticks，粘贴到 OKX 后请确认页面奖励徽章亮起。
                    </>
                  ) : (
                    <>
                      ⚠️ <strong>未达 OKX 奖励门槛</strong>：当前仅{" "}
                      <span className="font-mono font-bold">
                        {activeSelected.plan.widthTicks} ticks ({activeSelected.plan.widthPct.toFixed(2)}%)
                      </span>
                      ，OKX 补贴将为 0（仅赚纯 LP 费）。请把宽度调回 ≥ 800 ticks。
                    </>
                  )}
                </div>

                {/* 精确下界 / 上界价格（带一键复制） */}
                <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 space-y-2.5">
                  <div className="flex items-center justify-between text-[11px] text-slate-400">
                    <span>
                      链上原股价：1 {activeSelected.pool.displayBaseSymbol.replace(/^w/, "")} ={" "}
                      <strong className="font-mono text-white">
                        {fmtPrice(activeSelected.pool.unwrappedDexPrice || activeSelected.pool.displayPrice)}{" "}
                        {activeSelected.pool.displayQuoteSymbol}
                      </strong>
                    </span>
                    <span className="font-mono text-[10px]">
                      tick {activeSelected.pool.currentTick}
                      {Math.abs((activeSelected.pool.wrapMultiplier || 1) - 1) > 0.0005 &&
                        ` · 乘数 ${activeSelected.pool.wrapMultiplier.toFixed(4)}`}
                    </span>
                  </div>

                  {/* 真实美股/港股/欧股 常规盘 & 盘前盘后价差比对 */}
                  {activeSelected.pool.realExtPrice !== null && activeSelected.pool.spreadVsExtPct !== null && (
                    <div className="rounded-lg border border-white/10 bg-slate-900/90 p-2.5 text-[11px] space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-slate-400">
                          真实股市 ({activeSelected.pool.realStockTicker})
                        </span>
                        <span
                          className={`font-mono font-bold ${
                            activeSelected.pool.spreadVsExtPct <= -0.5
                              ? "text-emerald-300"
                              : activeSelected.pool.spreadVsExtPct >= 0.5
                                ? "text-rose-300"
                                : "text-slate-200"
                          }`}
                        >
                          链上{activeSelected.pool.spreadVsExtPct >= 0 ? "溢价 +" : "折价 "}
                          {activeSelected.pool.spreadVsExtPct.toFixed(2)}%
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[10px] text-slate-300">
                        <span>
                          常规盘：{fmtPrice(activeSelected.pool.realRegularPrice || 0)}
                          {activeSelected.pool.spreadVsRegularPct !== null &&
                            ` (${activeSelected.pool.spreadVsRegularPct >= 0 ? "+" : ""}${activeSelected.pool.spreadVsRegularPct.toFixed(2)}%)`}
                        </span>
                        <span className="text-cyan-300">
                          {activeSelected.pool.realExtSession === "POST"
                            ? "盘后"
                            : activeSelected.pool.realExtSession === "PRE"
                              ? "盘前"
                              : activeSelected.pool.realExtSession === "24/7"
                                ? "现货"
                                : "最新"}
                          ：{fmtPrice(activeSelected.pool.realExtPrice)}
                          {activeSelected.pool.realExtTime ? ` (${activeSelected.pool.realExtTime})` : ""}
                        </span>
                      </div>
                      {activeSelected.pool.spreadVsExtPct <= -Math.max(0.5, activeSelected.plan.marginUpPct) && (
                        <div className="rounded bg-emerald-500/15 px-2 py-1 text-[10px] text-emerald-200">
                          ⚡ 链上折价 {Math.abs(activeSelected.pool.spreadVsExtPct).toFixed(2)}% &gt; 你的上界余量 +{activeSelected.plan.marginUpPct.toFixed(2)}%：开盘套利极易瞬间拉穿你的上界停工，建议把上界放宽！
                        </div>
                      )}
                      {activeSelected.pool.spreadVsExtPct >= 0.8 && (
                        <div className="rounded bg-rose-500/15 px-2 py-1 text-[10px] text-rose-200">
                          ⚠️ 链上溢价 +{activeSelected.pool.spreadVsExtPct.toFixed(2)}%：开盘套利可能砸盘回归，95/5 会向下多接 RWA，慎选过窄！
                        </div>
                      )}
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2">
                    <div className="rounded-lg border border-white/10 bg-slate-900 p-2.5">
                      <div className="flex items-center justify-between text-[10px] text-slate-400">
                        <span>最低价 (-{activeSelected.plan.marginDownPct.toFixed(2)}%)</span>
                        <button
                          onClick={() => copyText(fmtPrice(activeSelected.plan.displayPriceLow), "最低价")}
                          className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[10px] text-cyan-200 hover:bg-cyan-500/30"
                        >
                          📋 复制
                        </button>
                      </div>
                      <div className="mt-1 font-mono text-sm font-bold text-white">
                        {fmtPrice(activeSelected.plan.displayPriceLow)}
                      </div>
                    </div>

                    <div className="rounded-lg border border-amber-500/30 bg-slate-900 p-2.5">
                      <div className="flex items-center justify-between text-[10px] text-amber-300">
                        <span>最高价 (+{activeSelected.plan.marginUpPct.toFixed(2)}%)</span>
                        <button
                          onClick={() => copyText(fmtPrice(activeSelected.plan.displayPriceHigh), "最高价")}
                          className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] text-amber-200 hover:bg-amber-500/30"
                        >
                          📋 复制
                        </button>
                      </div>
                      <div className="mt-1 font-mono text-sm font-bold text-amber-200">
                        {fmtPrice(activeSelected.plan.displayPriceHigh)}
                      </div>
                    </div>
                  </div>

                  <div className="text-[10px] text-slate-400">
                    链上对齐 Tick：
                    <span className="font-mono text-slate-200">
                      [{activeSelected.plan.tickLower}, {activeSelected.plan.tickUpper}]
                    </span>{" "}
                    · 跨度 {activeSelected.plan.widthTicks} ticks（价格已自动按原股乘数校准）
                  </div>
                </div>

                {/* 精确双币投入配比（买多少 RWA 一目了然） */}
                <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 space-y-2">
                  <div className="text-[11px] font-semibold text-slate-300">
                    按本金 {fmtUsd(capitalUsd, 0)} 所需双币配比
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-emerald-500/10 px-2.5 py-2 text-xs">
                    <span className="text-emerald-200">
                      主流币 <strong>{activeSelected.plan.majorSymbol}</strong> ({activeSelected.plan.actualMajorPct.toFixed(1)}%)
                    </span>
                    <span className="font-mono font-bold text-white">
                      {activeSelected.plan.majorQty.toFixed(4)} ({fmtUsd(activeSelected.plan.majorUsd)})
                    </span>
                  </div>
                  <div className="flex items-center justify-between rounded-lg bg-amber-500/10 px-2.5 py-2 text-xs">
                    <span className="text-amber-200">
                      仅需买 <strong>{activeSelected.plan.otherSymbol}</strong> ({activeSelected.plan.actualOtherPct.toFixed(1)}%)
                    </span>
                    <span className="font-mono font-bold text-white">
                      {activeSelected.plan.otherQty.toFixed(4)} ({fmtUsd(activeSelected.plan.otherUsd)})
                    </span>
                  </div>
                </div>

                {/* 流动性总量、收益与边界 IL 测算 */}
                <div className="rounded-xl border border-white/10 bg-slate-950/70 p-3 space-y-1.5 text-xs">
                  <div className="flex justify-between">
                    <span className="text-slate-400">当前区间等价活跃流动性总量</span>
                    <span className="font-mono font-semibold text-white">
                      {fmtUsd(activeSelected.plan.depthAtWidthUsd, 0)} (集中 {activeSelected.pool.effConc}x)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">投入后你的活跃占比 / 推荐资金</span>
                    <span className="font-mono text-cyan-300">
                      {activeSelected.plan.mySharePct.toFixed(2)}% · 荐 {fmtUsd(activeSelected.pool.recMinUsd, 0)}~{fmtUsd(activeSelected.pool.recMaxUsd, 0)}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">预期纯 LP 净日费 (已扣25%协议费)</span>
                    <span className="font-mono text-emerald-300">
                      {fmtUsd(activeSelected.plan.estDailyLpUsd)}/d ({activeSelected.plan.estLpAprPct.toFixed(0)}%)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">预期 OKX 补贴 (100%封顶 / 理论)</span>
                    <span className="font-mono text-violet-300">
                      {fmtUsd(activeSelected.plan.estDailyOkxCappedUsd)}/d / {fmtUsd(activeSelected.plan.estDailyOkxUncappedUsd)}/d
                    </span>
                  </div>
                  <div className="flex justify-between border-t border-white/10 pt-1.5">
                    <span className="text-slate-400">触及上界 IL（全变 100% {activeSelected.plan.majorSymbol}）</span>
                    <span className="font-mono text-emerald-300">
                      {fmtUsd(activeSelected.plan.ilAtUpperUsd)} (几乎无损)
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-400">触及下界 IL（全变 100% {activeSelected.plan.otherSymbol}）</span>
                    <span className="font-mono text-amber-300">
                      {fmtUsd(activeSelected.plan.ilAtLowerUsd)}
                    </span>
                  </div>
                </div>

                {/* 一键直达 OKX 官方申购页 */}
                <a
                  href={activeSelected.pool.okxUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-emerald-500 px-4 py-2.5 text-xs font-bold text-slate-950 shadow-lg shadow-cyan-500/20 transition hover:brightness-110"
                >
                  ↗ 打开 OKX 官方申购页（100% 合规享补贴）
                </a>
                <p className="text-center text-[10px] text-slate-500">
                  在 OKX 页面粘贴上方「最低价 / 最高价」并确认奖励灯亮起即可下单；开完后切到「真实总收益台账」自动接管监控与一键平仓。
                </p>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        /* ==================== TAB 2: 多仓真实总收益台账 & 一键平仓 ==================== */
        <div className="space-y-4">
          {/* 钱包切换条 */}
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-slate-900/60 p-3.5">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-400">统计钱包（X Layer）：</span>
              <input
                type="text"
                value={walletOverride}
                onChange={(e) => setWalletOverride(e.target.value)}
                placeholder={pnlResp?.walletAddress || connectedWallet || "留空自动使用默认监控钱包 0x..."}
                className="w-80 rounded-lg border border-white/15 bg-slate-950 px-2.5 py-1.5 font-mono text-xs text-white placeholder-slate-500 focus:border-cyan-400 focus:outline-none"
              />
              <button
                onClick={() => mutatePnl()}
                className="rounded-lg border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-slate-200 hover:bg-white/[0.12]"
              >
                ↻ 重新扫链
              </button>
            </div>
            <div className="text-[11px] text-slate-400">
              当前统计地址：
              <span className="ml-1 font-mono text-cyan-300">
                {pnlResp?.walletAddress ? short(pnlResp.walletAddress) : "未设置"}
              </span>
            </div>
          </div>

          {/* 核心 4 大真实财务总账卡片 */}
          {pnlResp && (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-2xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-slate-900/90 p-4">
                <div className="text-xs text-slate-300">✅ 最终真实净赚（U 本位总计）</div>
                <div
                  className={`mt-1.5 font-mono text-2xl font-bold ${
                    pnlResp.summary.finalNetProfitUsd >= 0 ? "text-emerald-300" : "text-rose-400"
                  }`}
                >
                  {pnlResp.summary.finalNetProfitUsd >= 0 ? "+" : ""}
                  {fmtUsd(pnlResp.summary.finalNetProfitUsd)}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  {pnlResp.summary.finalRoiPct !== null
                    ? `总收益率 ${pnlResp.summary.finalRoiPct >= 0 ? "+" : ""}${pnlResp.summary.finalRoiPct}%（总入金 ${fmtUsd(pnlResp.summary.totalDepositedUsd)}）`
                    : "请在下方登记转入 X Layer 的总本金"}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <div className="text-xs text-slate-400">📉 无常损失 & 买 RWA 币价损益</div>
                <div
                  className={`mt-1.5 font-mono text-2xl font-bold ${
                    pnlResp.summary.ilAndRwaPnlUsd >= 0 ? "text-emerald-300" : "text-amber-300"
                  }`}
                >
                  {pnlResp.summary.ilAndRwaPnlUsd >= 0 ? "+" : ""}
                  {fmtUsd(pnlResp.summary.ilAndRwaPnlUsd)}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  现持仓 {fmtUsd(pnlResp.summary.currentTotalHoldingsUsd)} − 净投入 {fmtUsd(pnlResp.summary.netCapitalInvestedUsd)}
                  {pnlResp.summary.walletIdleRwaUsd > 0 && `（含残余 RWA ${fmtUsd(pnlResp.summary.walletIdleRwaUsd)}）`}
                </div>
              </div>

              <div className="rounded-2xl border border-white/10 bg-slate-900/70 p-4">
                <div className="text-xs text-slate-400">🧾 累计真实 LP 手续费</div>
                <div className="mt-1.5 font-mono text-2xl font-bold text-cyan-300">
                  +{fmtUsd(pnlResp.summary.totalLpFeesUsd)}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  在池待领 {fmtUsd(pnlResp.summary.uncollectedLpFeesUsd)} + 已领/平仓 {fmtUsd(pnlResp.summary.realizedLpFeesUsd)}
                </div>
              </div>

              <div className="rounded-2xl border border-violet-500/30 bg-slate-900/70 p-4">
                <div className="text-xs text-slate-400">🎁 累计 OKX 奖励金 (USDG)</div>
                <div className="mt-1.5 font-mono text-2xl font-bold text-violet-300">
                  +{fmtUsd(pnlResp.summary.totalOkxBonusUsd)}
                </div>
                <div className="mt-1 text-[11px] text-slate-400">
                  当前活跃仓预估合计日产 {fmtUsd(pnlResp.summary.estActiveDailyTotalUsd)}/天
                </div>
              </div>
            </div>
          )}

          {/* 活跃 X Layer V3 仓位列表（带一键平仓） */}
          <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-white">
                链上活跃 X Layer Uniswap V3 仓位（自动扫链 · 支持一键平仓）
              </h2>
              <span className="text-[11px] text-slate-400">
                {pnlLoading
                  ? "扫描中..."
                  : `活跃 ${pnlResp?.activePositions.length ?? 0} 个 · 已平仓 ${pnlResp?.closedTokenIds.length ?? 0} 个`}
              </span>
            </div>

            {!pnlResp || pnlResp.activePositions.length === 0 ? (
              <div className="mt-3 rounded-xl border border-dashed border-white/10 py-6 text-center text-xs text-slate-400">
                当前钱包在 X Layer 暂无活跃 Uniswap V3 LP 仓位；在 OKX 申购完成后点击上方「重新扫链」即自动出现。
              </div>
            ) : (
              <div className="mt-3 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-white/10 text-[11px] text-slate-400">
                    <tr>
                      <th className="py-2 pr-3">仓位 / 状态</th>
                      <th className="px-2 py-2">Bonus 资格</th>
                      <th className="px-2 py-2 text-right">距下界 / 距上界</th>
                      <th className="px-2 py-2 text-right">双币持仓价值</th>
                      <th className="px-2 py-2 text-right">待领净 LP 费</th>
                      <th className="px-2 py-2 text-right">预估日产 (费+补)</th>
                      <th className="py-2 pl-3 text-right">操作</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.06]">
                    {pnlResp.activePositions.map((pos) => (
                      <tr key={pos.tokenId}>
                        <td className="py-2.5 pr-3">
                          <div className="flex items-center gap-1.5">
                            <span className="font-semibold text-white">{pos.poolName}</span>
                            <span className="font-mono text-[10px] text-slate-400">#{pos.tokenId}</span>
                            <span
                              className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
                                pos.inRange
                                  ? "bg-emerald-500/15 text-emerald-300"
                                  : "bg-rose-500/20 text-rose-300"
                              }`}
                            >
                              {pos.inRange ? "在区间" : "已越界"}
                            </span>
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-slate-400">
                            {pos.amount0.toFixed(4)} {pos.token0Symbol} + {pos.amount1.toFixed(4)} {pos.token1Symbol}
                          </div>
                        </td>
                        <td className="px-2 py-2.5 text-[11px]">
                          {pos.bonusEligible ? (
                            <span className="text-emerald-300">✅ {pos.tickWidth}t 合规</span>
                          ) : (
                            <span className="text-rose-300">❌ {pos.tickWidth}t ≤750</span>
                          )}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-[11px]">
                          <span className="text-slate-300">-{pos.marginLowerPct.toFixed(2)}%</span>
                          <span className="mx-1 text-slate-600">/</span>
                          <span className={pos.marginUpperPct < 0.5 ? "font-bold text-amber-300" : "text-slate-300"}>
                            +{pos.marginUpperPct.toFixed(2)}%
                          </span>
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono font-semibold text-white">
                          {fmtUsd(pos.valueUsd)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-cyan-300">
                          {fmtUsd(pos.uncollectedFeesUsd)}
                        </td>
                        <td className="px-2 py-2.5 text-right font-mono text-emerald-300">
                          {fmtUsd(pos.estDailyLpFeeUsd + pos.estDailyOkxBonusUsd)}/d
                        </td>
                        <td className="py-2.5 pl-3 text-right">
                          <div className="flex justify-end gap-1.5">
                            <a
                              href={pos.okxUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded-lg border border-white/10 bg-white/[0.05] px-2 py-1 text-[11px] text-slate-200 hover:bg-white/[0.1]"
                            >
                              OKX页
                            </a>
                            <button
                              onClick={() => handleOneClickRemove(pos)}
                              disabled={removingTokenId === pos.tokenId}
                              className="rounded-lg border border-rose-500/40 bg-rose-500/15 px-2.5 py-1 text-[11px] font-semibold text-rose-200 transition hover:bg-rose-500/25 disabled:opacity-50"
                            >
                              {removingTokenId === pos.tokenId ? "撤池中..." : "一键平仓"}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* 下方双栏：左=钱包滞留 RWA/主流币明细；右=资金/买RWA/补贴流水记账 */}
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
            {/* 钱包滞留资产 */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 lg:col-span-5">
              <h3 className="text-sm font-bold text-white">
                X Layer 钱包滞留资产（自动计入总持仓：{fmtUsd(pnlResp?.summary.walletIdleHoldingsUsd ?? 0)}）
              </h3>
              <p className="mt-0.5 text-[11px] text-slate-400">
                包含未入池的主流币及买 RWA 剩下的零头/平仓回笼的 RWA 残币，确保无常损失统计一分不漏。
              </p>
              <div className="mt-3 space-y-1.5">
                {!pnlResp || pnlResp.walletAssets.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-500">暂无大于 $0.50 的滞留余额</div>
                ) : (
                  pnlResp.walletAssets.map((a) => (
                    <div
                      key={a.address}
                      className="flex items-center justify-between rounded-lg bg-slate-950/60 px-3 py-2 text-xs"
                    >
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-white">{a.symbol}</span>
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] ${
                            a.isMajor
                              ? "bg-sky-500/15 text-sky-300"
                              : "bg-amber-500/15 text-amber-300"
                          }`}
                        >
                          {a.isMajor ? "主流币" : "RWA 残币"}
                        </span>
                      </div>
                      <div className="text-right font-mono">
                        <span className="text-white">{fmtUsd(a.valueUsd)}</span>
                        <span className="ml-2 text-[10px] text-slate-400">({a.balance.toFixed(4)})</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {/* 资金与 OKX 补贴流水台账 */}
            <div className="rounded-2xl border border-white/10 bg-slate-900/60 p-4 lg:col-span-7">
              <h3 className="text-sm font-bold text-white">活动总账流水（入金 / 买 RWA 成本 / 已领 LP 费 / OKX 补贴）</h3>
              <form onSubmit={handleAddLedgerEntry} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-12">
                <select
                  value={entryType}
                  onChange={(e) => setEntryType(e.target.value as OkxLedgerEntryType)}
                  className="rounded-lg border border-white/15 bg-slate-950 px-2.5 py-2 text-xs text-white sm:col-span-4"
                >
                  <option value="deposit">转入本金 (入金 USD)</option>
                  <option value="rwa_buy_cost">主动买 RWA 成本 (USD)</option>
                  <option value="okx_bonus">OKX 奖励金 (USDG)</option>
                  <option value="lp_fee_realized">已领/平仓 LP 费 (USD)</option>
                  <option value="withdraw">提现回笼 (出金 USD)</option>
                </select>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="金额 (USD)"
                  value={entryAmount}
                  onChange={(e) => setEntryAmount(e.target.value)}
                  className="rounded-lg border border-white/15 bg-slate-950 px-2.5 py-2 font-mono text-xs text-white sm:col-span-3"
                />
                <input
                  type="text"
                  placeholder="备注（如 GMEx 95/5 / 领第6期）"
                  value={entryNote}
                  onChange={(e) => setEntryNote(e.target.value)}
                  className="rounded-lg border border-white/15 bg-slate-950 px-2.5 py-2 text-xs text-white sm:col-span-3"
                />
                <button
                  type="submit"
                  disabled={submittingLedger}
                  className="rounded-lg bg-emerald-500/20 px-3 py-2 text-xs font-semibold text-emerald-200 ring-1 ring-emerald-400/40 transition hover:bg-emerald-500/30 disabled:opacity-50 sm:col-span-2"
                >
                  {submittingLedger ? "保存中" : "+ 记一笔"}
                </button>
              </form>

              <div className="mt-3 max-h-64 space-y-1.5 overflow-y-auto">
                {!pnlResp || pnlResp.entries.length === 0 ? (
                  <div className="py-6 text-center text-xs text-slate-500">
                    暂无台账流水。建议在往 X Layer 转入资金时先记一笔「转入本金」，领到 OKX USDG 补贴时记一笔「OKX 奖励金」，系统会自动扣除买 RWA 和无常损失算出最终净赚。
                  </div>
                ) : (
                  pnlResp.entries.map((e) => {
                    const meta = LEDGER_LABELS[e.entryType] || LEDGER_LABELS.deposit;
                    return (
                      <div
                        key={e.id}
                        className="flex items-center justify-between rounded-lg bg-slate-950/60 px-3 py-2 text-xs"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${meta.badge}`}>
                            {meta.label}
                          </span>
                          {e.poolName && <span className="font-medium text-slate-200">{e.poolName}</span>}
                          {e.note && <span className="text-slate-400">{e.note}</span>}
                          <span className="font-mono text-[10px] text-slate-500">{e.occurredAt.slice(0, 16)}</span>
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-semibold text-white">
                            {meta.sign}
                            {fmtUsd(e.amountUsd)}
                          </span>
                          <button
                            onClick={() => handleDeleteEntry(e.id)}
                            className="text-[11px] text-slate-500 hover:text-rose-400"
                            title="删除"
                          >
                            ✕
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
