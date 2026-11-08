"use client";
import { useState, useEffect, useRef, useMemo } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, timeAgo, fmtFull, fmtTokenAmount } from "@/components/util";
import { SwapQuoteSection } from "@/components/swap-quote-section";
import { useWallet } from "@/lib/wallet/use-wallet";
import { LiquidityButton } from "@/components/liquidity-button";
import { LiquidityProbe } from "@/components/liquidity-probe";
import { RemovePositionButton } from "@/components/remove-position-button";
import { Field } from "@/components/form";
import { tickToSqrtPriceX96, getAmountsForLiquidity } from "@/lib/v3/math";
import { useBinanceRealtime, type UseBinanceRealtimeReturn } from "@/lib/cex/use-binance-ws";

/** 推送冷却可选值（分钟） */
const COOLDOWN_OPTIONS = [0, 2, 5, 10, 20, 30, 60];

/** 将常见的 cron 表达式转为人类可读标签 */
function cronToLabel(cron: string): string {
  const m = cron.trim();
  const sixStarSlash = m.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*\s+\*$/);
  if (sixStarSlash) {
    const n = Number(sixStarSlash[1]);
    if (n < 60) return `${n} 秒`;
    if (n % 60 === 0)
      return n % 3600 === 0 ? `${n / 3600} 小时` : `${n / 60} 分钟`;
    return `${n} 秒`;
  }
  const starSlash = m.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (starSlash) {
    const n = Number(starSlash[1]);
    if (n >= 60) return `${Math.round(n / 60)} 小时`;
    return `${n} 分钟`;
  }
  if (m === "0 * * * *") return "1 小时";
  return m;
}

interface Position {
  id: number;
  dex_name: string;
  dex_display_name?: string;
  dex_npm?: string;
  dex_id?: number;
  token_id: string;
  token0: string;
  token1: string;
  token0_symbol?: string;
  token1_symbol?: string;
  fee: number;
  pool: string;
  tick_lower: number;
  tick_upper: number;
  last_current_tick: number;
  last_in_range: number;
  last_price0: string;
  last_liquidity?: string;
  last_checked_at: string;
  notify_state: string;
  source: string;
  staker_contract: string;
  available_staker_contract?: string;
  available_staker_label?: string;
  chain_id_ref: number;
  chain_name: string;
  chain_key: string;
  chain_id: number;
  chain_rpc_urls?: string;
  chain_symbol?: string;
  explorer_url: string;
  wallet_label: string;
  wallet_address: string;
  last_alert_type?: string;
  last_cex_price?: string;
  pair_flip?: number;
  cex_alert_muted?: number;
}

interface MonitorState {
  combinedRunning: boolean;
  fullRunning: boolean;
  combinedCron: string;
  fullCron: string;
  lastCombined: any;
  lastFull: any;
  stakingSecurity?: {
    status: "safe" | "warn" | "danger";
    checkedContracts: number;
    simulatedPositions: number;
    anomalies: {
      id: string;
      severity: "critical" | "warn";
      type: string;
      contract: string;
      pairLabel: string;
      chainName: string;
      tokenId?: string;
      title: string;
      detail: string;
      detectedAt: string;
    }[];
    contracts: {
      id: number;
      chainIdRef: number;
      chainName: string;
      platform: string;
      pairLabel: string;
      contract: string;
      symbol: string;
      poolFee: number;
      owner: string;
      baselineOwner: string;
      feeRecipient: string;
      baselineFeeRecipient: string;
      paused: boolean;
      withdrawPaused: boolean;
      totalStakedCount: number;
      totalSupply: string;
      userStakedPositionsSimOk: number;
      userStakedPositionsSimFailed: number;
      status: "safe" | "warn" | "danger";
    }[];
    checkedAt: string;
    durationMs: number;
    highFreqPushActive: boolean;
    muted: boolean;
    pushCount: number;
    lastPushAt: string | null;
  } | null;
  merklRewards?: MerklRewardsSummary | null;
}

export interface PositionRewardEstimate {
  positionId?: number;
  tokenId: string;
  pool: string;
  vault: string;
  pairLabel: string;
  inRange: boolean;
  positionUsd: number;
  symbol0?: string;
  symbol1?: string;
  amount0Human?: number;
  amount1Human?: number;
  amount0Usd?: number;
  amount1Usd?: number;
  activeLShare: number;
  token0Share: number;
  token1Share: number;
  rewardShare: number;
  dailyActiveLUsd?: number;
  dailyToken0Usd?: number;
  dailyToken1Usd?: number;
  poolDailyW0g: number;
  poolHourlyW0g: number;
  hourlyW0g: number;
  hourlyUsd: number;
  dailyW0g: number;
  dailyUsd: number;
  aprPct: number;
  potentialDailyW0g: number;
  potentialDailyUsd: number;
  potentialAprPct: number;
  rebalanceSwapUsd?: number;
  rebalanceFeeUsd?: number;
  hourlyGainUsd?: number;
  breakevenHours?: number | null;
}

export interface PoolRewardRadarItem {
  key: string;
  pairLabel: string;
  chainIdRef: number;
  pool: string;
  vault: string;
  token0?: string;
  token1?: string;
  symbol0?: string;
  symbol1?: string;
  decimals0?: number;
  decimals1?: number;
  token0PriceUsd?: number;
  token1PriceUsd?: number;
  fee: number;
  tickSpacing: number;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  subTickMarginLowerPct: number;
  subTickMarginUpperPct: number;
  subTickMinMarginPct: number;
  dailyW0g: number;
  hourlyW0g: number;
  dailyRewardUsd: number;
  dailyActiveLUsd?: number;
  dailyToken0Usd?: number;
  dailyToken1Usd?: number;
  totalActiveL?: string;
  stakedToken0Human?: number;
  stakedToken1Human?: number;
  stakedToken0Usd?: number;
  stakedToken1Usd?: number;
  token0BucketAprPct?: number;
  token1BucketAprPct?: number;
  stakedTvlUsd: number;
  narrowStakedTvlUsd: number;
  narrowPositionCount: number;
  totalStakedCount: number;
  sim1000ActiveLShare: number;
  sim1000RewardShare: number;
  sim1000HourlyW0g: number;
  sim1000HourlyUsd: number;
  sim1000DailyW0g: number;
  sim1000DailyUsd: number;
  sim1000AprPct: number;
  isHighApr: boolean;
}

export interface MerklRewardsSummary {
  checkedAt: string;
  durationMs: number;
  chainIdRef: number | null;
  w0gPriceUsd: number;
  w0gPriceSource: string;
  epochStartIso: string;
  epochEndIso: string;
  epochRemainingHours: number;
  totalDailyW0g: number;
  totalDailyUsd: number;
  userTotalStakedUsd: number;
  userTotalHourlyW0g: number;
  userTotalHourlyUsd: number;
  userTotalDailyW0g: number;
  userTotalDailyUsd: number;
  userWeightedAprPct: number;
  positions: Record<string, PositionRewardEstimate>;
  pools: PoolRewardRadarItem[];
  highAprAlertEnabled: boolean;
  highAprThresholdPct: number;
  highAprPoolsCount: number;
  alertsSent: number;
}

function inferTokenDecimals(tokenAddr: string, symbol?: string): number {
  const addr = (tokenAddr || "").toLowerCase();
  const sym = (symbol || "").toUpperCase();
  if (
    addr === "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e" ||
    addr === "0x1217bfe6c773eec6cc4a38b5dc45b92292b6e189" ||
    sym.includes("USDC") ||
    sym.includes("USDT")
  ) {
    return 6;
  }
  if (addr === "0x0555e30da8f98308edb960aa94c0db47230d2b9c" || sym.includes("BTC")) {
    return 8;
  }
  if (addr === "0x2b269f9deb4804c5a4bd97e4d951c775beaa0cc5" || sym === "SOL" || sym === "WSOL") {
    return 9;
  }
  return 18;
}

export interface PositionHoldingsInfo {
  sym0: string;
  sym1: string;
  amt0: number;
  amt1: number;
  usd0: number;
  usd1: number;
  totalUsd: number;
  pct0: number;
  pct1: number;
  isSingleSided: boolean;
}

function computePositionHoldings(
  p: Position,
  rewardEst?: PositionRewardEstimate,
  binanceRt?: UseBinanceRealtimeReturn,
  fallbackW0gUsd?: number
): PositionHoldingsInfo | null {
  const sym0 = p.token0_symbol || rewardEst?.symbol0 || short(p.token0);
  const sym1 = p.token1_symbol || rewardEst?.symbol1 || short(p.token1);

  let amt0 = rewardEst?.amount0Human;
  let amt1 = rewardEst?.amount1Human;

  if (
    (amt0 === undefined || amt1 === undefined) &&
    p.last_liquidity &&
    /^\d+$/.test(p.last_liquidity) &&
    BigInt(p.last_liquidity) > 0n
  ) {
    try {
      const dec0 = inferTokenDecimals(p.token0, sym0);
      const dec1 = inferTokenDecimals(p.token1, sym1);
      const sqrtCurrent = tickToSqrtPriceX96(p.last_current_tick);
      const sqrtA = tickToSqrtPriceX96(p.tick_lower);
      const sqrtB = tickToSqrtPriceX96(p.tick_upper);
      const res = getAmountsForLiquidity(
        sqrtCurrent,
        sqrtA,
        sqrtB,
        BigInt(p.last_liquidity),
        dec0,
        dec1
      );
      amt0 = Number(res.amount0) || 0;
      amt1 = Number(res.amount1) || 0;
    } catch {
      // ignore
    }
  }

  if (amt0 === undefined || amt1 === undefined) return null;

  let p0Usd = binanceRt?.getTokenUsdPrice(p.chain_id_ref, p.token0, sym0) ?? null;
  let p1Usd = binanceRt?.getTokenUsdPrice(p.chain_id_ref, p.token1, sym1) ?? null;

  if ((!p0Usd || p0Usd <= 0) && sym0.toUpperCase().includes("0G") && fallbackW0gUsd) {
    p0Usd = fallbackW0gUsd;
  }
  if ((!p1Usd || p1Usd <= 0) && sym1.toUpperCase().includes("0G") && fallbackW0gUsd) {
    p1Usd = fallbackW0gUsd;
  }

  const dexPrice0 = Number(p.last_price0);
  if ((!p0Usd || p0Usd <= 0) && p1Usd && p1Usd > 0 && Number.isFinite(dexPrice0) && dexPrice0 > 0) {
    p0Usd = dexPrice0 * p1Usd;
  } else if ((!p1Usd || p1Usd <= 0) && p0Usd && p0Usd > 0 && Number.isFinite(dexPrice0) && dexPrice0 > 0) {
    p1Usd = p0Usd / dexPrice0;
  }

  const usd0 = p0Usd && p0Usd > 0 ? amt0 * p0Usd : rewardEst?.amount0Usd ?? 0;
  const usd1 = p1Usd && p1Usd > 0 ? amt1 * p1Usd : rewardEst?.amount1Usd ?? 0;
  const totalUsd = usd0 + usd1 > 0 ? usd0 + usd1 : rewardEst?.positionUsd ?? 0;
  const pct0 = totalUsd > 0 ? (usd0 / totalUsd) * 100 : amt0 > 0 && amt1 === 0 ? 100 : 0;
  const pct1 = totalUsd > 0 ? (usd1 / totalUsd) * 100 : amt1 > 0 && amt0 === 0 ? 100 : 0;
  const isSingleSided = (amt0 <= 1e-9 && amt1 > 0) || (amt1 <= 1e-9 && amt0 > 0);

  return {
    sym0,
    sym1,
    amt0,
    amt1,
    usd0,
    usd1,
    totalUsd,
    pct0,
    pct1,
    isSingleSided,
  };
}

export default function DashboardPage() {
  const binanceRt = useBinanceRealtime();
  const { data: positions, mutate: reloadActivePos } = useSWR<Position[]>(
    "/api/positions",
    fetcher,
    { refreshInterval: 60_000 }
  );
  const { data: closedPositions, mutate: reloadClosedPos } = useSWR<Position[]>(
    "/api/positions?state=closed",
    fetcher,
    { refreshInterval: 120_000, revalidateOnFocus: false }
  );
  function reloadPos() {
    reloadActivePos();
    reloadClosedPos();
  }
  const { data: mon, mutate: reloadMon } = useSWR<MonitorState>(
    "/api/monitor",
    fetcher,
    { refreshInterval: 10_000 }
  );
  const { data: merklDirect, mutate: reloadMerkl } = useSWR<MerklRewardsSummary>(
    "/api/merkl-rewards",
    fetcher,
    { refreshInterval: 30_000 }
  );

  const list = positions ?? [];
  const outOfRange = list.filter((p) => p.last_in_range === 0);
  const closed = closedPositions ?? [];
  const [showClosed, setShowClosed] = useState(false);
  const [showScanSettings, setShowScanSettings] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);
  const [showSecurityDrawer, setShowSecurityDrawer] = useState(false);
  const [secActionBusy, setSecActionBusy] = useState(false);
  const [showMerklDrawer, setShowMerklDrawer] = useState(false);
  const [merklBusy, setMerklBusy] = useState(false);
  const [aprThreshInput, setAprThreshInput] = useState<string>("");

  const sec: MonitorState["stakingSecurity"] =
    mon?.stakingSecurity ?? mon?.lastCombined?.stakingSecurity ?? null;
  const secAnomalies = sec?.anomalies ?? [];
  const hasSecAnomaly = secAnomalies.length > 0;

  const merkl: MerklRewardsSummary | null =
    merklDirect ?? mon?.merklRewards ?? mon?.lastCombined?.merklRewards ?? null;

  useEffect(() => {
    if (merkl && !aprThreshInput) {
      setAprThreshInput(String(merkl.highAprThresholdPct || 800));
    }
  }, [merkl, aprThreshInput]);

  async function runMerklAction(
    action: "scan" | "update_settings" | "test_alert",
    payload?: { highAprAlertEnabled?: boolean; highAprThresholdPct?: number }
  ) {
    setMerklBusy(true);
    try {
      const r = await fetch("/api/merkl-rewards", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action, ...payload }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert(j.error || "操作失败");
      } else if (action === "test_alert") {
        alert("✅ 已向 Bark / 已配置渠道发送高 APR 机会测试推送！");
      }
      reloadMerkl();
      reloadMon();
    } finally {
      setMerklBusy(false);
    }
  }

  async function runSecurityAction(action: "scan" | "mute" | "unmute" | "accept_baseline" | "test_alarm") {
    setSecActionBusy(true);
    try {
      const r = await fetch("/api/staking-security", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ action }),
      });
      const j = await r.json();
      if (!j.ok) {
        alert(j.error || "操作失败");
      } else if (action === "test_alarm") {
        alert("✅ 已向 Bark / 已配置渠道发送紧急强提醒测试消息！");
      }
      reloadMon();
    } finally {
      setSecActionBusy(false);
    }
  }

  // 从仓位卡片触发「撤池并重开」时，同步传给右侧三段式工作台并滚动过去
  const [externalPool, setExternalPool] = useState<{
    chainId: number;
    pool: string;
    ts: number;
  } | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);

  function handleReopenPool(chainId: number, pool: string) {
    setExternalPool({ chainId, pool, ts: Date.now() });
    probeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function triggerUnifiedScan() {
    const r = await fetch("/api/monitor", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: "combined" }),
    });
    const j = await r.json();
    if (!j.ok) alert(j.error);
    reloadPos();
    reloadMon();
    reloadMerkl();
    setTimeout(() => {
      reloadPos();
      reloadMon();
      reloadMerkl();
    }, 3_000);
    setTimeout(() => {
      reloadPos();
      reloadMon();
      reloadMerkl();
    }, 8_000);
  }

  const isScanning = !!(mon?.combinedRunning || mon?.fullRunning);
  const lastScanDuration = mon?.lastCombined?.durationMs
    ? ` (${(mon.lastCombined.durationMs / 1000).toFixed(1)}s)`
    : "";

  return (
    <div className="space-y-4">
      {/* 顶部极速状态控制条（单一极速扫描模式 + 质押合约安全异动哨兵 + Merkl 奖励与高 APR 雷达） */}
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-4">
          <Stat label="监控仓位" value={list.length} />
          <Stat
            label="越界"
            value={outOfRange.length}
            danger={outOfRange.length > 0}
          />
          <div className="text-xs sm:text-sm text-ink-soft">
            <span>极速扫描：</span>
            <span className="text-ink font-medium">
              {mon?.combinedCron ? cronToLabel(mon.combinedCron) : "—"}
            </span>
            {isScanning ? (
              <span className="ml-2 text-cyan-300 font-medium">⚡ 扫描中…</span>
            ) : (
              <span className="ml-1">
                · 上次 {timeAgo(mon?.lastCombined?.startedAt)}
                <span className="font-mono text-ink-muted">
                  {lastScanDuration}
                </span>
              </span>
            )}
          </div>

          {/* 顶部质押合约安全异动小提示（绿色小圆点 = 安全；红色脉冲 = 发现异动） */}
          <button
            type="button"
            onClick={() => setShowSecurityDrawer((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
              hasSecAnomaly
                ? "border-danger bg-danger/20 text-danger animate-pulse shadow-[0_0_12px_rgba(244,63,94,0.4)]"
                : "border-emerald-500/35 bg-emerald-500/10 text-emerald-300 hover:bg-emerald-500/15"
            }`}
            title="点击查看 ZIA 质押合约安全状态（提取锁死开关 / withdraw 解押静态预演 / 管理员变更 / TVL 异动）"
          >
            <span
              className={`inline-block h-2.5 w-2.5 rounded-full ${
                hasSecAnomaly
                  ? "bg-danger shadow-[0_0_8px_#f43f5e]"
                  : "bg-emerald-400 shadow-[0_0_8px_#34d399]"
              }`}
            />
            {hasSecAnomaly ? (
              <span>
                🚨 质押异动报警 ({secAnomalies.length})
                {sec?.highFreqPushActive ? " · 高频推送中" : sec?.muted ? " · 已静音" : ""}
              </span>
            ) : (
              <span>
                质押安全
                {sec && sec.checkedContracts > 0
                  ? ` · ${sec.checkedContracts}池正常`
                  : ""}
                {sec && sec.simulatedPositions > 0
                  ? ` · ${sec.simulatedPositions}仓解押预演通过`
                  : ""}
              </span>
            )}
            <span className="text-[10px] opacity-75">
              {showSecurityDrawer ? "▲" : "▼"}
            </span>
          </button>

          {/* 顶部 Merkl 质押总奖励 & 高 APR 猎手雷达胶囊 */}
          <button
            type="button"
            onClick={() => setShowMerklDrawer((v) => !v)}
            className={`inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition ${
              merkl && merkl.highAprPoolsCount > 0
                ? "border-amber-400/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                : "border-cyan-500/35 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/20"
            }`}
            title="点击展开 ZIA Merkl 质押奖励实时精算 & 全池高 APR 机会猎手雷达"
          >
            <span>
              🎁 质押产出:{" "}
              {merkl ? (
                <span className="font-mono font-semibold text-white">
                  ${merkl.userTotalHourlyUsd.toFixed(2)}/h · $
                  {merkl.userTotalDailyUsd.toFixed(1)}/d ({merkl.userTotalDailyW0g.toFixed(0)} W0G)
                </span>
              ) : (
                "测算中…"
              )}
            </span>
            {merkl && merkl.pools.length > 0 && (
              <span className="rounded bg-amber-500/25 px-1.5 py-0.5 font-mono text-[11px] text-amber-200 border border-amber-400/30">
                🔥 最高池 {merkl.pools[0].pairLabel.split(" ")[0]}{" "}
                {merkl.pools[0].sim1000AprPct.toFixed(0)}% APR
              </span>
            )}
            <span className="text-[10px] opacity-75">
              {showMerklDrawer ? "▲" : "▼"}
            </span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setShowScanSettings((v) => !v)}
          >
            ⚙️ {showScanSettings ? "收起设置 ▲" : "频率与告警设置"}
          </button>
          <button
            type="button"
            className="btn-primary text-xs px-4"
            disabled={isScanning}
            onClick={triggerUnifiedScan}
            title="增量区块游标 + 质押合约活跃枚举 + 8 路并发读取，单次 2~4 秒完成全量同步"
          >
            {isScanning ? "⚡ 扫描中…" : "⚡ 立即扫描"}
          </button>
        </div>
      </div>

      {/* 当发现质押异动时自动强制展开红色异动告警面板；平时点击顶部绿色小圆点可按需展开详情 */}
      {(hasSecAnomaly || showSecurityDrawer) && (
        <div
          className={`card p-4 space-y-3 border ${
            hasSecAnomaly
              ? "border-danger/70 bg-danger/10"
              : "border-emerald-500/30 bg-surface-1/90"
          }`}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-2.5 w-2.5 rounded-full ${
                  hasSecAnomaly
                    ? "bg-danger shadow-[0_0_8px_#f43f5e]"
                    : "bg-emerald-400 shadow-[0_0_8px_#34d399]"
                }`}
              />
              <span className="text-sm font-semibold text-ink">
                {hasSecAnomaly
                  ? `🚨 ZIA 质押合约发现 ${secAnomalies.length} 项安全异动！`
                  : "🛡️ ZIA 质押合约安全哨兵（全部合约状态正常）"}
              </span>
              {sec?.checkedAt && (
                <span className="text-xs text-ink-muted">
                  · 检测于 {timeAgo(sec.checkedAt)} ({sec.durationMs}ms)
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {hasSecAnomaly && (
                <>
                  {sec?.muted ? (
                    <button
                      type="button"
                      disabled={secActionBusy}
                      onClick={() => runSecurityAction("unmute")}
                      className="btn-ghost btn-xs border border-amber-400/50 text-amber-300"
                    >
                      🔔 恢复高频报警推送
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={secActionBusy}
                      onClick={() => runSecurityAction("mute")}
                      className="btn-ghost btn-xs border border-danger/60 text-danger hover:bg-danger/20"
                    >
                      🔕 已知晓（暂停 20s 连环推送）
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={secActionBusy}
                    onClick={() => runSecurityAction("accept_baseline")}
                    className="btn-ghost btn-xs"
                    title="若确认是官方正常更换管理员或手续费地址，可点击设为新安全基线"
                  >
                    ✅ 设为新基线
                  </button>
                </>
              )}
              <button
                type="button"
                disabled={secActionBusy}
                onClick={() => runSecurityAction("scan")}
                className="btn-ghost btn-xs"
              >
                {secActionBusy ? "⏳ 检查中…" : "⚡ 立即安检"}
              </button>
              <button
                type="button"
                disabled={secActionBusy}
                onClick={() => runSecurityAction("test_alarm")}
                className="btn-ghost btn-xs"
                title="向 Bark 发送一条 level=critical + call=1 紧急响铃测试"
              >
                🔔 测试报警推送
              </button>
              {!hasSecAnomaly && (
                <button
                  type="button"
                  onClick={() => setShowSecurityDrawer(false)}
                  className="btn-ghost btn-xs"
                >
                  收起 ▲
                </button>
              )}
            </div>
          </div>

          {/* 异动详情列表 */}
          {hasSecAnomaly && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-danger/40 bg-danger/15 px-3 py-2 text-xs text-danger">
                <span>
                  {sec?.highFreqPushActive
                    ? `🔊 高频 Bark 强提醒推送进行中（每 20 秒 1 次，已连续推送 ${sec.pushCount} 次）`
                    : sec?.muted
                    ? "🔇 当前异动已手动静音，后台仍每 30 秒持续追踪链上状态"
                    : `⚡ 已触发异动报警（已推送 ${sec?.pushCount ?? 1} 次）`}
                </span>
                <span className="font-mono text-[11px]">
                  建议立即检查下方质押中仓位并尝试「仅解押到钱包」或「解押并撤池」！
                </span>
              </div>
              <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
                {secAnomalies.map((a) => (
                  <div
                    key={a.id}
                    className="rounded-lg border border-danger/50 bg-surface-0/90 p-3 text-xs space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-danger">
                        {a.severity === "critical" ? "🚨 极高危" : "⚠️ 预警"} ·{" "}
                        {a.pairLabel}
                      </span>
                      <span className="font-mono text-[11px] text-ink-muted">
                        {short(a.contract)}
                      </span>
                    </div>
                    <div className="font-medium text-ink">{a.title}</div>
                    <div className="text-ink-soft">{a.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 质押合约安全体检明细表 */}
          {showSecurityDrawer && sec && sec.contracts.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border/60 bg-surface-0/60">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border/60 bg-surface-2/60 text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">质押池 (费率)</th>
                    <th className="px-3 py-2">合约 / 凭证</th>
                    <th className="px-3 py-2">提取开关 (0x054f7d9c)</th>
                    <th className="px-3 py-2">存入开关 (paused)</th>
                    <th className="px-3 py-2">管理员 (owner)</th>
                    <th className="px-3 py-2">池内质押 NFT</th>
                    <th className="px-3 py-2">我的仓位解押预演</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {sec.contracts.map((c) => (
                    <tr key={c.id} className="hover:bg-surface-2/30">
                      <td className="px-3 py-2 font-medium text-ink">
                        {c.pairLabel}{" "}
                        {c.poolFee ? (
                          <span className="text-[11px] text-cyan-300">
                            ({c.poolFee / 10000}%)
                          </span>
                        ) : null}
                      </td>
                      <td className="px-3 py-2 font-mono text-ink-soft">
                        {short(c.contract)}{" "}
                        <span className="text-ink-muted">({c.symbol})</span>
                      </td>
                      <td className="px-3 py-2">
                        {c.withdrawPaused ? (
                          <span className="text-danger font-semibold">
                            🔒 禁止提取
                          </span>
                        ) : (
                          <span className="text-emerald-400">🟢 正常可提</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {c.paused ? (
                          <span className="text-amber-300 font-semibold">
                            ⏸️ 暂停存入
                          </span>
                        ) : (
                          <span className="text-emerald-400">🟢 正常可存</span>
                        )}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span
                          className={
                            c.owner !== c.baselineOwner
                              ? "text-danger font-semibold"
                              : "text-ink-soft"
                          }
                        >
                          {short(c.owner)}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-ink">
                        {c.totalStakedCount} 个
                      </td>
                      <td className="px-3 py-2">
                        {c.userStakedPositionsSimFailed > 0 ? (
                          <span className="text-danger font-semibold">
                            ❌ {c.userStakedPositionsSimFailed} 仓 Revert
                          </span>
                        ) : c.userStakedPositionsSimOk > 0 ? (
                          <span className="text-emerald-400">
                            ✅ {c.userStakedPositionsSimOk} 仓预演通过
                          </span>
                        ) : (
                          <span className="text-ink-muted">无质押仓位</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Merkl 质押奖励精算 & 全池高 APR 机会猎手抽屉（点击顶部「🎁 质押产出」胶囊展开） */}
      {showMerklDrawer && (
        <div className="card p-4 space-y-3 border border-cyan-500/35 bg-surface-1/95">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-semibold text-ink">
                🎯 ZIA Merkl 质押奖励精算 & 高 APR 机会猎手（60% 活跃L + 20% Token0 + 20% Token1）
              </span>
              {merkl && (
                <span className="text-xs font-mono text-cyan-300">
                  · 0G 实时价 ${merkl.w0gPriceUsd.toFixed(4)} ({merkl.w0gPriceSource})
                </span>
              )}
              {merkl?.checkedAt && (
                <span className="text-xs text-ink-muted">
                  · 更新于 {timeAgo(merkl.checkedAt)} ({merkl.durationMs}ms)
                </span>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={merkl?.highAprAlertEnabled ?? true}
                  disabled={merklBusy}
                  onChange={(e) =>
                    runMerklAction("update_settings", {
                      highAprAlertEnabled: e.target.checked,
                    })
                  }
                />
                <span>高APR推送提醒</span>
              </label>
              <div className="inline-flex items-center gap-1 text-xs">
                <span className="text-ink-soft">阈值 ≥</span>
                <input
                  type="number"
                  className="input w-20 px-2 py-0.5 text-xs font-mono"
                  value={aprThreshInput}
                  onChange={(e) => setAprThreshInput(e.target.value)}
                />
                <span className="text-ink-soft">%</span>
                <button
                  type="button"
                  disabled={merklBusy}
                  onClick={() =>
                    runMerklAction("update_settings", {
                      highAprThresholdPct: Number(aprThreshInput) || 800,
                    })
                  }
                  className="btn-ghost btn-xs"
                >
                  保存
                </button>
              </div>
              <button
                type="button"
                disabled={merklBusy}
                onClick={() => runMerklAction("scan")}
                className="btn-ghost btn-xs"
              >
                {merklBusy ? "⏳ 测算中…" : "⚡ 刷新测算"}
              </button>
              <button
                type="button"
                disabled={merklBusy}
                onClick={() => runMerklAction("test_alert")}
                className="btn-ghost btn-xs"
                title="向 Bark 发送当前榜首高 APR 池的实时测算提醒"
              >
                🔔 测试高APR推送
              </button>
              <button
                type="button"
                onClick={() => setShowMerklDrawer(false)}
                className="btn-ghost btn-xs"
              >
                收起 ▲
              </button>
            </div>
          </div>

          {/* 我的质押总收益概览条 */}
          {merkl && (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 rounded-lg border border-cyan-500/25 bg-cyan-500/5 p-3 text-xs">
              <div>
                <div className="text-ink-soft">我的已质押总本金</div>
                <div className="mt-0.5 font-mono text-base font-bold text-ink">
                  ${merkl.userTotalStakedUsd.toFixed(1)}
                </div>
              </div>
              <div>
                <div className="text-ink-soft">预计每小时总奖励</div>
                <div className="mt-0.5 font-mono text-base font-bold text-emerald-300">
                  {merkl.userTotalHourlyW0g.toFixed(2)} W0G{" "}
                  <span className="text-xs font-normal text-emerald-200">
                    (${merkl.userTotalHourlyUsd.toFixed(2)}/h)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-ink-soft">预计每天总奖励</div>
                <div className="mt-0.5 font-mono text-base font-bold text-emerald-300">
                  {merkl.userTotalDailyW0g.toFixed(1)} W0G{" "}
                  <span className="text-xs font-normal text-emerald-200">
                    (${merkl.userTotalDailyUsd.toFixed(2)}/d)
                  </span>
                </div>
              </div>
              <div>
                <div className="text-ink-soft">我的质押综合 APR</div>
                <div className="mt-0.5 font-mono text-base font-bold text-amber-300">
                  {merkl.userWeightedAprPct.toFixed(1)}%{" "}
                  <span className="text-[11px] font-normal text-ink-muted">
                    (本周期剩 {(merkl.epochRemainingHours / 24).toFixed(1)} 天)
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* 6 大 ZIA 激励池实时高 APR 猎手排行榜 */}
          {merkl && merkl.pools.length > 0 && (
            <div className="overflow-x-auto rounded-lg border border-border/60 bg-surface-0/60">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border/60 bg-surface-2/60 text-ink-muted">
                  <tr>
                    <th className="px-3 py-2">激励池 (费率)</th>
                    <th className="px-3 py-2">池日产预算</th>
                    <th className="px-3 py-2">池内窄幅竞争 vs 总质押TVL</th>
                    <th className="px-3 py-2">现价距单格边界</th>
                    <th className="px-3 py-2">投 $1,000 单格稀释后占比</th>
                    <th className="px-3 py-2">投 $1,000 预计每时 / 每天</th>
                    <th className="px-3 py-2">千刀单格真实 APR</th>
                    <th className="px-3 py-2">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border/40">
                  {merkl.pools.map((p, idx) => (
                    <tr
                      key={p.key}
                      className={
                        p.isHighApr
                          ? "bg-amber-500/10 hover:bg-amber-500/15"
                          : "hover:bg-surface-2/30"
                      }
                    >
                      <td className="px-3 py-2 font-medium text-ink">
                        <span className="mr-1.5 font-mono text-ink-muted">
                          #{idx + 1}
                        </span>
                        {p.pairLabel}
                      </td>
                      <td className="px-3 py-2 font-mono text-ink">
                        {p.dailyW0g.toFixed(0)} W0G/d{" "}
                        <span className="text-ink-soft">
                          (${p.dailyRewardUsd.toFixed(0)})
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span
                          className={
                            p.narrowStakedTvlUsd < 500
                              ? "text-emerald-300 font-semibold"
                              : "text-amber-200"
                          }
                          title="当前池内宽度 ≤ 4 格的在位窄区间竞争资金（决定抢 50% 活跃 L 奖池的难易度）"
                        >
                          窄幅 ${p.narrowStakedTvlUsd.toFixed(0)} ({p.narrowPositionCount}仓)
                        </span>{" "}
                        <span className="text-ink-muted">
                          / 总 ${p.stakedTvlUsd.toFixed(0)}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span
                          className={
                            p.subTickMinMarginPct < 15
                              ? "text-warn font-semibold"
                              : "text-emerald-300"
                          }
                          title={`当前单格 [${p.tickLower}, ${p.tickUpper}]：距下界 ${p.subTickMarginLowerPct.toFixed(0)}% / 距上界 ${p.subTickMarginUpperPct.toFixed(0)}%`}
                        >
                          {p.subTickMinMarginPct < 15 ? "⚠️ 贴边 " : "🟢 居中 "}
                          {p.subTickMarginLowerPct.toFixed(0)}% /{" "}
                          {p.subTickMarginUpperPct.toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-cyan-300">
                        活跃L {(p.sim1000ActiveLShare * 100).toFixed(1)}%{" "}
                        <span className="text-ink-muted">
                          (综合 {(p.sim1000RewardShare * 100).toFixed(1)}%)
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-emerald-300">
                        <div>
                          ${p.sim1000HourlyUsd.toFixed(2)}/h ({p.sim1000HourlyW0g.toFixed(1)} W0G)
                        </div>
                        <div className="text-[11px] text-emerald-200/80">
                          ${p.sim1000DailyUsd.toFixed(1)}/d ({p.sim1000DailyW0g.toFixed(0)} W0G)
                        </div>
                      </td>
                      <td className="px-3 py-2 font-mono">
                        <span
                          className={`rounded px-1.5 py-0.5 font-bold ${
                            p.isHighApr
                              ? "bg-amber-500/25 text-amber-200 border border-amber-400/40"
                              : "text-ink"
                          }`}
                        >
                          {p.isHighApr ? "🔥 " : ""}
                          {p.sim1000AprPct.toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <button
                          type="button"
                          onClick={() => handleReopenPool(p.chainIdRef, p.pool)}
                          className="btn-ghost btn-xs border border-cyan-500/35 text-cyan-200 hover:bg-cyan-500/20"
                        >
                          🎯 探针/建仓
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 扫描频率和告警阈值设置（按需展开，保持首屏紧凑） */}
      {showScanSettings && (
        <ScanIntervalAndAlerts
          combinedCron={mon?.combinedCron ?? ""}
          onChanged={() => reloadMon()}
        />
      )}

      {/* 双栏终端主布局：左侧 5 列三段式操作工作台，右侧 7 列实时仓位监控 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
        {/* ==================== 左栏（5/12）：三段式联动工作台（探针 -> 建仓 -> Swap） ==================== */}
        <div className="lg:col-span-5 space-y-4 lg:sticky lg:top-4">
          <div ref={probeRef}>
            <LiquidityProbe
              externalPool={externalPool}
              merkl={merkl}
              binanceRt={binanceRt}
            />
          </div>

          {/* 链上资产统计（可折叠抽屉） */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">
                📊 链上钱包资产统计
              </span>
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => setShowPortfolio((v) => !v)}
              >
                {showPortfolio ? "收起 ▲" : "展开查询 ▼"}
              </button>
            </div>
            {showPortfolio && (
              <div className="mt-3">
                <PortfolioSection />
              </div>
            )}
          </div>
        </div>

        {/* ==================== 右栏（7/12）：LP 仓位监控 ==================== */}
        <div className="lg:col-span-7 space-y-5">
          {/* 越界告警区（如有） */}
          {outOfRange.length > 0 && (
            <section>
              <h2 className="mb-2.5 flex items-center gap-2 text-base font-semibold text-warn">
                ⚠️ 越界仓位（{outOfRange.length}）
              </h2>
              <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
                {outOfRange.map((p) => (
                  <PositionCard
                    key={p.id}
                    p={p}
                    rewardEst={
                      merkl?.positions?.[String(p.token_id)] ??
                      merkl?.positions?.[`id:${p.id}`]
                    }
                    w0gPriceUsd={merkl?.w0gPriceUsd}
                    binanceRt={binanceRt}
                    highlight
                    onFlipped={reloadPos}
                    onReopenPool={handleReopenPool}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 全部仓位 */}
          <section>
            <h2 className="mb-2.5 text-base font-semibold text-ink">
              全部监控仓位（{list.length}）
            </h2>
            {list.length === 0 ? (
              <EmptyHint />
            ) : (
              <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
                {list.map((p) => (
                  <PositionCard
                    key={p.id}
                    p={p}
                    rewardEst={
                      merkl?.positions?.[String(p.token_id)] ??
                      merkl?.positions?.[`id:${p.id}`]
                    }
                    w0gPriceUsd={merkl?.w0gPriceUsd}
                    binanceRt={binanceRt}
                    onFlipped={reloadPos}
                    onReopenPool={handleReopenPool}
                  />
                ))}
              </div>
            )}
          </section>

          {/* 已平仓仓位（折叠） */}
          {closed.length > 0 && (
            <section>
              <button
                type="button"
                className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-ink"
                onClick={() => setShowClosed(!showClosed)}
              >
                <span
                  className={`transition-transform ${
                    showClosed ? "rotate-90" : ""
                  }`}
                >
                  ▶
                </span>
                已平仓归档仓位（{closed.length}）
              </button>
              {showClosed && (
                <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2 opacity-75">
                  {closed.map((p) => (
                    <PositionCard
                      key={p.id}
                      p={p}
                      closed
                      onFlipped={reloadPos}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {/* 底部版本号 */}
      <div className="text-center text-xs text-ink-muted">
        LP Monitor v{process.env.NEXT_PUBLIC_VERSION || "0.19.8"}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-2xl font-bold font-mono ${
          danger ? "text-warn" : "text-ink"
        }`}
      >
        {value}
      </div>
      <div className="text-xs text-ink-soft">{label}</div>
    </div>
  );
}

/* ============ 链上资产统计 ============ */
interface AssetItem {
  kind: "native" | "erc20" | "lp";
  symbol: string;
  amount: string;
  valueUsd: number | null;
  subItems?: { symbol: string; amount: string; valueUsd: number | null }[];
}
interface PortfolioResult {
  items: AssetItem[];
  totalUsd: number;
  nativeSymbol: string;
  warnings: string[];
}

function PortfolioSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { address: walletAddr } = useWallet();
  const [chainId, setChainId] = useState<number | "">("");
  const [addr, setAddr] = useState("");
  useEffect(() => {
    if (walletAddr && !addr) setAddr(walletAddr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddr]);
  const [query, setQuery] = useState<{
    chainId: number;
    addr: string;
    seq: number;
  } | null>(null);
  const [history, setHistory] = useState<
    { chainId: number; chainName: string; address: string; ts: number }[]
  >([]);
  const [erc20Open, setErc20Open] = useState(true);
  const { data, error, isLoading } = useSWR<PortfolioResult>(
    query
      ? `/api/portfolio?chain_id=${query.chainId}&address=${encodeURIComponent(
          query.addr
        )}&_=${query.seq}`
      : null,
    fetcher
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem("lp_monitor_portfolio_history");
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!data || !query) return;
    const chainName =
      (chains ?? []).find((c: any) => c.id === query.chainId)?.name ??
      `chain#${query.chainId}`;
    setHistory((prev) => {
      const next = [
        { chainId: query.chainId, chainName, address: query.addr, ts: Date.now() },
        ...prev.filter(
          (h) =>
            !(
              h.chainId === query.chainId &&
              (h.address || "").toLowerCase() ===
                (query.addr || "").toLowerCase()
            )
        ),
      ].slice(0, 10);
      try {
        localStorage.setItem(
          "lp_monitor_portfolio_history",
          JSON.stringify(next)
        );
      } catch {
        /* ignore */
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function removeHistory(ts: number) {
    setHistory((prev) => {
      const next = prev.filter((h) => h.ts !== ts);
      try {
        localStorage.setItem(
          "lp_monitor_portfolio_history",
          JSON.stringify(next)
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem("lp_monitor_portfolio_history");
    } catch {
      /* ignore */
    }
  }

  function doQuery() {
    if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(addr.trim())) return;
    setQuery((prev) => ({
      chainId: Number(chainId),
      addr: addr.trim(),
      seq: (prev?.seq ?? 0) + 1,
    }));
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">链上资产统计</h2>
      <p className="mb-3 text-xs text-ink-soft">
        选择链并输入钱包地址，实时统计该钱包的 GAS 余额、ERC20 代币余额 + LP 仓位价值（含直接持有与质押，按 CEX 报价折算）。
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr_auto]">
        <Field label="链">
          <select
            className="input"
            value={chainId}
            onChange={(e) =>
              setChainId(e.target.value ? Number(e.target.value) : "")
            }
          >
            <option value="">选择链</option>
            {(chains ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="钱包地址">
          <input
            className="input font-mono"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="0x…"
          />
        </Field>
        <div className="flex items-end">
          <button
            className="btn-primary w-full h-[32px]"
            onClick={doQuery}
            disabled={!chainId || !addr}
          >
            统计
          </button>
        </div>
      </div>

      {/* 最近查询记录 */}
      {history.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-soft">最近查询：</span>
          {history.map((h) => (
            <span
              key={h.ts}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-surface-raised px-2.5 py-1 text-xs"
            >
              <button
                className="text-ink hover:text-cyan-300 transition-colors"
                title={`${h.chainName} · ${h.address}`}
                onClick={() => {
                  setChainId(h.chainId);
                  setAddr(h.address);
                  setQuery({
                    chainId: h.chainId,
                    addr: h.address,
                    seq: Date.now(),
                  });
                }}
              >
                {h.chainName} · {short(h.address)}
              </button>
              <button
                className="text-ink-muted hover:text-rose-400"
                onClick={() => removeHistory(h.ts)}
              >
                ×
              </button>
            </span>
          ))}
          <button
            className="text-xs text-ink-soft hover:text-warn"
            onClick={clearHistory}
          >
            清空
          </button>
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-ink-soft">
          统计中…（需读取链上余额与池子状态）
        </p>
      )}
      {error && (
        <p className="text-sm text-warn">❌ {(error as any)?.message ?? error}</p>
      )}
      {data && !isLoading && (
        <>
          {data.items.length === 0 ? (
            <p className="text-sm text-ink-soft">
              未发现资产（该钱包未登记或无仓位）。
            </p>
          ) : (
            (() => {
              const nativeItems = data.items.filter(
                (it) => it.kind === "native"
              );
              const erc20Items = data.items.filter((it) => it.kind === "erc20");
              const lpItems = data.items.filter((it) => it.kind === "lp");
              return (
                <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-surface-raised/60">
                  {/* GAS 原生代币 */}
                  {nativeItems.map((it, i) => (
                    <div
                      key={`native-${i}`}
                      className="flex items-center justify-between bg-surface-raised px-3.5 py-2 text-sm"
                    >
                      <span className="font-medium text-ink">
                        {it.symbol}
                        <span className="ml-1 font-mono text-ink-soft">
                          : {it.amount}
                        </span>
                      </span>
                      <span
                        className={`font-mono ${
                          it.valueUsd === null ? "text-ink-soft" : "text-ink"
                        }`}
                      >
                        {it.valueUsd === null
                          ? "—"
                          : `${it.valueUsd.toFixed(1)}U`}
                      </span>
                    </div>
                  ))}
                  {/* ERC20 代币折叠区域 */}
                  {erc20Items.length > 0 && (
                    <>
                      <div className="flex items-center justify-between border-t border-white/[0.08] px-3.5 py-1.5 text-xs">
                        <span className="font-medium text-ink-soft">
                          ERC20 代币（{erc20Items.length} 种）
                        </span>
                        <button
                          className="text-ink-soft hover:text-ink transition-colors"
                          onClick={() => setErc20Open((v) => !v)}
                        >
                          {erc20Open ? "收起 ▲" : "展开 ▼"}
                        </button>
                      </div>
                      {erc20Open &&
                        erc20Items.map((it, i) => (
                          <div
                            key={`erc20-${i}`}
                            className="flex items-center justify-between px-3.5 py-2 text-sm border-t border-white/[0.04]"
                          >
                            <span className="font-medium text-ink">
                              {it.symbol}
                              <span className="ml-1 font-mono text-ink-soft">
                                : {it.amount}
                              </span>
                            </span>
                            <span
                              className={`font-mono ${
                                it.valueUsd === null
                                  ? "text-ink-soft"
                                  : "text-ink"
                              }`}
                            >
                              {it.valueUsd === null
                                ? "—"
                                : `${it.valueUsd.toFixed(1)}U`}
                            </span>
                          </div>
                        ))}
                    </>
                  )}
                  {/* LP 仓位 */}
                  {lpItems.map((it, i) => (
                    <div key={`lp-${i}`}>
                      <div className="flex items-center justify-between border-t border-white/[0.08] px-3.5 py-2 text-sm">
                        <span className="font-medium text-ink">{it.symbol}</span>
                        <span
                          className={`font-mono font-semibold ${
                            it.valueUsd === null
                              ? "text-ink-soft"
                              : "text-cyan-300"
                          }`}
                        >
                          {it.valueUsd === null
                            ? "—"
                            : `${it.valueUsd.toFixed(1)}U`}
                        </span>
                      </div>
                      {it.subItems?.map((s, j) => (
                        <div
                          key={j}
                          className="flex items-center justify-between px-3.5 py-1.5 pl-6 text-xs text-ink-soft font-mono"
                        >
                          <span>
                            {s.symbol}: {s.amount}
                          </span>
                          <span>
                            {s.valueUsd === null
                              ? "—"
                              : `${s.valueUsd.toFixed(1)}U`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {/* 总价值 */}
                  <div className="flex items-center justify-between border-t border-white/[0.1] bg-surface-raised px-3.5 py-2.5 text-sm font-bold">
                    <span className="text-ink">总价值</span>
                    <span className="font-mono text-ok text-base">
                      {data.totalUsd.toFixed(1)}U
                    </span>
                  </div>
                </div>
              );
            })()
          )}
          {data.warnings.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {data.warnings.map((w, i) => (
                <p key={i} className="text-xs text-warn">
                  ⚠ {w}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ScanIntervalAndAlerts({
  combinedCron,
  onChanged,
}: {
  combinedCron: string;
  onChanged: () => void;
}) {
  const [preset, setPreset] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: alertData, mutate: mutateAlerts } = useSWR<any>(
    "/api/alert-settings",
    fetcher
  );
  const [tickThreshold, setTickThreshold] = useState("");

  async function applyScanInterval(intervalSec: number) {
    setBusy(true);
    setMsg("");
    try {
      const body: any =
        intervalSec >= 60
          ? { intervalMin: Math.floor(intervalSec / 60) }
          : { cron: `*/${intervalSec} * * * * *` };
      const r = await fetch("/api/monitor", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 扫描频率已更新`);
      setPreset("");
      onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTick() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          tick_move_enabled: alertData?.tick_move_enabled ? "0" : "1",
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleCex() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          cex_price_enabled: alertData?.cex_price_enabled ? "0" : "1",
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyThreshold(threshold?: number) {
    setBusy(true);
    setMsg("");
    try {
      const body: any = {};
      if (threshold !== undefined) body.tick_move_threshold = threshold;
      else if (tickThreshold !== "")
        body.tick_move_threshold = Number(tickThreshold);
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 阈值已更新");
      setTickThreshold("");
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyCooldown(
    field: "cooldown_cex" | "cooldown_range_state" | "cooldown_tick_move",
    minutes: number
  ) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ [field]: minutes }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 日间冷却时间已更新为 ${minutes} 分钟`);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function updateNightMode(patch: Record<string, any>, label?: string) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(patch),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ ${label || "夜间模式策略已更新"}`);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  const nightActiveNow = alertData?.night_mode_active_now ?? false;
  const nightDefaultHours = alertData?.night_mode_default_hours ?? 8;
  const nightRemainingMin = alertData?.night_mode_remaining_minutes ?? 0;
  const nightExpiresBeijing = alertData?.night_mode_expires_beijing ?? "";
  const nightOorCooldown = alertData?.night_cooldown_out_of_range ?? 60;
  const nightMuteNoise = alertData?.night_mute_noise ?? true;

  const formatRemaining = (mins: number) => {
    if (mins === -1) return "持续生效（直到手动关闭）";
    if (mins <= 0) return "";
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return h > 0 ? `${h}小时${m > 0 ? `${m}分` : ""}` : `${m}分钟`;
  };

  return (
    <div className="card p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-4">
        {/* 扫描频率 */}
        <div className="flex items-center gap-2 border-r border-white/[0.1] pr-4">
          <span className="text-sm font-medium">扫描频率：</span>
          <span className="text-sm text-cyan-300 font-medium">
            {combinedCron ? cronToLabel(combinedCron) : "—"}
          </span>
          <select
            className="input max-w-[120px] text-xs"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            <option value="">设置频率…</option>
            <option value="30">30 秒</option>
            <option value="60">1 分钟</option>
            <option value="120">2 分钟</option>
            <option value="180">3 分钟</option>
            <option value="240">4 分钟</option>
            <option value="300">5 分钟</option>
          </select>
          <button
            className="btn-ghost text-xs"
            disabled={!preset || busy}
            onClick={() => applyScanInterval(Number(preset))}
          >
            应用
          </button>
        </div>

        {/* 告警阈值 */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">告警阈值：</span>

          <button
            className={
              alertData?.tick_move_enabled
                ? "btn-primary text-xs"
                : "btn-ghost text-xs"
            }
            disabled={busy}
            onClick={toggleTick}
          >
            {alertData?.tick_move_enabled ? "波动预警：开" : "波动预警：关"}
          </button>

          <span className="text-xs text-ink-soft">阈值</span>
          <select
            className="input max-w-[80px] text-xs"
            value={tickThreshold || (alertData?.tick_move_threshold ?? 5)}
            disabled={busy}
            onChange={(e) => {
              setTickThreshold(e.target.value);
              applyThreshold(Number(e.target.value));
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>

          <button
            className={
              alertData?.cex_price_enabled
                ? "btn-primary text-xs"
                : "btn-ghost text-xs"
            }
            disabled={busy}
            onClick={toggleCex}
          >
            {alertData?.cex_price_enabled ? "CEX 推送：开" : "CEX 推送：关"}
          </button>
          <span className="text-xs text-ink-soft">超过费率 2 倍时提醒</span>
        </div>

        {/* 日间推送冷却时间 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium">正常冷却：</span>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">CEX价差</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_cex ?? 2}
              onChange={(e) =>
                applyCooldown("cooldown_cex", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">区间状态</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_range_state ?? 30}
              onChange={(e) =>
                applyCooldown("cooldown_range_state", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">区间波动</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_tick_move ?? 0}
              onChange={(e) =>
                applyCooldown("cooldown_tick_move", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* 🌙 手动睡眠/低频推送模式（按小时倒计时自动恢复） */}
      <div
        className={`rounded-xl border px-3.5 py-2.5 transition-colors ${
          nightActiveNow
            ? "border-indigo-400/50 bg-indigo-500/15"
            : "border-white/[0.08] bg-white/[0.02]"
        }`}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <span className="text-xs font-semibold text-indigo-200 flex items-center gap-1.5">
              🌙 睡眠低频模式
              <span
                className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${
                  nightActiveNow
                    ? "bg-indigo-500/35 text-indigo-100 border border-indigo-400/50"
                    : "bg-white/10 text-ink-soft"
                }`}
              >
                {nightActiveNow
                  ? nightRemainingMin === -1
                    ? "🌙 睡眠降频生效中 · 持续开启（至手动关闭）"
                    : `🌙 睡眠降频生效中 · 剩余 ${formatRemaining(nightRemainingMin)}（至北京时间 ${nightExpiresBeijing} 自动恢复）`
                  : "☀️ 当前未开启（正常频率推送中）"}
              </span>
            </span>

            {!nightActiveNow ? (
              <>
                <label className="flex items-center gap-1.5 text-xs">
                  <span className="text-ink-soft">设定时长</span>
                  <select
                    className="input max-w-[130px] text-xs py-1"
                    value={nightDefaultHours}
                    disabled={busy}
                    onChange={(e) =>
                      updateNightMode(
                        { night_mode_default_hours: Number(e.target.value) },
                        Number(e.target.value) === -1
                          ? "默认时长已设为持续开启"
                          : `默认开启时长已设为 ${e.target.value} 小时`
                      )
                    }
                  >
                    {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12].map((h) => (
                      <option key={h} value={h}>
                        {h} 小时
                      </option>
                    ))}
                    <option value={-1}>持续开启(手动关)</option>
                  </select>
                </label>

                <button
                  className="btn-primary text-xs py-1 px-3 font-medium"
                  disabled={busy}
                  onClick={() =>
                    updateNightMode(
                      { night_action: "start", night_hours: nightDefaultHours },
                      nightDefaultHours === -1
                        ? "🌙 已开启睡眠低频模式（持续至手动关闭）"
                        : `🌙 已开启睡眠低频模式（持续 ${nightDefaultHours} 小时，到期自动恢复）`
                    )
                  }
                >
                  🌙 开启睡眠模式 (
                  {nightDefaultHours === -1 ? "持续" : `${nightDefaultHours}小时`})
                </button>

                <div className="flex items-center gap-1">
                  {[4, 6, 8, 10].map((h) => (
                    <button
                      key={h}
                      className="btn-ghost text-[11px] py-0.5 px-2"
                      disabled={busy}
                      onClick={() =>
                        updateNightMode(
                          { night_action: "start", night_hours: h },
                          `🌙 已开启睡眠低频模式 ${h} 小时`
                        )
                      }
                    >
                      睡{h}h
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <button
                  className="btn-primary bg-amber-500/80 hover:bg-amber-500 text-slate-950 font-semibold text-xs py-1 px-3"
                  disabled={busy}
                  onClick={() =>
                    updateNightMode(
                      { night_action: "stop" },
                      "☀️ 已关闭睡眠模式，恢复正常频率推送"
                    )
                  }
                >
                  ☀️ 我醒了 (立即关闭)
                </button>

                <button
                  className="btn-secondary text-xs py-1 px-2.5"
                  disabled={busy}
                  onClick={() =>
                    updateNightMode(
                      { night_action: "extend", night_hours: 1 },
                      "🌙 已延长睡眠模式 +1 小时"
                    )
                  }
                >
                  +1小时
                </button>
                <button
                  className="btn-secondary text-xs py-1 px-2.5"
                  disabled={busy}
                  onClick={() =>
                    updateNightMode(
                      { night_action: "extend", night_hours: 2 },
                      "🌙 已延长睡眠模式 +2 小时"
                    )
                  }
                >
                  +2小时
                </button>
              </>
            )}

            <span className="text-white/20">|</span>

            <label className="flex items-center gap-1.5 text-xs">
              <span className="text-ink-soft">越界重复间隔</span>
              <select
                className="input max-w-[155px] text-xs py-1"
                value={nightOorCooldown}
                disabled={busy}
                onChange={(e) =>
                  updateNightMode(
                    { night_cooldown_out_of_range: Number(e.target.value) },
                    Number(e.target.value) === -1
                      ? "睡眠模式已设为仅首次越界推送（回区间仍推1次）"
                      : `睡眠模式越界重复提醒已设为 ${e.target.value} 分钟`
                  )
                }
              >
                <option value={60}>60分钟 (至少1小时)</option>
                <option value={90}>90分钟 (1.5小时)</option>
                <option value={120}>120分钟 (2小时)</option>
                <option value={180}>180分钟 (3小时)</option>
                <option value={-1}>仅推首次越界 (不重复)</option>
              </select>
            </label>

            <button
              className={
                nightMuteNoise
                  ? "btn-secondary text-xs py-1 px-2.5"
                  : "btn-ghost text-xs py-1 px-2.5"
              }
              disabled={busy}
              onClick={() =>
                updateNightMode(
                  { night_mute_noise: nightMuteNoise ? "0" : "1" },
                  nightMuteNoise
                    ? "已关闭睡眠降噪"
                    : "已开启睡眠降噪（静默区间内波动与高APR猎手）"
                )
              }
            >
              {nightMuteNoise ? "🔕 睡眠降噪：开" : "🔔 睡眠降噪：关"}
            </button>
          </div>

          <div className="text-[11px] text-ink-soft">
            策略：首次越界立即推 · 持续越界{" "}
            {nightOorCooldown === -1 ? "不重复推" : `≥${nightOorCooldown}分钟重复推`} ·{" "}
            <span className="text-emerald-300 font-medium">回到区间立即推 1 次</span>
            {nightMuteNoise ? " · 静默区间波动/高APR打野" : ""}
          </div>
        </div>
      </div>

      {msg && <div className="mt-2 text-xs">{msg}</div>}
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="card p-8 text-center text-ink-soft">
      <p className="mb-3">还没有任何仓位被监控。</p>
      <ol className="mx-auto inline-block list-decimal text-left text-sm space-y-1">
        <li>
          在{" "}
          <a className="underline text-cyan-300" href="/config">
            配置页
          </a>{" "}
          添加监控钱包
        </li>
        <li>确认链上有对应 DEX（默认 Ethereum / Uniswap V3）</li>
        <li>点击「立即扫描」或等待定时任务</li>
      </ol>
    </div>
  );
}

function FlipButton({
  positionId,
  currentFlip,
  onFlipped,
}: {
  positionId: number;
  currentFlip: boolean;
  onFlipped?: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleFlip = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/positions/${positionId}/pair-flip`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ flip: !currentFlip }),
      });
      const result = await response.json();

      if (result.ok) {
        mutate("/api/liquidity-favorites");
        onFlipped?.();
      } else {
        alert(result.error || "操作失败");
      }
    } catch (error) {
      alert("操作失败：" + error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleFlip}
      disabled={loading}
      className={
        currentFlip ? "btn-secondary text-xs" : "btn-ghost text-xs"
      }
    >
      {loading ? "..." : currentFlip ? "还原" : "翻转"}
    </button>
  );
}

function CexAlertMuteButton({
  positionId,
  currentMuted,
  onToggled,
}: {
  positionId: number;
  currentMuted: boolean;
  onToggled?: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/positions/${positionId}/cex-alert-mute`,
        {
          method: "PUT",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ mute: !currentMuted }),
        }
      );
      const result = await response.json();

      if (result.ok) {
        onToggled?.();
      } else {
        alert(result.error || "操作失败");
      }
    } catch (error) {
      alert("操作失败：" + error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleToggle}
      disabled={loading}
      title={
        currentMuted
          ? "点击恢复该交易对的 CEX 差价预警"
          : "点击静音该交易对的 CEX 差价预警"
      }
      className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
        currentMuted
          ? "border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
          : "border-emerald-500/35 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
      }`}
    >
      {loading ? "..." : currentMuted ? "预警:关" : "预警:开"}
    </button>
  );
}

function PositionCard({
  p,
  rewardEst,
  w0gPriceUsd,
  binanceRt,
  highlight,
  closed,
  onFlipped,
  onReopenPool,
}: {
  p: Position;
  rewardEst?: PositionRewardEstimate;
  w0gPriceUsd?: number;
  binanceRt?: UseBinanceRealtimeReturn;
  highlight?: boolean;
  closed?: boolean;
  onFlipped?: () => void;
  onReopenPool?: (chainId: number, pool: string) => void;
}) {
  const { address: connectedWallet } = useWallet();
  const inRange = p.last_in_range === 1;
  // 若 Merkl ZiaVault 扫描已发现该 tokenId 在质押金库内，即使 DB source 尚未刷完也立即识别为质押中
  const isStaked = p.source === "staking" || !!rewardEst;
  const effectiveStaker = p.staker_contract || rewardEst?.vault || "";
  const explorer = p.explorer_url?.replace(/\/$/, "");
  const dexLabel = p.dex_display_name || p.dex_name;
  const span = Math.max(p.tick_upper - p.tick_lower, 1);
  const marginLower = ((p.last_current_tick - p.tick_lower) / span) * 100;
  const marginUpper = ((p.tick_upper - p.last_current_tick) / span) * 100;
  const sym0 = p.token0_symbol || rewardEst?.symbol0 || short(p.token0);
  const sym1 = p.token1_symbol || rewardEst?.symbol1 || short(p.token1);
  const pair = p.pair_flip ? `${sym1}/${sym0}` : `${sym0}/${sym1}`;
  const dbCexInfo = parseCexPrice(p.last_cex_price);

  // 实时币安双指针与套利死角分析（优先使用前端实时 WS 报价，兜底用 DB 快照）
  const liveCex = useMemo(() => {
    const dexRate0 = Number(p.last_price0);
    const rt = binanceRt?.analyzePairCex(
      p.chain_id_ref,
      p.token0,
      p.token1,
      sym0,
      sym1,
      dexRate0,
      p.last_current_tick,
      p.tick_lower,
      p.tick_upper,
      p.fee
    );
    if (rt) return rt;
    if (dbCexInfo && dbCexInfo.cexRate > 0 && dbCexInfo.dexRate > 0) {
      const tickDelta = Math.round(
        Math.log(dbCexInfo.cexRate / dbCexInfo.dexRate) / Math.log(1.0001)
      );
      const impliedTick = p.last_current_tick + tickDelta;
      const impliedMarginLowerPct = ((impliedTick - p.tick_lower) / span) * 100;
      const impliedMarginUpperPct = ((p.tick_upper - impliedTick) / span) * 100;
      const feeRate = (p.fee || 3000) / 1_000_000;
      return {
        token0PriceUsd: dbCexInfo.token0Price ?? 0,
        token1PriceUsd: dbCexInfo.token1Price ?? 1,
        token0CexSymbol: dbCexInfo.token0CexSymbol || sym0,
        token1CexSymbol: dbCexInfo.token1CexSymbol || sym1,
        cexRate: dbCexInfo.cexRate,
        dexRate: dbCexInfo.dexRate,
        diff: dbCexInfo.diff,
        absDiff: dbCexInfo.absDiff,
        feeRate,
        withinFeeDeadzone: dbCexInfo.absDiff < feeRate,
        exceedsAlertThreshold: dbCexInfo.absDiff >= feeRate * 2,
        impliedTick,
        tickDelta,
        impliedInRange: impliedTick >= p.tick_lower && impliedTick < p.tick_upper,
        impliedMarginLowerPct,
        impliedMarginUpperPct,
      };
    }
    return null;
  }, [binanceRt, p, sym0, sym1, dbCexInfo, span]);

  // 实时双币持仓拆解（Module ③）
  const holdings = useMemo(
    () =>
      !closed
        ? computePositionHoldings(p, rewardEst, binanceRt, w0gPriceUsd)
        : null,
    [closed, p, rewardEst, binanceRt, w0gPriceUsd]
  );

  const walletDisplay = p.wallet_label
    ? `${p.wallet_label} (${short(p.wallet_address)})`
    : short(p.wallet_address);
  const isWalletMatched =
    !!connectedWallet &&
    !!p.wallet_address &&
    connectedWallet.toLowerCase() === p.wallet_address.toLowerCase();
  const isWalletMismatched =
    !!connectedWallet &&
    !!p.wallet_address &&
    connectedWallet.toLowerCase() !== p.wallet_address.toLowerCase();

  const flip = p.pair_flip === 1;
  const displaySym0 = flip ? sym1 : sym0;
  const displaySym1 = flip ? sym0 : sym1;
  const displayPrice0 = p.last_price0
    ? fmtFull(flip ? 1 / Number(p.last_price0) : Number(p.last_price0))
    : p.last_price0;
  const displayCexRate = liveCex
    ? flip
      ? 1 / liveCex.cexRate
      : liveCex.cexRate
    : 0;
  const displayToken0Cex = liveCex
    ? (flip ? liveCex.token1CexSymbol : liveCex.token0CexSymbol) || displaySym0
    : "";
  const displayToken1Cex = liveCex
    ? (flip ? liveCex.token0CexSymbol : liveCex.token1CexSymbol) || displaySym1
    : "";

  const onChainClampedPct = Math.min(Math.max(marginLower, 0), 100);
  const impliedClampedPct = liveCex
    ? Math.min(Math.max(liveCex.impliedMarginLowerPct, 0), 100)
    : null;
  const pullLeftPct =
    impliedClampedPct !== null
      ? Math.min(onChainClampedPct, impliedClampedPct)
      : 0;
  const pullWidthPct =
    impliedClampedPct !== null
      ? Math.abs(impliedClampedPct - onChainClampedPct)
      : 0;

  const liveW0gUsd =
    binanceRt?.getTokenUsdPrice(p.chain_id_ref, "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c", "W0G") ??
    w0gPriceUsd ??
    0;

  return (
    <div
      className={`card p-4 ${
        closed
          ? "border-dashed border-white/[0.15] bg-surface-raised/50"
          : highlight
            ? "border-rose-500/60 shadow-[0_0_20px_-5px_rgba(244,63,94,0.3)]"
            : ""
      }`}
    >
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-base text-ink">{pair}</span>
            {p.pair_flip === 1 && (
              <span className="tag-info" title="交易对已翻转">
                翻转
              </span>
            )}
            {closed ? (
              <span className="tag-muted">已平仓</span>
            ) : inRange ? (
              <span className="tag-ok">在区间内</span>
            ) : (
              <span className="tag-danger">已越界</span>
            )}
            {!closed && p.last_alert_type === "tick_move" && (
              <span className="tag-info">波动</span>
            )}
            {!closed && p.last_alert_type === "cex_price" && (
              <span className="tag-warn">CEX 价差</span>
            )}
            {!closed && isStaked && (
              <span className="tag-muted">质押中</span>
            )}
          </div>
          <div className="mt-0.5 text-xs text-ink-soft">
            {p.chain_name} · {dexLabel} · #{p.token_id}
          </div>
        </div>
      </div>

      <div className="space-y-1 text-sm">
        <Row label="交易对">
          <span title={`${p.token0} / ${p.token1}`}>
            {pair} · fee {(p.fee / 10000).toFixed(2)}%
          </span>
        </Row>
        <Row label="当前 tick">
          <span
            className={`font-mono ${
              inRange ? "text-ink" : "text-warn font-semibold"
            }`}
          >
            {p.last_current_tick}
            {liveCex && (
              <span className="ml-1.5 text-xs text-amber-300" title="币安实时价格对应的池内隐含目标 Tick">
                (⚡币安Tick {liveCex.impliedTick})
              </span>
            )}
          </span>
        </Row>
        <Row label="区间">
          <span className="font-mono">
            [{p.tick_lower}, {p.tick_upper}]
          </span>
        </Row>
        <Row label="DEX 池价">
          <span className="font-mono">
            1 {displaySym0} ≈ {displayPrice0} {displaySym1}
          </span>
        </Row>
        {liveCex && (
          <Row label={`CEX 实时汇率 (${displayToken0Cex}÷${displayToken1Cex})`}>
            <span className="font-mono text-cyan-200">
              1 {displaySym0} = {fmtFull(displayCexRate)} {displaySym1}
            </span>
          </Row>
        )}
        {liveCex && (
          <Row label="CEX 实时价差">
            <span
              className={`font-mono ${
                !liveCex.withinFeeDeadzone
                  ? "text-amber-300 font-semibold"
                  : "text-emerald-300"
              }`}
            >
              差 {pctSigned(liveCex.diff)}
            </span>
            <span className="ml-1.5 font-mono text-xs text-ink-soft">
              ({liveCex.tickDelta >= 0 ? "+" : ""}
              {liveCex.tickDelta} tick)
            </span>
          </Row>
        )}

        {/* ==================== Module ②：双指针区间雷达（链上 Tick + 币安隐含 Tick + 0.30% 套利死角判定） ==================== */}
        <div className="pt-2 pb-1 space-y-1">
          <div className="relative h-2.5 w-full rounded bg-white/[0.1] overflow-visible">
            {/* 区间内绿底 */}
            <div
              className="absolute inset-y-0 left-0 rounded bg-emerald-500/30"
              style={{
                width: `${
                  inRange
                    ? Math.min(Math.max(marginLower, 2), 98)
                    : marginLower < 0
                      ? 0
                      : 100
                }%`,
              }}
            />
            {/* 链上 Tick 与 币安隐含 Tick 之间的套利牵引带 */}
            {impliedClampedPct !== null && pullWidthPct > 0.5 && (
              <div
                className="absolute inset-y-0 rounded bg-amber-400/30"
                style={{
                  left: `${pullLeftPct}%`,
                  width: `${pullWidthPct}%`,
                }}
                title="链上现价与币安隐含价之间的套利牵引区"
              />
            )}
            {/* 指针 1：链上当前 Tick */}
            <div
              className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded shadow"
              style={{
                left: `${onChainClampedPct}%`,
                background: inRange ? "#10b981" : "#f43f5e",
              }}
              title={`链上当前 Tick: ${p.last_current_tick} (距下界 ${marginLower.toFixed(1)}%)`}
            />
            {/* 指针 2：币安实时隐含 Tick */}
            {impliedClampedPct !== null && liveCex && (
              <div
                className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded border border-amber-200 bg-amber-400 shadow-[0_0_8px_#f59e0b]"
                style={{
                  left: `${impliedClampedPct}%`,
                }}
                title={`⚡ 币安实时隐含 Tick: ${liveCex.impliedTick} (距下界 ${liveCex.impliedMarginLowerPct.toFixed(1)}%)`}
              />
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-mono text-ink-soft">
            <span>
              🟢 链上距下界 {marginLower.toFixed(1)}% / 距上界 {marginUpper.toFixed(1)}%
            </span>
            {liveCex && (
              <span
                className={
                  liveCex.impliedInRange ? "text-amber-300" : "text-rose-300 font-semibold"
                }
              >
                ⚡ 币安位置 {liveCex.impliedMarginLowerPct.toFixed(1)}%
                {!liveCex.impliedInRange ? " (池外)" : ""}
              </span>
            )}
          </div>

          {/* 0.30% 手续费死角 vs 套利临界状态条 */}
          {!closed && liveCex && (
            <div
              className={`rounded border px-2 py-1 text-[11px] font-mono flex flex-wrap items-center justify-between gap-1 ${
                liveCex.withinFeeDeadzone
                  ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                  : "border-amber-500/45 bg-amber-500/15 text-amber-200"
              }`}
            >
              {liveCex.withinFeeDeadzone ? (
                <span>
                  🛡️ 手续费死角：价差 {(liveCex.absDiff * 100).toFixed(2)}% &lt;{" "}
                  {(liveCex.feeRate * 100).toFixed(2)}% 池费（套利不触发）
                </span>
              ) : (
                <span>
                  ⚡ 套利临界：价差 {(liveCex.absDiff * 100).toFixed(2)}% ≥{" "}
                  {(liveCex.feeRate * 100).toFixed(2)}% 池费 · 机器人即将把 Tick 推向{" "}
                  {liveCex.impliedTick}
                </span>
              )}
            </div>
          )}
        </div>

        {/* ==================== Module ③：实时双币持仓拆解（数量 + USD + 双色比例条） ==================== */}
        {!closed && holdings && (
          <div className="my-1.5 rounded-lg border border-white/[0.08] bg-surface-0/60 p-2 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="font-semibold text-ink">
                💰 实时持仓构成{" "}
                <span className="font-mono text-cyan-300">
                  (≈ ${holdings.totalUsd.toFixed(1)})
                </span>
              </span>
              {holdings.isSingleSided && (
                <span className="rounded bg-amber-500/20 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-amber-200 border border-amber-400/35">
                  ⚠️ 100% 单边 ({holdings.amt0 > holdings.amt1 ? holdings.sym0 : holdings.sym1})
                </span>
              )}
            </div>
            {/* 双色持仓比例条 */}
            <div className="flex h-1.5 w-full overflow-hidden rounded bg-white/[0.08]">
              <div
                className="bg-emerald-400 transition-all"
                style={{ width: `${Math.min(Math.max(holdings.pct0, 0), 100)}%` }}
              />
              <div
                className="bg-cyan-400 transition-all"
                style={{ width: `${Math.min(Math.max(holdings.pct1, 0), 100)}%` }}
              />
            </div>
            <div className="grid grid-cols-2 gap-1.5 font-mono text-[11px]">
              <div className="flex items-center justify-between rounded bg-white/[0.03] px-1.5 py-0.5">
                <span className="text-emerald-300 font-semibold">{holdings.sym0}</span>
                <span className="text-ink">
                  {fmtTokenAmount(holdings.amt0)}{" "}
                  <span className="text-ink-soft">
                    (${holdings.usd0.toFixed(0)} · {holdings.pct0.toFixed(0)}%)
                  </span>
                </span>
              </div>
              <div className="flex items-center justify-between rounded bg-white/[0.03] px-1.5 py-0.5">
                <span className="text-cyan-300 font-semibold">{holdings.sym1}</span>
                <span className="text-ink">
                  {fmtTokenAmount(holdings.amt1)}{" "}
                  <span className="text-ink-soft">
                    (${holdings.usd1.toFixed(0)} · {holdings.pct1.toFixed(0)}%)
                  </span>
                </span>
              </div>
            </div>
          </div>
        )}

        {/* ==================== Module ④：Merkl 50/25/25 三桶得分明细 & 越界重开磨损回本测算 ==================== */}
        {!closed && isStaked && rewardEst && (
          <div
            className={`my-2 rounded-lg border p-2.5 text-xs space-y-1.5 ${
              rewardEst.inRange
                ? "border-emerald-500/35 bg-emerald-500/10"
                : "border-amber-500/40 bg-amber-500/10"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-1">
              <span className="font-semibold text-ink">
                🎁 质押奖励估算{" "}
                <span className="font-normal text-ink-soft">
                  (0G=${fmtFull(liveW0gUsd)})
                </span>
              </span>
              <span
                className={`rounded px-1.5 py-0.5 font-mono font-bold ${
                  rewardEst.inRange
                    ? "bg-emerald-500/25 text-emerald-200 border border-emerald-400/30"
                    : "bg-amber-500/25 text-amber-200 border border-amber-400/30"
                }`}
              >
                APR {rewardEst.aprPct.toFixed(1)}%
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-0.5 font-mono">
              <div className="rounded bg-surface-0/60 px-2 py-1">
                <div className="text-[10px] font-sans text-ink-soft">⏱ 每小时奖励</div>
                <div className="text-emerald-300 font-semibold">
                  ${rewardEst.hourlyUsd.toFixed(2)}/h
                </div>
                <div className="text-[11px] text-ink-soft">
                  {rewardEst.hourlyW0g.toFixed(2)} W0G/h
                </div>
              </div>
              <div className="rounded bg-surface-0/60 px-2 py-1">
                <div className="text-[10px] font-sans text-ink-soft">📅 每天奖励</div>
                <div className="text-emerald-300 font-semibold">
                  ${rewardEst.dailyUsd.toFixed(2)}/d
                </div>
                <div className="text-[11px] text-ink-soft">
                  {rewardEst.dailyW0g.toFixed(1)} W0G/d
                </div>
              </div>
            </div>

            {/* Merkl 60% / 20% / 20% 三桶拆解明细 */}
            <div className="grid grid-cols-3 gap-1 pt-0.5 font-mono text-[10px]">
              <div
                className={`rounded px-1.5 py-1 border ${
                  rewardEst.inRange
                    ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                    : "border-rose-500/35 bg-rose-500/10 text-rose-300"
                }`}
              >
                <div className="font-sans opacity-80">⚡ 活跃L (60%)</div>
                <div className="font-semibold">
                  {(rewardEst.activeLShare * 100).toFixed(1)}% 池内
                </div>
                <div className="opacity-90">
                  ${(rewardEst.dailyActiveLUsd ?? 0).toFixed(2)}/d
                </div>
              </div>
              <div className="rounded border border-white/[0.08] bg-surface-0/50 px-1.5 py-1 text-ink">
                <div className="font-sans text-ink-soft">
                  🪙 {rewardEst.symbol0 || sym0} (20%)
                </div>
                <div className="font-semibold">
                  {(rewardEst.token0Share * 100).toFixed(1)}% 池内
                </div>
                <div className="text-cyan-200">
                  ${(rewardEst.dailyToken0Usd ?? 0).toFixed(2)}/d
                </div>
              </div>
              <div className="rounded border border-white/[0.08] bg-surface-0/50 px-1.5 py-1 text-ink">
                <div className="font-sans text-ink-soft">
                  💵 {rewardEst.symbol1 || sym1} (20%)
                </div>
                <div className="font-semibold">
                  {(rewardEst.token1Share * 100).toFixed(1)}% 池内
                </div>
                <div className="text-cyan-200">
                  ${(rewardEst.dailyToken1Usd ?? 0).toFixed(2)}/d
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px] font-mono text-ink-soft">
              <span>本金 ≈ ${rewardEst.positionUsd.toFixed(0)}</span>
              <span>
                综合加权得分 {(rewardEst.rewardShare * 100).toFixed(2)}%
              </span>
            </div>

            {/* 越界重开磨损回本测算器 */}
            {!rewardEst.inRange && rewardEst.potentialDailyUsd > rewardEst.dailyUsd && (
              <div className="rounded border border-amber-400/40 bg-amber-500/15 p-2 text-[11px] text-amber-100 space-y-1">
                <div className="flex flex-wrap items-center justify-between gap-1 font-semibold text-amber-200">
                  <span>🧮 越界重开磨损回本测算</span>
                  {rewardEst.breakevenHours !== null &&
                    rewardEst.breakevenHours !== undefined && (
                      <span className="rounded bg-amber-400/25 px-1.5 py-0.5 font-mono text-amber-100 border border-amber-300/40">
                        ⏱ 预计 {rewardEst.breakevenHours.toFixed(1)}h (
                        {Math.round(rewardEst.breakevenHours * 60)}分钟) 回本
                      </span>
                    )}
                </div>
                <div className="font-mono text-[10.5px] space-y-0.5 text-amber-100/90">
                  <div>
                    • 换币磨损：需换约 $
                    {(rewardEst.rebalanceSwapUsd ?? rewardEst.positionUsd * 0.5).toFixed(0)} ×{" "}
                    {(p.fee / 10000).toFixed(2)}% 池费 ≈{" "}
                    <span className="font-semibold text-white">
                      ${(rewardEst.rebalanceFeeUsd ?? 0).toFixed(2)}
                    </span>
                  </div>
                  <div>
                    • 重开增收：+${(rewardEst.hourlyGainUsd ?? 0).toFixed(2)}/h ($
                    {rewardEst.dailyUsd.toFixed(2)}/d → $
                    {rewardEst.potentialDailyUsd.toFixed(2)}/d · APR{" "}
                    {rewardEst.potentialAprPct.toFixed(0)}%)
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <Row label={isStaked ? "质押钱包" : "持仓钱包"}>
          <span
            className="inline-flex flex-wrap items-center justify-end gap-1.5 font-mono text-xs"
            title={p.wallet_address}
          >
            <span>{walletDisplay}</span>
            {!closed && isWalletMatched && (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-sans font-medium text-emerald-300 border border-emerald-500/35">
                ✓ 当前钱包
              </span>
            )}
            {!closed && isWalletMismatched && (
              <span
                className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-sans font-medium text-amber-200 border border-amber-500/40"
                title={`当前连接钱包为 ${short(connectedWallet!)}，与该仓位${isStaked ? "质押" : "持仓"}钱包不一致，无法直接解押`}
              >
                ⚠️ 非当前钱包
              </span>
            )}
          </span>
        </Row>
        <Row label="检查时间">{timeAgo(p.last_checked_at)}</Row>
        {isStaked && effectiveStaker && (
          <Row label="质押合约">
            <a
              className="underline font-mono text-cyan-300"
              href={`${explorer}/address/${effectiveStaker}`}
              target="_blank"
              rel="noreferrer"
            >
              {short(effectiveStaker)}
            </a>
          </Row>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {explorer && (
          <a
            className="btn-ghost text-xs"
            href={`${explorer}/address/${p.pool}`}
            target="_blank"
            rel="noreferrer"
          >
            查看 Pool
          </a>
        )}
        <FlipButton
          positionId={p.id}
          currentFlip={!!p.pair_flip}
          onFlipped={onFlipped}
        />
        <CexAlertMuteButton
          positionId={p.id}
          currentMuted={!!p.cex_alert_muted}
          onToggled={onFlipped}
        />
      </div>

      {!closed && (
        <LiquidityButton
          positionId={p.id}
          staking={isStaked}
          pairFlip={p.pair_flip}
        />
      )}

      {!closed && (
        <RemovePositionButton
          position={
            isStaked && p.source !== "staking"
              ? { ...p, source: "staking", staker_contract: effectiveStaker }
              : p
          }
          onRemoved={onFlipped}
          onReopenPool={
            onReopenPool
              ? (chainId, poolAddr) => onReopenPool(chainId, poolAddr)
              : undefined
          }
        />
      )}
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all text-ink">{children}</span>
    </div>
  );
}

interface CexPricePayload {
  pairLabel: string;
  token0CexSymbol: string;
  token1CexSymbol: string;
  token0Price?: number;
  token1Price?: number;
  quote: string;
  dexRate: number;
  cexRate: number;
  diff: number;
  absDiff: number;
}

function parseCexPrice(raw?: string): CexPricePayload | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (
      typeof o.dexRate === "number" &&
      typeof o.cexRate === "number" &&
      typeof o.diff === "number"
    ) {
      return o as CexPricePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function pctSigned(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}
