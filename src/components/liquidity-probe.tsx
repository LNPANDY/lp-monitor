"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short } from "./util";

/**
 * 最小区间探针结果（场景C），与后端 MinRangeProbeResult 对齐。
 */
interface ProbeResult {
  tickSpacing: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  liquidity: { amount0: string; amount1: string };
  priceLow: string;
  priceHigh: string;
  priceCurrent: string;
  priceLabel: string;
  fee: number;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  sampledAt: string;
  cached?: boolean;
  pairFlip?: number;
  cex?: CexPricePayload;
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
}

/** 展开小数，避免科学计数法 */
function fmtFull(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  let s = Math.abs(n) < 1 ? n.toFixed(18) : n.toFixed(8);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (/[eE]/.test(s)) {
    const neg = n < 0;
    const parts = s.replace(/-/g, "").split(/[eE]/);
    const exp = parseInt(parts[1]);
    const base = parts[0].replace(".", "");
    if (exp > 0) {
      s = base + "0".repeat(exp - (parts[0].includes(".") ? parts[0].split(".")[1].length : 0));
    }
  }
  return s === "" || s === "-" ? "0" : s;
}

const pctSigned = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;

/**
 * 最小区间流动性探针（场景C）+ 收藏。
 *
 * 用户选择链 + 填入池子地址（+可选 staker/vault），探针计算该池 fee 对应
 * tickSpacing 的最小窗口内的流动性与价格区间。
 * 提供 staker 时额外枚举 vault 同池子 LP 做聚合。
 * 支持「收藏当前查询」与「一键加载收藏后立即探测」。
 */
export function LiquidityProbe() {
  const { data: chains } = useSWR<Chain[]>("/api/chains", fetcher);
  const { data: allDexes } = useSWR<Dex[]>("/api/dexes", fetcher);
  const { data: favorites, mutate: reloadFav } = useSWR<Favorite[]>("/api/liquidity-favorites", fetcher);
  const [chainId, setChainId] = useState("");
  const [dexId, setDexId] = useState("");
  const [pool, setPool] = useState("");
  const [staker, setStaker] = useState("");
  const [npm, setNpm] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [favMsg, setFavMsg] = useState("");
  // 翻转状态（来自后端返回，或本地切换暂存）
  const [localFlip, setLocalFlip] = useState(0);
  const [flipLoading, setFlipLoading] = useState(false);

  // 根据选择的链过滤可用的 DEX
  const availableDexes = chainId ? (allDexes ?? []).filter(d => d.chain_id_ref === Number(chainId) && d.enabled) : [];

  // 当前生效的翻转状态（优先用后端返回的 pairFlip）
  const flip = (result?.pairFlip ?? localFlip) === 1;

  async function probe(force: boolean, overrides?: { chainId?: string; pool?: string; staker?: string; npm?: string; dexId?: string }) {
    const cId = overrides?.chainId ?? chainId;
    const p = overrides?.pool ?? pool;
    const s = overrides?.staker ?? staker;
    const dId = overrides?.dexId ?? dexId;
    const n = overrides?.npm ?? npm;
    if (!cId || !p) {
      setError("请选择链并填入池子地址");
      return;
    }

    // 根据 dexId 获取 npm 地址
    let npmAddr = n;
    if (dId && !npmAddr) {
      const selectedDex = (allDexes ?? []).find(d => d.id === Number(dId));
      if (selectedDex) {
        npmAddr = selectedDex.npm;
      }
    }

    setLoading(true);
    setError("");
    try {
      const body: any = { chainId: Number(cId), pool: p.trim() };
      if (s && s.trim()) body.staker = s.trim();
      if (npmAddr && npmAddr.trim()) body.npm = npmAddr.trim();
      if (force) body.force = true;
      const r = await fetch("/api/liquidity-probe", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "探针失败");
      setResult(j.data as ProbeResult);
      setLocalFlip(j.data.pairFlip ?? 0);
      // 探针成功后刷新收藏列表——后端会把 token symbol 写回 favorites，
      // 刷新后收藏标签即可显示真实 symbol（如 W0G/USDC.e）而非地址回退
      reloadFav();
    } catch (e: any) {
      setError(e.message);
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
        ? (allDexes ?? []).find(d => d.id === Number(dexId))?.npm ?? npm
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
      // 翻转成功后重新探测，让后端返回最新 pairFlip + cex
      await probe(false);
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
      // 根据 dexId 获取 npm 地址
      let npmAddr = npm;
      if (dexId && !npmAddr) {
        const selectedDex = (allDexes ?? []).find(d => d.id === Number(dexId));
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

  /** 加载某条收藏到表单并立即探测。 */
  function applyFavoriteAndProbe(f: Favorite) {
    setChainId(String(f.chain_id_ref));
    setPool(f.pool_addr);
    setStaker(f.staker_addr || "");
    setNpm(f.npm_addr || "");

    // 尝试根据 npm 地址找到对应的 DEX
    let matchedDexId = "";
    if (f.npm_addr) {
      const matchedDex = (allDexes ?? []).find(d => d.npm.toLowerCase() === f.npm_addr.toLowerCase());
      if (matchedDex) {
        matchedDexId = String(matchedDex.id);
      }
    }
    setDexId(matchedDexId);

    setError("");
    setResult(null);

    // 准备 npm 参数（优先使用收藏中的 npm）
    let npmParam = f.npm_addr;
    if (!npmParam && matchedDexId) {
      const selectedDex = (allDexes ?? []).find(d => d.id === Number(matchedDexId));
      if (selectedDex) {
        npmParam = selectedDex.npm;
      }
    }

    probe(false, {
      chainId: String(f.chain_id_ref),
      pool: f.pool_addr,
      staker: f.staker_addr || "",
      npm: npmParam,
      dexId: matchedDexId,
    });
  }

  async function deleteFavorite(id: number) {
    try {
      await fetch(`/api/liquidity-favorites/${id}`, { method: "DELETE", headers: authHeaders() });
      reloadFav();
    } catch {
      // ignore
    }
  }

  // 探针结果：翻转后的展示计算
  const displaySym0 = result ? (flip ? result.token1Symbol : result.token0Symbol) : "";
  const displaySym1 = result ? (flip ? result.token0Symbol : result.token1Symbol) : "";
  const displayPair = result ? (flip ? `${result.token1Symbol}/${result.token0Symbol}` : `${result.token0Symbol}/${result.token1Symbol}`) : "";
  const displayPriceCurrent = result?.priceCurrent
    ? fmtFull(flip ? 1 / Number(result.priceCurrent) : Number(result.priceCurrent))
    : "";
  const displayCexRate = result?.cex ? (flip ? 1 / result.cex.cexRate : result.cex.cexRate) : 0;
  const displayToken0Cex = result?.cex ? (flip ? result.cex.token1CexSymbol : result.cex.token0CexSymbol) : "";
  const displayToken1Cex = result?.cex ? (flip ? result.cex.token0CexSymbol : result.cex.token1CexSymbol) : "";
  // 翻转后流动性 amount0/amount1 也要交换：amount0 对应 token0，翻转后显示口径为 token1/token0
  const displayAmount0 = result ? (flip ? result.liquidity.amount1 : result.liquidity.amount0) : "";
  const displayAmount1 = result ? (flip ? result.liquidity.amount0 : result.liquidity.amount1) : "";
  // 翻转后价格区间取倒数并交换 low/high（1 token0=? token1 → 1 token1=? token0）
  const displayPriceLow = result?.priceLow
    ? fmtFull(flip ? 1 / Number(result.priceHigh) : Number(result.priceLow))
    : "";
  const displayPriceHigh = result?.priceHigh
    ? fmtFull(flip ? 1 / Number(result.priceLow) : Number(result.priceHigh))
    : "";

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">🔬 最小区间流动性探针</h2>
        <span className="text-xs text-ink-soft">给定池子，算 fee→tickSpacing 最小窗口的流动性与价格区间</span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">链</div>
          <select
            className="input"
            value={chainId}
            onChange={(e) => {
              setChainId(e.target.value);
              setDexId(""); // 链变化时重置 DEX 选择
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

        <label className="text-xs">
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

        <label className="text-xs">
          <div className="mb-1 text-ink-soft">池子地址</div>
          <input
            className="input w-[320px]"
            value={pool}
            onChange={(e) => setPool(e.target.value)}
            placeholder="0x… pool 地址"
          />
        </label>

        <label className="text-xs">
          <div className="mb-1 text-ink-soft">质押/Vault（可选）</div>
          <input
            className="input w-[260px]"
            value={staker}
            onChange={(e) => setStaker(e.target.value)}
            placeholder="填入则枚举 vault 同池 LP 聚合"
          />
        </label>

        <button
          className="btn-primary text-xs"
          disabled={loading || !chainId || !pool}
          onClick={() => probe(false)}
        >
          {loading ? "探测中…" : "探测"}
        </button>
        <button className="btn-ghost text-xs" disabled={!chainId || !pool} onClick={saveFavorite}>
          ⭐ 收藏当前
        </button>
      </div>
      {favMsg && <div className="mt-1 text-xs">{favMsg}</div>}

      {/* 收藏列表 */}
      {(favorites ?? []).length > 0 && (
        <div className="mt-3">
          <div className="mb-1 text-xs text-ink-soft">收藏（点击一键查询）</div>
          <div className="flex flex-wrap gap-1.5">
            {(favorites ?? []).map((f) => {
              // 尝试找到收藏对应的 DEX
              const matchedDex = (allDexes ?? []).find(d => d.npm.toLowerCase() === f.npm_addr.toLowerCase());
              const dexName = matchedDex?.name || "自动选择";
              // 优先用快照里的 token symbol + fee 组成交易对标签；缺失则回退到链名+DEX
              const hasPair = f.token0_symbol && f.token1_symbol;
              const pairLabel = hasPair
                ? `${f.token0_symbol}/${f.token1_symbol} ${f.fee != null ? (f.fee / 10000) + "%" : ""}`.trim()
                : `${f.chain_name} · ${dexName} · ${short(f.pool_addr)}`;

              return (
                <span
                  key={f.id}
                  className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
                >
                  <button
                    className="hover:text-ink"
                    title={`${f.chain_name} · ${dexName} · ${f.pool_addr}${f.staker_addr ? " · " + f.staker_addr : ""}`}
                    onClick={() => applyFavoriteAndProbe(f)}
                  >
                    {f.label || pairLabel}
                  </button>
                  <button
                    className="text-ink-soft hover:text-warn"
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

      {error && <div className="mt-2 text-xs text-warn">{error}</div>}

      {result && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="mb-1.5 flex items-center gap-2">
            <span className="font-semibold">{displayPair}</span>
            <span className="tag-muted">{result.fee / 10000}%</span>
            <span className="tag-muted">ts {result.tickSpacing}</span>
            {flip && (
              <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded" title="交易对已翻转">
                翻转
              </span>
            )}
          </div>
          <div className="space-y-0.5">
            <PRow label="当前 tick / 窗口">
              {result.currentTick} [{result.tickLower}, {result.tickUpper}]
            </PRow>
            <PRow label="窗口流动性">
              {displayAmount0} {displaySym0} / {displayAmount1} {displaySym1}
            </PRow>
            <PRow label="当前价格">
              1 {displaySym0} ≈ {displayPriceCurrent} {displaySym1}
            </PRow>
            <PRow label="价格区间">
              {displayPriceLow} ~ {displayPriceHigh} {displaySym1}/{displaySym0}
            </PRow>
            {result.cex && displayToken0Cex && displayToken1Cex && (
              <PRow label={`CEX 汇率 (${displayToken0Cex}÷${displayToken1Cex})`}>
                <span>1 {displaySym0} = {fmtFull(displayCexRate)} {displaySym1}</span>
              </PRow>
            )}
            {result.cex && (
              <PRow label="CEX差价">
                <span className={result.cex.absDiff >= 0.01 ? "text-warn font-semibold" : ""}>
                  {pctSigned(result.cex.diff)}
                </span>
              </PRow>
            )}
            <PRow label="采样时间">{new Date(result.sampledAt).toLocaleString()}</PRow>
          </div>

          {/* 当前 tick 在最小窗口内的位置 */}
          <div className="mt-1.5">
            <div className="relative h-2 w-full rounded bg-slate-200">
              <div
                className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded bg-ink"
                style={{
                  left: `${Math.min(
                    Math.max(((result.currentTick - result.tickLower) / Math.max(result.tickUpper - result.tickLower, 1)) * 100, 0),
                    100
                  )}%`,
                }}
              />
            </div>
          </div>

          <div className="mt-1.5 flex gap-2">
            <button className="btn-ghost text-xs" onClick={() => probe(true)}>重新探测</button>
            <button className="btn-ghost text-xs" onClick={handleFlip} disabled={flipLoading}>
              {flipLoading ? "翻转中…" : flip ? "🔄 取消翻转" : "🔄 翻转交易对"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function PRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all">{children}</span>
    </div>
  );
}
