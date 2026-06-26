"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, short } from "./util";

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
  priceLabel: string;
  fee: number;
  token0Symbol: string;
  token1Symbol: string;
  sampledAt: string;
  cached?: boolean;
}

interface Chain {
  id: number;
  name: string;
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
}

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
  const { data: favorites, mutate: reloadFav } = useSWR<Favorite[]>("/api/liquidity-favorites", fetcher);
  const [chainId, setChainId] = useState("");
  const [pool, setPool] = useState("");
  const [staker, setStaker] = useState("");
  const [npm, setNpm] = useState("");
  const [result, setResult] = useState<ProbeResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [favMsg, setFavMsg] = useState("");

  async function probe(force: boolean, overrides?: { chainId?: string; pool?: string; staker?: string; npm?: string }) {
    const cId = overrides?.chainId ?? chainId;
    const p = overrides?.pool ?? pool;
    const s = overrides?.staker ?? staker;
    const n = overrides?.npm ?? npm;
    if (!cId || !p) {
      setError("请选择链并填入池子地址");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const body: any = { chainId: Number(cId), pool: p.trim() };
      if (s && s.trim()) body.staker = s.trim();
      if (n && n.trim()) body.npm = n.trim();
      if (force) body.force = true;
      const r = await fetch("/api/liquidity-probe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "探针失败");
      setResult(j.data as ProbeResult);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
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
      const r = await fetch("/api/liquidity-favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chain_id: Number(chainId),
          pool,
          staker,
          npm,
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
    setError("");
    setResult(null);
    probe(false, {
      chainId: String(f.chain_id_ref),
      pool: f.pool_addr,
      staker: f.staker_addr || "",
      npm: f.npm_addr || "",
    });
  }

  async function deleteFavorite(id: number) {
    try {
      await fetch(`/api/liquidity-favorites/${id}`, { method: "DELETE" });
      reloadFav();
    } catch {
      // ignore
    }
  }

  return (
    <div className="card p-4">
      <div className="mb-2 flex items-center gap-2">
        <h2 className="text-sm font-semibold">🔬 最小区间流动性探针</h2>
        <span className="text-xs text-ink-soft">给定池子，算 fee→tickSpacing 最小窗口的流动性与价格区间</span>
      </div>

      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">链</div>
          <select className="input" value={chainId} onChange={(e) => setChainId(e.target.value)}>
            <option value="">选择链</option>
            {(chains ?? []).map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
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
            {(favorites ?? []).map((f) => (
              <span
                key={f.id}
                className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs"
              >
                <button
                  className="hover:text-ink"
                  title={`${f.chain_name} · ${f.pool_addr}${f.staker_addr ? " · " + f.staker_addr : ""}`}
                  onClick={() => applyFavoriteAndProbe(f)}
                >
                  {f.label || `${f.chain_name} · ${short(f.pool_addr)}`}
                </button>
                <button
                  className="text-ink-soft hover:text-warn"
                  title="删除收藏"
                  onClick={() => deleteFavorite(f.id)}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-warn">{error}</div>}

      {result && (
        <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-xs">
          <div className="mb-2 flex items-center gap-2">
            <span className="font-semibold">{result.token0Symbol}/{result.token1Symbol}</span>
            <span className="tag-muted">fee {result.fee / 10000}%</span>
            <span className="tag-muted">tickSpacing {result.tickSpacing}</span>
            {result.cached && <span className="text-[10px] text-ink-soft">缓存命中</span>}
          </div>
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            <PRow label="当前 tick">{result.currentTick}</PRow>
            <PRow label="最小窗口">[{result.tickLower}, {result.tickUpper}]</PRow>
            <PRow label="窗口流动性 token0">{result.liquidity.amount0} {result.token0Symbol}</PRow>
            <PRow label="窗口流动性 token1">{result.liquidity.amount1} {result.token1Symbol}</PRow>
            <PRow label="价格下界">{result.priceLow}</PRow>
            <PRow label="价格上界">{result.priceHigh}</PRow>
            <PRow label="价格单位">{result.priceLabel}</PRow>
            <PRow label="采样时间">{new Date(result.sampledAt).toLocaleString()}</PRow>
          </div>

          {/* 当前 tick 在最小窗口内的位置 */}
          <div className="mt-2">
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

          <div className="mt-2">
            <button className="btn-ghost text-xs" onClick={() => probe(true)}>强制刷新</button>
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
