"use client";
import { useState, useEffect, useMemo } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, fmtFull, fmtTokenAmount } from "./util";
import { MintPositionPanel } from "./mint-position-panel";
import { SwapQuoteSection, type ExternalSwapPair } from "./swap-quote-section";
import { useWallet } from "@/lib/wallet/use-wallet";
import type { UseBinanceRealtimeReturn } from "@/lib/cex/use-binance-ws";
import type { MerklRewardsSummary, PoolRewardRadarItem } from "@/lib/monitor/merkl-rewards";

/**
 * 最小区间探针结果（场景C），与后端 MinRangeProbeResult 对齐。
 */
interface ProbeResult {
  pool?: string;
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: { amount0: string; amount1: string };
  stakedLiquidity?: { amount0: string; amount1: string };
  stakedRawLiquidity?: string;
  stakedPositionCount?: number;
  stakedShareOfPool?: number;
  stakedPlatform?: string;
  priceLow: string;
  priceHigh: string;
  priceCurrent: string;
  priceLabel: string;
  fee: number;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals?: number;
  token1Decimals?: number;
  sampledAt: string;
  cached?: boolean;
  pairFlip?: number;
  cex?: CexPricePayload;
  mintInit?: any;
}

/** CEX 价差结构（与后端 CexPricePayload / scanner 对齐） */
interface CexPricePayload {
  pairLabel: string;
  token0CexSymbol: string;
  token1CexSymbol: string;
  quote: string;
  dexRate: number;
  cexRate: number;
  diff: number;
  absDiff: number;
  exceedsThreshold?: boolean;
  token0Price?: number;
  token1Price?: number;
  token0Quote?: string;
  token1Quote?: string;
}

interface Chain {
  id: number;
  name: string;
}

interface Dex {
  id: number;
  chain_id_ref: number;
  name: string;
  type: string;
  factory: string;
  npm: string;
  enabled: number;
}

interface Favorite {
  id: number;
  chain_id_ref: number;
  chain_name: string;
  label: string;
  pool_addr: string;
  staker_addr: string;
  npm_addr: string;
  sort_order: number;
  token0_symbol?: string;
  token1_symbol?: string;
  fee?: number | null;
  monitor_cex?: number;
  pair_flip?: number;
}

const pctSigned = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/**
 * 三段式左侧极速工作台：
 *   ① 收藏池一键点选 + 🔬 最小区间探针完整检测信息
 *   ② ➕ 极速建仓 & 自动质押面板（自动复用探针返回的池况、余额与授权，0 额外请求）
 *   ③ 💱 当前池双币极速兑换 Swap（自动锁定选中池的 token0/token1 及钱包余额）
 */
export function LiquidityProbe({
  externalPool,
  merkl,
  binanceRt,
}: {
  externalPool?: { chainId: number; pool: string; ts: number } | null;
  merkl?: MerklRewardsSummary | null;
  binanceRt?: UseBinanceRealtimeReturn;
}) {
  const { address: walletAddr } = useWallet();
  const { data: chains } = useSWR<Chain[]>("/api/chains", fetcher);
  const { data: allDexes } = useSWR<Dex[]>("/api/dexes", fetcher);
  const { data: favorites, mutate: reloadFav } = useSWR<Favorite[]>(
    "/api/liquidity-favorites",
    fetcher
  );
  const [chainId, setChainId] = useState("");
  const [dexId, setDexId] = useState("");
  const [pool, setPool] = useState("");
  const [staker, setStaker] = useState("");
  const [npm, setNpm] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [mintCollapsed, setMintCollapsed] = useState(false);
  const [swapCollapsed, setSwapCollapsed] = useState(false);

  // 创建仓位面板选中的池子（点击收藏或探测后自动同步）
  const [mintPool, setMintPool] = useState("");
  const [mintChainId, setMintChainId] = useState(0);

  // 传给下方 Swap 的联动代币对
  const [swapPair, setSwapPair] = useState<ExternalSwapPair | null>(null);

  const [error, setError] = useState("");
  const [favMsg, setFavMsg] = useState("");
  // 翻转状态（来自后端返回，或本地切换暂存）
  const [localFlip, setLocalFlip] = useState(0);
  const [flipLoading, setFlipLoading] = useState(false);

  // 响应从外部传入的建仓指令（如仓位卡片点「撤池并重开」）
  useEffect(() => {
    if (externalPool && externalPool.pool) {
      const cStr = String(externalPool.chainId);
      setChainId(cStr);
      setPool(externalPool.pool);
      setMintChainId(externalPool.chainId);
      setMintPool(externalPool.pool);
      setMintCollapsed(false);
      probe(false, {
        chainId: cStr,
        pool: externalPool.pool,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPool?.ts]);

  // 根据选择的链过滤可用的 DEX
  const availableDexes = chainId
    ? (allDexes ?? []).filter(
        (d) => d.chain_id_ref === Number(chainId) && d.enabled
      )
    : [];

  // 当前生效的翻转状态（优先用后端返回的 pairFlip）
  const flip = (result?.pairFlip ?? localFlip) === 1;

  async function probe(
    force: boolean,
    overrides?: {
      chainId?: string;
      pool?: string;
      staker?: string;
      npm?: string;
      dexId?: string;
      needReloadFav?: boolean;
    }
  ) {
    const cId = overrides?.chainId ?? chainId;
    const p = ((overrides?.pool ?? pool) || "").trim();
    const s = overrides?.staker ?? staker;
    const dId = overrides?.dexId ?? dexId;
    const n = overrides?.npm ?? npm;
    if (!cId || !p) {
      setError("请选择链并填入池子地址");
      return;
    }

    // 同步选中池到建仓面板
    setMintChainId(Number(cId));
    setMintPool(p);

    // 根据 dexId 获取 npm 地址
    let npmAddr = n;
    if (dId && !npmAddr) {
      const selectedDex = (allDexes ?? []).find((d) => d.id === Number(dId));
      if (selectedDex) {
        npmAddr = selectedDex.npm;
      }
    }

    setLoading(true);
    setError("");
    try {
      const body: any = { chainId: Number(cId), pool: p };
      if (s && s.trim()) body.staker = s.trim();
      if (npmAddr && npmAddr.trim()) body.npm = npmAddr.trim();
      if (walletAddr) body.wallet = walletAddr;
      if (force) body.force = true;
      const r = await fetch("/api/liquidity-probe", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "探针失败");
      const data = j.data as ProbeResult;
      setResult(data);
      setLocalFlip(data.pairFlip ?? 0);

      // 同步当前探测池的两个代币与余额到第 3 段 Swap 面板（免去重复请求 /api/token-balances）
      if (data.token0 && data.token1) {
        setSwapPair({
          chainId: Number(cId),
          pool: p,
          fee: data.fee,
          token0: data.token0,
          token1: data.token1,
          token0Symbol: data.token0Symbol || short(data.token0),
          token1Symbol: data.token1Symbol || short(data.token1),
          token0Decimals: data.token0Decimals ?? 18,
          token1Decimals: data.token1Decimals ?? 18,
          balances: data.mintInit?.balances ?? null,
          pairFlip: data.pairFlip ?? 0,
          ts: Date.now(),
        });
      }

      if (overrides?.needReloadFav) {
        reloadFav();
      }
    } catch (e: any) {
      setError(e.message || "探针查询失败");
    } finally {
      setLoading(false);
    }
  }

  /** 翻转交易对 */
  async function handleFlip() {
    if (!chainId || !result) return;
    setFlipLoading(true);
    try {
      const npmAddr = dexId
        ? (allDexes ?? []).find((d) => d.id === Number(dexId))?.npm ?? npm
        : npm;
      const r = await fetch("/api/liquidity-probe/pair-flip", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: Number(chainId),
          token0: result.token0,
          token1: result.token1,
          flip: !flip,
          npm: npmAddr,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "翻转失败");
      // 翻转成功后重新探测并同步收藏、建仓与仓位卡片
      await probe(false);
      reloadFav();
      mutate("/api/positions");
    } catch (e: any) {
      alert("翻转失败：" + e.message);
    } finally {
      setFlipLoading(false);
    }
  }

  /** 收藏当前输入的查询。 */
  async function saveFavorite() {
    if (!chainId || !pool) {
      setFavMsg("请先选择链并填入池子地址");
      return;
    }
    setFavMsg("");
    try {
      let npmAddr = npm;
      if (dexId && !npmAddr) {
        const selectedDex = (allDexes ?? []).find(
          (d) => d.id === Number(dexId)
        );
        if (selectedDex) {
          npmAddr = selectedDex.npm;
        }
      }

      const r = await fetch("/api/liquidity-favorites", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: Number(chainId),
          pool,
          staker,
          npm: npmAddr,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "收藏失败");
      setFavMsg("✅ 已收藏");
      reloadFav();
    } catch (e: any) {
      setFavMsg(`❌ ${e.message}`);
    }
  }

  /** 点击收藏：立即探测 + 同步建仓面板 + 同步 Swap 双币 */
  function applyFavoriteAndProbe(f: Favorite) {
    const cStr = String(f.chain_id_ref);
    const pAddr = (f.pool_addr || "").trim();
    setChainId(cStr);
    setPool(pAddr);
    setStaker(f.staker_addr || "");
    setNpm(f.npm_addr || "");
    setMintChainId(f.chain_id_ref);
    setMintPool(pAddr);

    let matchedDexId = "";
    if (f.npm_addr) {
      const favNpmLower = (f.npm_addr || "").toLowerCase();
      const matchedDex = (allDexes ?? []).find(
        (d) => (d.npm || "").toLowerCase() === favNpmLower
      );
      if (matchedDex) {
        matchedDexId = String(matchedDex.id);
      }
    }
    setDexId(matchedDexId);

    setError("");

    let npmParam = f.npm_addr || "";
    if (!npmParam && matchedDexId) {
      const selectedDex = (allDexes ?? []).find(
        (d) => d.id === Number(matchedDexId)
      );
      if (selectedDex) {
        npmParam = selectedDex.npm;
      }
    }

    probe(false, {
      chainId: cStr,
      pool: pAddr,
      staker: f.staker_addr || "",
      npm: npmParam,
      dexId: matchedDexId,
      needReloadFav: !f.token0_symbol || !f.token1_symbol,
    });
  }

  async function deleteFavorite(id: number) {
    try {
      await fetch(`/api/liquidity-favorites/${id}`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      reloadFav();
    } catch {
      // ignore
    }
  }

  /** 切换收藏池的快速扫描监控开关（monitor_cex） */
  async function toggleFavoriteMonitor(f: Favorite) {
    try {
      await fetch(`/api/liquidity-favorites/${f.id}`, {
        method: "PATCH",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ monitor_cex: f.monitor_cex ? 0 : 1 }),
      });
      reloadFav();
    } catch {
      // ignore
    }
  }

  // 当前选中池对应的 Merkl 激励池雷达数据（Module ⑦）
  const activePoolAddr = (result?.pool || pool || mintPool || "").toLowerCase();
  const matchedPoolRadar: PoolRewardRadarItem | undefined = useMemo(() => {
    if (!activePoolAddr || !merkl?.pools) return undefined;
    return merkl.pools.find((p) => p.pool.toLowerCase() === activePoolAddr);
  }, [activePoolAddr, merkl]);

  // 实时币安双指针与套利死角分析（优先使用前端实时 WS 报价，兜底用探针返回的 result.cex）
  const probeLiveCex = useMemo(() => {
    if (!result) return null;
    const cId = Number(chainId || mintChainId || 1);
    const rt = binanceRt?.analyzePairCex(
      cId,
      result.token0,
      result.token1,
      result.token0Symbol,
      result.token1Symbol,
      Number(result.priceCurrent),
      result.currentTick,
      result.tickLower,
      result.tickUpper,
      result.fee
    );
    if (rt) return rt;
    if (result.cex && result.cex.cexRate > 0 && result.cex.dexRate > 0) {
      const span = Math.max(result.tickUpper - result.tickLower, 1);
      const tickDelta = Math.round(
        Math.log(result.cex.cexRate / result.cex.dexRate) / Math.log(1.0001)
      );
      const impliedTick = result.currentTick + tickDelta;
      const impliedMarginLowerPct =
        ((impliedTick - result.tickLower) / span) * 100;
      const impliedMarginUpperPct =
        ((result.tickUpper - impliedTick) / span) * 100;
      const feeRate = (result.fee || 3000) / 1_000_000;
      const dexMarginLowerPct =
        ((result.currentTick - result.tickLower) / span) * 100;
      const dexMarginUpperPct =
        ((result.tickUpper - result.currentTick) / span) * 100;
      return {
        token0PriceUsd: result.cex.token0Price ?? 0,
        token1PriceUsd: result.cex.token1Price ?? 1,
        token0CexSymbol: result.cex.token0CexSymbol || result.token0Symbol,
        token1CexSymbol: result.cex.token1CexSymbol || result.token1Symbol,
        cexRate: result.cex.cexRate,
        dexRate: result.cex.dexRate,
        diff: result.cex.diff,
        absDiff: result.cex.absDiff,
        feeRate,
        withinFeeDeadzone: result.cex.absDiff < feeRate,
        exceedsAlertThreshold: result.cex.absDiff >= feeRate * 2,
        isArbCritical: result.cex.absDiff >= feeRate,
        impliedTick,
        tickDelta,
        impliedInRange:
          impliedTick >= result.tickLower && impliedTick < result.tickUpper,
        impliedMarginLowerPct,
        impliedMarginUpperPct,
        dexMarginLowerPct,
        dexMarginUpperPct,
        cexMarginLowerPct: impliedMarginLowerPct,
        cexMarginUpperPct: impliedMarginUpperPct,
      };
    }
    return null;
  }, [result, chainId, mintChainId, binanceRt]);

  const cleanQty = (raw?: string) => {
    if (!raw) return "0";
    const n = Number(raw);
    return Number.isFinite(n) ? fmtTokenAmount(n) : raw;
  };

  // 探针结果：翻转后的展示计算
  const displaySym0 = result
    ? flip
      ? result.token1Symbol
      : result.token0Symbol
    : "";
  const displaySym1 = result
    ? flip
      ? result.token0Symbol
      : result.token1Symbol
    : "";
  const displayPair = result
    ? flip
      ? `${result.token1Symbol}/${result.token0Symbol}`
      : `${result.token0Symbol}/${result.token1Symbol}`
    : "";
  const displayPriceCurrent = result?.priceCurrent
    ? fmtFull(
        flip ? 1 / Number(result.priceCurrent) : Number(result.priceCurrent)
      )
    : "";
  const displayCexRate = probeLiveCex
    ? flip
      ? 1 / probeLiveCex.cexRate
      : probeLiveCex.cexRate
    : 0;
  const displayToken0Cex = probeLiveCex
    ? (flip ? probeLiveCex.token1CexSymbol : probeLiveCex.token0CexSymbol) || displaySym0
    : "";
  const displayToken1Cex = probeLiveCex
    ? (flip ? probeLiveCex.token0CexSymbol : probeLiveCex.token1CexSymbol) || displaySym1
    : "";
  // CEX 单边报价（跟随翻转换侧）
  const displayCexQuote0 = probeLiveCex
    ? (flip ? probeLiveCex.token1PriceUsd : probeLiveCex.token0PriceUsd) ?? 0
    : 0;
  const displayCexQuote1 = probeLiveCex
    ? (flip ? probeLiveCex.token0PriceUsd : probeLiveCex.token1PriceUsd) ?? 0
    : 0;
  // 翻转后流动性 amount0/amount1 也要交换，并用 fmtTokenAmount 消除 18 位尾数
  const displayAmount0 = result?.liquidity
    ? cleanQty(flip ? result.liquidity.amount1 : result.liquidity.amount0)
    : "";
  const displayAmount1 = result?.liquidity
    ? cleanQty(flip ? result.liquidity.amount0 : result.liquidity.amount1)
    : "";
  const displayStakedAmount0 = result?.stakedLiquidity
    ? cleanQty(
        flip ? result.stakedLiquidity.amount1 : result.stakedLiquidity.amount0
      )
    : "";
  const displayStakedAmount1 = result?.stakedLiquidity
    ? cleanQty(
        flip ? result.stakedLiquidity.amount0 : result.stakedLiquidity.amount1
      )
    : "";
  // 翻转后价格区间取倒数并交换 low/high
  const displayPriceLow = result?.priceLow
    ? fmtFull(flip ? 1 / Number(result.priceHigh) : Number(result.priceLow))
    : "";
  const displayPriceHigh = result?.priceHigh
    ? fmtFull(flip ? 1 / Number(result.priceLow) : Number(result.priceHigh))
    : "";

  const probeSpan = result
    ? Math.max(result.tickUpper - result.tickLower, 1)
    : 60;
  const probeOnChainPct = result
    ? ((result.currentTick - result.tickLower) / probeSpan) * 100
    : 50;
  const probeOnChainClamped = Math.min(Math.max(probeOnChainPct, 0), 100);
  const probeImpliedClamped = probeLiveCex
    ? Math.min(Math.max(probeLiveCex.impliedMarginLowerPct, 0), 100)
    : null;
  const probePullLeft =
    probeImpliedClamped !== null
      ? Math.min(probeOnChainClamped, probeImpliedClamped)
      : 0;
  const probePullWidth =
    probeImpliedClamped !== null
      ? Math.abs(probeImpliedClamped - probeOnChainClamped)
      : 0;

  return (
    <div className="card p-4 space-y-3.5">
      {/* 顶部标题 + 手动输入新池开关 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold text-ink">
            🔬 极速探针 · 建仓 · 兑换 工作台
          </h2>
          <p className="text-xs text-ink-soft">
            点选收藏池 → ① 探针检测池况 → ② 双模建仓 & 收益模拟 → ③ 双币极速兑换
          </p>
        </div>
        <button
          type="button"
          className="btn-ghost text-xs"
          onClick={() => setShowManualForm((v) => !v)}
        >
          {showManualForm ? "收起手动输入 ▲" : "＋ 手动输入新池"}
        </button>
      </div>

      {/* 折叠式手动输入表单（需要加新合约收藏或临时探测时展开） */}
      {showManualForm && (
        <div className="panel-inset p-3 space-y-2.5 text-xs">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label>
              <div className="mb-1 text-ink-soft">链</div>
              <select
                className="input"
                value={chainId}
                onChange={(e) => {
                  setChainId(e.target.value);
                  setDexId("");
                }}
              >
                <option value="">选择链</option>
                {(chains ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label>
              <div className="mb-1 text-ink-soft">DEX 平台</div>
              <select
                className="input"
                value={dexId}
                onChange={(e) => setDexId(e.target.value)}
                disabled={!chainId || availableDexes.length === 0}
              >
                <option value="">自动选择</option>
                {availableDexes.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label>
              <div className="mb-1 text-ink-soft">池子地址</div>
              <input
                className="input font-mono"
                value={pool}
                onChange={(e) => setPool(e.target.value)}
                placeholder="0x… pool 地址"
              />
            </label>

            <label>
              <div className="mb-1 text-ink-soft">质押/Vault（可选）</div>
              <input
                className="input font-mono"
                value={staker}
                onChange={(e) => setStaker(e.target.value)}
                placeholder="0x… 填入则聚合质押池 LP"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              className="btn-primary text-xs h-[30px]"
              disabled={loading || !chainId || !pool}
              onClick={() => probe(false)}
            >
              {loading ? "探测中…" : "🔬 探测并载入"}
            </button>
            <button
              type="button"
              className="btn-ghost text-xs h-[30px]"
              disabled={!chainId || !pool}
              onClick={saveFavorite}
            >
              ⭐ 收藏当前池
            </button>
            {favMsg && <span className="text-xs">{favMsg}</span>}
          </div>
        </div>
      )}

      {/* ==================== Module ⑤：收藏池点选栏（带真实费率 + 实时单格 APR 徽章） ==================== */}
      {(favorites ?? []).length > 0 && (
        <div>
          <div className="mb-1.5 flex items-center justify-between text-xs text-ink-soft">
            <span>⭐ 收藏池（点击即探测池况 + 同步建仓与双币兑换）</span>
            {loading && <span className="text-cyan-300">探测中…</span>}
          </div>
          <div className="flex flex-wrap gap-1.5">
            {(favorites ?? []).map((f) => {
              const favNpmLower = (f.npm_addr || "").toLowerCase();
              const matchedDex = favNpmLower
                ? (allDexes ?? []).find(
                    (d) => (d.npm || "").toLowerCase() === favNpmLower
                  )
                : undefined;
              const dexName = matchedDex?.name || "自动选择";
              const favRadar = merkl?.pools?.find(
                (p) => p.pool.toLowerCase() === (f.pool_addr || "").toLowerCase()
              );
              const isFavFlipped = f.pair_flip === 1;
              const sym0 = f.token0_symbol || favRadar?.symbol0 || "";
              const sym1 = f.token1_symbol || favRadar?.symbol1 || "";
              const hasPair = sym0 && sym1;
              const rawPair = hasPair
                ? isFavFlipped
                  ? `${sym1}/${sym0}`
                  : `${sym0}/${sym1}`
                : "";
              const realFee =
                f.fee && f.fee > 0
                  ? f.fee
                  : favRadar?.fee && favRadar.fee > 0
                    ? favRadar.fee
                    : null;
              const pairLabel = hasPair
                ? `${rawPair}${realFee ? ` ${realFee / 10000}%` : ""}`.trim()
                : `${f.chain_name} · ${dexName} · ${short(f.pool_addr || "")}`;

              // 避免旧 label 残留 "0%"
              const displayLabel =
                f.label && !f.label.endsWith(" 0%")
                  ? f.label
                  : pairLabel;

              const isSelected =
                Number(chainId || mintChainId) === f.chain_id_ref &&
                (pool || mintPool || "").toLowerCase() ===
                  (f.pool_addr || "").toLowerCase();

              return (
                <span
                  key={f.id}
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-xs transition ${
                    isSelected
                      ? "border-cyan-400 bg-cyan-500/20 text-white shadow-[0_0_12px_rgba(34,211,238,0.2)]"
                      : f.monitor_cex
                        ? "border-cyan-500/40 bg-cyan-500/10 text-ink"
                        : "border-white/[0.12] bg-surface-raised text-ink"
                  }`}
                >
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 font-medium hover:text-cyan-300 transition-colors"
                    title={`${f.chain_name} · ${dexName} · ${f.pool_addr}`}
                    onClick={() => applyFavoriteAndProbe(f)}
                  >
                    <span>{displayLabel}</span>
                    {isFavFlipped && (
                      <span
                        className="text-[10px] text-cyan-300"
                        title="已翻转计价"
                      >
                        ⇄
                      </span>
                    )}
                    {favRadar && (
                      <span
                        className={`rounded px-1 py-0.2 font-mono text-[10px] font-semibold ${
                          favRadar.isHighApr
                            ? "bg-amber-500/25 text-amber-200 border border-amber-400/40"
                            : "bg-emerald-500/20 text-emerald-200 border border-emerald-400/30"
                        }`}
                        title={`当前池投入 $1,000 压单格预计真实年化 ${favRadar.sim1000AprPct.toFixed(0)}% (日产 $${favRadar.sim1000DailyUsd.toFixed(1)}/d)`}
                      >
                        🔥{favRadar.sim1000AprPct.toFixed(0)}%
                      </span>
                    )}
                  </button>
                  <button
                    type="button"
                    className={`rounded px-1.5 py-0.5 text-[11px] font-medium transition ${
                      f.monitor_cex
                        ? "bg-amber-500/25 text-amber-200 border border-amber-500/40"
                        : "bg-white/[0.08] text-ink-soft hover:bg-white/[0.15] hover:text-white"
                    }`}
                    title={
                      f.monitor_cex
                        ? "CEX 差价监控：已开启（点击取消）"
                        : "CEX 差价监控：未开启（点击开启）"
                    }
                    onClick={() => toggleFavoriteMonitor(f)}
                  >
                    {f.monitor_cex ? "已监控" : "监控"}
                  </button>
                  <button
                    type="button"
                    className="text-ink-muted hover:text-rose-400 transition-colors"
                    title="删除收藏"
                    onClick={() => deleteFavorite(f.id)}
                  >
                    ✕
                  </button>
                </span>
              );
            })}
          </div>
        </div>
      )}

      {error && <div className="text-xs text-warn">❌ {error}</div>}

      {/* ==================== 第 1 段：🔬 探针检测信息（含 Module ⑥ 最小格双指针安全雷达 & Module ⑦ Merkl 三桶竞争透视） ==================== */}
      {result && (
        <div className="panel-inset p-3.5 text-xs space-y-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-cyan-300">
                ① 🔬 探针检测
              </span>
              <span className="text-sm font-semibold text-ink">
                {displayPair}
              </span>
              <span className="tag-muted">{result.fee / 10000}%</span>
              <span className="tag-muted">ts {result.tickSpacing}</span>
              {flip && (
                <span className="tag-info" title="交易对已翻转">
                  翻转
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => probe(true)}
                disabled={loading}
              >
                {loading ? "探测中…" : "重新探测"}
              </button>
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={handleFlip}
                disabled={flipLoading}
              >
                {flipLoading
                  ? "翻转中…"
                  : flip
                    ? "🔄 取消翻转"
                    : "🔄 翻转交易对"}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <PRow label="当前 tick / 最小窗口">
              <span className="font-mono">
                {result.currentTick} [{result.tickLower}, {result.tickUpper}]
                {probeLiveCex && (
                  <span className="ml-1.5 text-amber-300">
                    (⚡币安Tick {probeLiveCex.impliedTick})
                  </span>
                )}
              </span>
            </PRow>
            {result.stakedLiquidity && (
              <PRow label="窗口质押流动性">
                <span className="font-mono font-medium text-cyan-300">
                  {displayStakedAmount0} {displaySym0} / {displayStakedAmount1}{" "}
                  {displaySym1}
                  <span className="ml-1.5 font-sans text-[11px] font-normal text-ink-soft">
                    ({result.stakedPositionCount ?? 0} 仓
                    {result.stakedShareOfPool !== undefined
                      ? ` · 占窗口 ${(result.stakedShareOfPool * 100).toFixed(1)}%`
                      : ""}
                    )
                  </span>
                </span>
              </PRow>
            )}
            <PRow
              label={
                result.stakedLiquidity
                  ? "窗口流动性 (含未质押)"
                  : "窗口流动性"
              }
            >
              <span className="font-mono font-medium">
                {displayAmount0} {displaySym0} / {displayAmount1} {displaySym1}
              </span>
            </PRow>
            <PRow label="DEX 当前池价">
              <span className="font-mono">
                1 {displaySym0} ≈ {displayPriceCurrent} {displaySym1}
              </span>
            </PRow>
            <PRow label="最小窗口价格区间">
              <span className="font-mono">
                {displayPriceLow} ~ {displayPriceHigh} {displaySym1}/
                {displaySym0}
              </span>
            </PRow>
            {probeLiveCex && (
              <PRow
                label={`CEX 实时汇率 (${displayToken0Cex}÷${displayToken1Cex})`}
              >
                <span className="font-mono text-cyan-200">
                  1 {displaySym0} = {fmtFull(displayCexRate)} {displaySym1}
                </span>
              </PRow>
            )}
            {probeLiveCex && displayCexQuote0 > 0 && displayCexQuote1 > 0 && (
              <PRow
                label={`CEX 报价比值 (${displayToken0Cex}/${displayToken1Cex})`}
              >
                <span className="font-mono">
                  {fmtFull(displayCexQuote0)} / {fmtFull(displayCexQuote1)} ={" "}
                  <span className="font-semibold">
                    {fmtFull(displayCexRate)}
                  </span>
                </span>
              </PRow>
            )}
            {probeLiveCex && (
              <PRow label="CEX 实时对比">
                <span className="font-mono text-ink">
                  CEX {fmtFull(displayCexRate)} · DEX {displayPriceCurrent} ·{" "}
                  <span
                    className={
                      !probeLiveCex.withinFeeDeadzone
                        ? "text-amber-300 font-semibold"
                        : "text-emerald-300"
                    }
                  >
                    {pctSigned(probeLiveCex.diff)} (
                    {probeLiveCex.tickDelta >= 0 ? "+" : ""}
                    {probeLiveCex.tickDelta} tick)
                  </span>
                </span>
              </PRow>
            )}
            <PRow label="采样时间">
              {new Date(result.sampledAt).toLocaleString()}
            </PRow>
          </div>

          {/* ==================== Module ⑥：最小窗口双指针安全雷达 & 开仓诊断 ==================== */}
          <div className="rounded-lg border border-white/[0.08] bg-surface-0/60 p-2.5 space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1 text-[11px]">
              <span className="font-semibold text-ink">
                🧭 最小单格双指针安全雷达 [{result.tickLower}, {result.tickUpper}]
              </span>
              <span className="font-mono text-ink-soft">
                建仓配比 ≈ {(100 - probeOnChainClamped).toFixed(0)}% {result.token0Symbol} :{" "}
                {probeOnChainClamped.toFixed(0)}% {result.token1Symbol}
              </span>
            </div>

            <div className="relative h-2.5 w-full rounded bg-white/[0.1] overflow-visible">
              {/* 链上与币安之间的套利牵引区 */}
              {probeImpliedClamped !== null && probePullWidth > 0.5 && (
                <div
                  className="absolute inset-y-0 rounded bg-amber-400/30"
                  style={{
                    left: `${probePullLeft}%`,
                    width: `${probePullWidth}%`,
                  }}
                />
              )}
              {/* 链上当前 Tick */}
              <div
                className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]"
                style={{ left: `${probeOnChainClamped}%` }}
                title={`链上当前 Tick: ${result.currentTick} (${probeOnChainPct.toFixed(1)}%)`}
              />
              {/* 币安实时隐含 Tick */}
              {probeImpliedClamped !== null && probeLiveCex && (
                <div
                  className="absolute top-1/2 h-4 w-1.5 -translate-y-1/2 rounded border border-amber-200 bg-amber-400 shadow-[0_0_8px_#f59e0b]"
                  style={{ left: `${probeImpliedClamped}%` }}
                  title={`⚡ 币安隐含 Tick: ${probeLiveCex.impliedTick} (${probeLiveCex.impliedMarginLowerPct.toFixed(1)}%)`}
                />
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-1 font-mono text-[11px] text-ink-soft">
              <span>
                🔵 链上位于单格 {probeOnChainPct.toFixed(1)}% (距最近边界{" "}
                {Math.min(probeOnChainPct, 100 - probeOnChainPct).toFixed(1)}%)
              </span>
              {probeLiveCex && (
                <span
                  className={
                    probeLiveCex.impliedInRange
                      ? "text-amber-300"
                      : "text-rose-300 font-semibold"
                  }
                >
                  ⚡ 币安位于 {probeLiveCex.impliedMarginLowerPct.toFixed(1)}%
                  {!probeLiveCex.impliedInRange ? " (已出格!)" : ""}
                </span>
              )}
            </div>

            {/* 最小窗口开仓智能诊断 */}
            {probeLiveCex && (
              <div
                className={`rounded border px-2 py-1 text-[11px] ${
                  !probeLiveCex.impliedInRange
                    ? "border-rose-500/40 bg-rose-500/15 text-rose-200"
                    : !probeLiveCex.withinFeeDeadzone
                      ? "border-amber-500/40 bg-amber-500/15 text-amber-200"
                      : Math.min(probeOnChainPct, 100 - probeOnChainPct) < 15
                        ? "border-amber-500/35 bg-amber-500/10 text-amber-200"
                        : "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                }`}
              >
                {!probeLiveCex.impliedInRange ? (
                  <span>
                    🚨 <strong>开仓预警</strong>：币安隐含 Tick (
                    {probeLiveCex.impliedTick}) 已在当前最小格 [
                    {result.tickLower}, {result.tickUpper}] 之外！若直接开当前格，套利推平后可能秒越界，建议点下方「⚡ 按币安实时价居中窗口」或使用「🛡️ 0 ~ 现价略高」模式。
                  </span>
                ) : !probeLiveCex.withinFeeDeadzone ? (
                  <span>
                    ⚠️ <strong>套利临界</strong>：当前价差{" "}
                    {(probeLiveCex.absDiff * 100).toFixed(2)}% ≥ 池费{" "}
                    {(probeLiveCex.feeRate * 100).toFixed(2)}%，机器人即将把 Tick 推向{" "}
                    {probeLiveCex.impliedTick}（窗口 {probeLiveCex.impliedMarginLowerPct.toFixed(0)}% 处）。
                  </span>
                ) : Math.min(probeOnChainPct, 100 - probeOnChainPct) < 15 ? (
                  <span>
                    ⚠️ <strong>贴边提醒</strong>：链上 Tick 距当前格边界仅{" "}
                    {Math.min(probeOnChainPct, 100 - probeOnChainPct).toFixed(0)}%，单格较易越界，可考虑「🛡️ 0 ~ 现价略高」模式。
                  </span>
                ) : (
                  <span>
                    🟢 <strong>最小格安全</strong>：链上与币安双指针均在格内安全区，且价差{" "}
                    {(probeLiveCex.absDiff * 100).toFixed(2)}% 处于 0.30% 手续费死角内。
                  </span>
                )}
              </div>
            )}
          </div>

          {/* ==================== Module ⑦：本池 Merkl 激励预算 & 50/25/25 三桶竞争透视 ==================== */}
          {matchedPoolRadar && (
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="font-semibold text-ink">
                  🎁 本池 Merkl 奖励预算：{" "}
                  <span className="font-mono text-emerald-300">
                    {matchedPoolRadar.dailyW0g.toFixed(0)} W0G/天 (≈ $
                    {matchedPoolRadar.dailyRewardUsd.toFixed(1)}/d)
                  </span>
                </span>
                <span className="rounded bg-amber-500/25 px-1.5 py-0.5 font-mono text-[11px] font-bold text-amber-200 border border-amber-400/35">
                  🔥 千刀单格 APR {matchedPoolRadar.sim1000AprPct.toFixed(0)}%
                </span>
              </div>

              <div className="grid grid-cols-3 gap-1.5 font-mono text-[10.5px]">
                <div className="rounded border border-emerald-500/30 bg-surface-0/70 p-1.5 space-y-0.5">
                  <div className="font-sans font-semibold text-emerald-300">
                    ⚡ 活跃L桶 (60%)
                  </div>
                  <div className="text-ink">
                    ${(matchedPoolRadar.dailyActiveLUsd ?? matchedPoolRadar.dailyRewardUsd * 0.6).toFixed(1)}/天
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    窄幅对手: ${matchedPoolRadar.narrowStakedTvlUsd.toFixed(0)} (
                    {matchedPoolRadar.narrowPositionCount}仓)
                  </div>
                  <div className="text-[10px] text-emerald-200">
                    投$1k占 {(matchedPoolRadar.sim1000ActiveLShare * 100).toFixed(1)}%
                  </div>
                </div>

                <div className="rounded border border-white/[0.1] bg-surface-0/70 p-1.5 space-y-0.5">
                  <div className="font-sans font-semibold text-cyan-200">
                    🪙 {matchedPoolRadar.symbol0 || result.token0Symbol}桶 (20%)
                  </div>
                  <div className="text-ink">
                    ${(matchedPoolRadar.dailyToken0Usd ?? matchedPoolRadar.dailyRewardUsd * 0.2).toFixed(1)}/天
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    池内质押: ${(matchedPoolRadar.stakedToken0Usd ?? 0).toFixed(0)}
                  </div>
                  <div className="text-[10px] text-amber-200 font-semibold">
                    被动补贴 APR {(matchedPoolRadar.token0BucketAprPct ?? 0).toFixed(0)}%
                  </div>
                </div>

                <div className="rounded border border-white/[0.1] bg-surface-0/70 p-1.5 space-y-0.5">
                  <div className="font-sans font-semibold text-cyan-200">
                    💵 {matchedPoolRadar.symbol1 || result.token1Symbol}桶 (20%)
                  </div>
                  <div className="text-ink">
                    ${(matchedPoolRadar.dailyToken1Usd ?? matchedPoolRadar.dailyRewardUsd * 0.2).toFixed(1)}/天
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    池内质押: ${(matchedPoolRadar.stakedToken1Usd ?? 0).toFixed(0)}
                  </div>
                  <div className="text-[10px] text-amber-200 font-semibold">
                    被动补贴 APR {(matchedPoolRadar.token1BucketAprPct ?? 0).toFixed(0)}%
                  </div>
                </div>
              </div>

              {/* 补贴甜点提示 */}
              {matchedPoolRadar.token0BucketAprPct !== undefined &&
                matchedPoolRadar.token1BucketAprPct !== undefined && (
                  <div className="text-[11px] text-cyan-100/90 font-sans">
                    💡 <strong>持币补贴甜点</strong>：当前池内{" "}
                    <span className="font-mono font-semibold text-amber-200">
                      {matchedPoolRadar.token1BucketAprPct >=
                      matchedPoolRadar.token0BucketAprPct
                        ? matchedPoolRadar.symbol1 || result.token1Symbol
                        : matchedPoolRadar.symbol0 || result.token0Symbol}
                    </span>{" "}
                    侧质押资金较少（仅 $
                    {Math.min(
                      matchedPoolRadar.stakedToken0Usd ?? 0,
                      matchedPoolRadar.stakedToken1Usd ?? 0
                    ).toFixed(0)}
                    ），单靠 20% 持币桶被动年化即达{" "}
                    <span className="font-mono font-semibold text-amber-200">
                      {Math.max(
                        matchedPoolRadar.token0BucketAprPct,
                        matchedPoolRadar.token1BucketAprPct
                      ).toFixed(0)}
                      % APR
                    </span>
                    ！
                  </div>
                )}
            </div>
          )}
        </div>
      )}

      {/* ==================== 第 2 段：➕ 极速建仓 & 自动质押（含 Module ⑧ 双模建仓 & 实时收益模拟器） ==================== */}
      <MintPositionPanel
        chainId={mintChainId || Number(chainId) || 0}
        pool={mintPool || pool}
        externalData={result?.mintInit}
        probeLoading={loading}
        poolRadar={matchedPoolRadar}
        liveCex={probeLiveCex}
        w0gPriceUsd={merkl?.w0gPriceUsd}
        binanceRt={binanceRt}
        collapsed={mintCollapsed}
        onToggleCollapse={() => setMintCollapsed((v) => !v)}
        onCreated={() => {
          mutate("/api/positions");
          mutate("/api/merkl-rewards");
        }}
        onFlipChanged={() => {
          reloadFav();
          if (chainId && pool) probe(false);
        }}
      />

      {/* ==================== 第 3 段：💱 当前池双币极速兑换 ==================== */}
      <SwapQuoteSection
        externalPair={swapPair}
        embedded
        collapsed={swapCollapsed}
        onToggleCollapse={() => setSwapCollapsed((v) => !v)}
      />
    </div>
  );
}

function PRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2 py-0.5">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all text-ink">{children}</span>
    </div>
  );
}
