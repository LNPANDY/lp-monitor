"use client";
import { useState, useEffect } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, fmtFull } from "./util";
import { MintPositionPanel } from "./mint-position-panel";
import { toast } from "./toast";

interface Favorite {
  id: number;
  chain_id_ref: number;
  chain_name: string;
  label: string;
  pool_addr: string;
  staker_addr: string;
  npm_addr: string;
  token0?: string;
  token1?: string;
  token0_symbol: string;
  token1_symbol: string;
  fee: number | null;
  monitor_cex: number;
  pair_flip?: number;
}

export function LiquidityProbe({
  externalPool,
}: {
  externalPool?: { chainId: number; pool: string; ts: number } | null;
}) {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: allStaking } = useSWR<any[]>("/api/staking", fetcher);
  const { data: favorites, mutate: reloadFav } = useSWR<Favorite[]>(
    "/api/liquidity-favorites",
    fetcher
  );

  const [chainId, setChainId] = useState<number | "">("");
  const [poolAddr, setPoolAddr] = useState("");
  const [stakerAddr, setStakerAddr] = useState("");
  const [favLabel, setFavLabel] = useState("");
  const [showManualSearch, setShowManualSearch] = useState(false);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<any | null>(null);

  // 建仓面板联动状态：默认直接展开，点任意收藏池即同步切换探针 + 建仓池
  const [showMint, setShowMint] = useState(true);
  const [mintChainId, setMintChainId] = useState<number>(0);
  const [mintPool, setMintPool] = useState<string>("");

  const favList = favorites ?? [];
  const chainStaking = (allStaking ?? []).filter(
    (s) => s.enabled && (!chainId || s.chain_id_ref === Number(chainId))
  );

  // 首次拿到收藏列表时，默认自动选中第一个收藏池到建仓面板（方便一打开页面就能直接操作）
  useEffect(() => {
    if (favList.length > 0 && !mintPool && !externalPool) {
      const f = favList[0];
      setMintChainId(f.chain_id_ref);
      setMintPool(f.pool_addr);
      setChainId(f.chain_id_ref);
      setPoolAddr(f.pool_addr);
      setStakerAddr(f.staker_addr || "");
    }
  }, [favList, mintPool, externalPool]);

  // 响应从左侧仓位卡片传来的「🔄 撤池重开」或「🎯 载入建仓台」指令
  useEffect(() => {
    if (externalPool && externalPool.pool) {
      setChainId(externalPool.chainId);
      setPoolAddr(externalPool.pool);
      setMintChainId(externalPool.chainId);
      setMintPool(externalPool.pool);
      setShowMint(true);
      doQuery({
        chainId: externalPool.chainId,
        pool: externalPool.pool,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [externalPool?.ts]);

  async function doQuery(params: {
    chainId: number;
    pool: string;
    staker?: string;
    npm?: string;
  }) {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/liquidity-probe", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chainId: params.chainId,
          pool: params.pool.trim(),
          staker: params.staker?.trim() || undefined,
          npm: params.npm?.trim() || undefined,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "查询失败");
      setResult(j.data);
      // 探针成功后，后端已自动把 token0/token1/symbol 写回收藏表，刷新收藏显示并同步建仓面板
      reloadFav();
      if (j.data?.pool) {
        setMintChainId(params.chainId);
        setMintPool(j.data.pool);
      }
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message || "探针查询失败");
    } finally {
      setLoading(false);
    }
  }

  /** 点收藏项：一键同时触发「流动性探测」+「建仓面板载入该池」 */
  function applyFavoriteAndProbe(f: Favorite) {
    setChainId(f.chain_id_ref);
    setPoolAddr(f.pool_addr);
    setStakerAddr(f.staker_addr || "");
    setMintChainId(f.chain_id_ref);
    setMintPool(f.pool_addr);
    setShowMint(true);
    doQuery({
      chainId: f.chain_id_ref,
      pool: f.pool_addr,
      staker: f.staker_addr,
      npm: f.npm_addr,
    });
  }

  async function saveFavorite() {
    if (!result || !chainId) return;
    try {
      const r = await fetch("/api/liquidity-favorites", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: Number(chainId),
          pool: result.pool,
          staker: stakerAddr.trim(),
          label: favLabel.trim(),
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setFavLabel("");
      reloadFav();
      toast.success("已添加到收藏池");
    } catch (e: any) {
      toast.error(e.message || "保存收藏失败");
    }
  }

  async function removeFavorite(id: number) {
    await fetch(`/api/liquidity-favorites/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    reloadFav();
    toast.info("已移除收藏池");
  }

  async function toggleFavCexMonitor(f: Favorite) {
    await fetch(`/api/liquidity-favorites/${f.id}`, {
      method: "PATCH",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ monitor_cex: f.monitor_cex ? 0 : 1 }),
    });
    reloadFav();
    toast.info(
      f.monitor_cex ? "已关闭该收藏池的 CEX 差价监控" : "已开启该收藏池的 CEX 差价监控"
    );
  }

  async function handleFlip() {
    if (!result || !chainId) return;
    try {
      const r = await fetch("/api/liquidity-probe/pair-flip", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: Number(chainId),
          token0: result.token0,
          token1: result.token1,
          flip: result.pairFlip !== 1,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "翻转失败");
      await doQuery({
        chainId: Number(chainId),
        pool: result.pool,
        staker: stakerAddr,
      });
      reloadFav();
      mutate("/api/positions");
      toast.success("已翻转交易对计价方向（全局同步）");
    } catch (e: any) {
      toast.error(e.message || "翻转失败");
    }
  }

  function fmtAmt(s: string) {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n === 0) return "0";
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return n.toPrecision(4);
  }

  const isAlreadyFav =
    result &&
    chainId &&
    favList.some(
      (f) =>
        f.chain_id_ref === Number(chainId) &&
        f.pool_addr.toLowerCase() === result.pool.toLowerCase()
    );

  // 根据 pairFlip 处理探针结果展示
  const isResultFlipped = result?.pairFlip === 1;
  const resBaseSym = result
    ? isResultFlipped
      ? result.token1Symbol
      : result.token0Symbol
    : "";
  const resQuoteSym = result
    ? isResultFlipped
      ? result.token0Symbol
      : result.token1Symbol
    : "";
  const resPriceCurrent = result
    ? isResultFlipped && Number(result.priceCurrent) > 0
      ? 1 / Number(result.priceCurrent)
      : Number(result.priceCurrent)
    : 0;
  const resPriceLow = result
    ? isResultFlipped && Number(result.priceHigh) > 0
      ? 1 / Number(result.priceHigh)
      : Number(result.priceLow)
    : 0;
  const resPriceHigh = result
    ? isResultFlipped && Number(result.priceLow) > 0
      ? 1 / Number(result.priceLow)
      : Number(result.priceHigh)
    : 0;
  const resPrimaryAmt = result?.total
    ? isResultFlipped
      ? result.total.amount1
      : result.total.amount0
    : "0";
  const resSecondaryAmt = result?.total
    ? isResultFlipped
      ? result.total.amount0
      : result.total.amount1
    : "0";

  return (
    <div className="space-y-3">
      {/* 1. 收藏池快捷工作条（点击即探针 + 同步建仓池） */}
      <div className="card p-3.5 space-y-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-ink-soft">
              ★ 收藏池工作台
            </span>
            <span className="text-[11px] text-ink-muted">
              (点选自动探测深度并载入建仓)
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setShowManualSearch((v) => !v)}
              className={`btn-ghost btn-xs ${
                showManualSearch
                  ? "border-brand/40 text-brand-light bg-brand/10"
                  : ""
              }`}
            >
              {showManualSearch ? "收起手动查池" : "➕ 手动查池/加收藏"}
            </button>
          </div>
        </div>

        {favList.length === 0 ? (
          <div className="rounded-lg border border-dashed border-white/[0.1] p-3 text-xs text-ink-soft">
            暂无收藏池。请点击右上角「➕ 手动查池/加收藏」查询一次池地址并点击「☆ 收藏此池」。
          </div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {favList.map((f) => {
              const flipped = f.pair_flip === 1;
              const pairLabel =
                f.token0_symbol && f.token1_symbol
                  ? flipped
                    ? `${f.token1_symbol}/${f.token0_symbol}`
                    : `${f.token0_symbol}/${f.token1_symbol}`
                  : f.label || short(f.pool_addr);
              const feePct = f.fee ? `${(f.fee / 10000).toFixed(2)}%` : "";
              const isSelected =
                mintChainId === f.chain_id_ref &&
                mintPool.toLowerCase() === f.pool_addr.toLowerCase();

              return (
                <div
                  key={f.id}
                  className={`group inline-flex items-center gap-1 rounded-lg border px-2 py-1 text-xs transition ${
                    isSelected
                      ? "border-brand bg-brand/15 text-ink shadow-glow-cyan"
                      : "border-white/[0.08] bg-surface-raised/70 text-ink-soft hover:border-white/[0.18] hover:text-ink"
                  }`}
                >
                  <button
                    type="button"
                    className="flex items-center gap-1 text-left"
                    onClick={() => applyFavoriteAndProbe(f)}
                    title={`${f.chain_name} · ${f.pool_addr}\n点击探测最小区间流动性并加载至建仓面板`}
                  >
                    <span className="font-semibold text-ink">{pairLabel}</span>
                    {flipped && (
                      <span
                        className="text-[10px] text-brand-light"
                        title="已翻转计价"
                      >
                        ⇄
                      </span>
                    )}
                    {feePct && (
                      <span className="font-mono text-[10px] text-ink-muted">
                        {feePct}
                      </span>
                    )}
                    {f.label && f.token0_symbol && (
                      <span className="rounded bg-brand/15 px-1 text-[10px] text-brand-light">
                        {f.label}
                      </span>
                    )}
                  </button>

                  <div className="ml-0.5 flex items-center gap-1 border-l border-white/[0.08] pl-1">
                    <button
                      type="button"
                      onClick={() => toggleFavCexMonitor(f)}
                      className={`rounded px-1 text-[10px] transition ${
                        f.monitor_cex
                          ? "bg-ok/20 text-ok font-medium"
                          : "text-ink-muted hover:text-ink-soft"
                      }`}
                      title={
                        f.monitor_cex
                          ? "CEX 差价监控已开启（点击关闭）"
                          : "开启该收藏池的 CEX 差价监控与推送"
                      }
                    >
                      CEX
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFavorite(f.id)}
                      className="text-[10px] text-ink-muted opacity-60 hover:opacity-100 hover:text-danger"
                      title="删除该收藏"
                    >
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 手动查询/新增收藏折叠抽屉 */}
        {showManualSearch && (
          <div className="mt-2 rounded-lg border border-white/[0.08] bg-surface-raised/60 p-3 space-y-2">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                className="input text-xs"
                value={chainId}
                onChange={(e) => {
                  setChainId(e.target.value ? Number(e.target.value) : "");
                  setStakerAddr("");
                }}
              >
                <option value="">选择链</option>
                {(chains ?? [])
                  .filter((c) => c.enabled)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
              </select>

              <input
                className="input font-mono text-xs sm:col-span-2"
                value={poolAddr}
                onChange={(e) => setPoolAddr(e.target.value)}
                placeholder="V3 池子合约地址 0x…"
              />
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                className="input text-xs flex-1"
                value={stakerAddr}
                onChange={(e) => setStakerAddr(e.target.value)}
              >
                <option value="">可选：关联质押合约（统计质押池同窗口深度）</option>
                {chainStaking.map((s) => (
                  <option key={s.id} value={s.contract}>
                    {s.platform} · {s.pair_label} ({short(s.contract)})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn-primary text-xs shrink-0"
                disabled={loading || !chainId || !poolAddr.trim()}
                onClick={() =>
                  doQuery({
                    chainId: Number(chainId),
                    pool: poolAddr,
                    staker: stakerAddr,
                  })
                }
              >
                {loading ? "探测中…" : "探测并载入"}
              </button>
            </div>
          </div>
        )}

        {/* 2. 探针实时查询结果卡片 */}
        {err && <div className="text-xs text-danger">❌ {err}</div>}

        {result && (
          <div className="rounded-xl border border-white/[0.08] bg-surface-raised/80 p-3 text-xs space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-bold text-ink">
                  {resBaseSym} / {resQuoteSym}
                </span>
                <span className="tag-muted font-mono">
                  {(result.fee / 10000).toFixed(2)}%
                </span>
                <button
                  type="button"
                  onClick={handleFlip}
                  className={`btn-ghost btn-xs ${
                    isResultFlipped
                      ? "border-brand/40 text-brand-light bg-brand/10"
                      : ""
                  }`}
                  title="翻转该交易对的主币/计价币方向（全局生效）"
                >
                  ⇄ 翻转
                </button>
                <button
                  type="button"
                  onClick={() =>
                    doQuery({
                      chainId: Number(chainId || mintChainId),
                      pool: result.pool,
                      staker: stakerAddr,
                    })
                  }
                  disabled={loading}
                  className="btn-ghost btn-xs"
                >
                  {loading ? "刷新中…" : "↻ 刷新探针"}
                </button>
              </div>

              {/* 收藏操作 */}
              {!isAlreadyFav ? (
                <div className="flex items-center gap-1">
                  <input
                    className="input h-6 w-24 px-2 py-0.5 text-[11px]"
                    value={favLabel}
                    onChange={(e) => setFavLabel(e.target.value)}
                    placeholder="备注(可选)"
                  />
                  <button
                    type="button"
                    className="btn-primary btn-xs"
                    onClick={saveFavorite}
                  >
                    ☆ 收藏此池
                  </button>
                </div>
              ) : (
                <span className="text-[11px] text-ok">★ 已收藏</span>
              )}
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1 border-t border-white/[0.06]">
              <div>
                <div className="text-[11px] text-ink-muted">
                  当前池价 (Tick {result.currentTick})
                </div>
                <div className="font-mono text-sm font-semibold text-brand-light">
                  1 {resBaseSym} = {fmtFull(resPriceCurrent)} {resQuoteSym}
                </div>
              </div>
              <div>
                <div className="text-[11px] text-ink-muted">
                  最小区间 [{result.tickLower}, {result.tickUpper}] 全池深度
                </div>
                <div className="font-mono text-ink font-medium">
                  {fmtAmt(resPrimaryAmt)} {resBaseSym}{" "}
                  <span className="text-ink-muted">+</span>{" "}
                  {fmtAmt(resSecondaryAmt)} {resQuoteSym}
                </div>
              </div>
            </div>

            {result.staked && (
              <div className="rounded border border-white/[0.05] bg-surface/60 px-2.5 py-1.5 text-[11px] flex flex-wrap items-center justify-between gap-1">
                <span className="text-ink-soft">
                  🌾 质押池同窗口 ({result.staked.positionCount} 个仓位):
                </span>
                <span className="font-mono text-ink">
                  {fmtAmt(
                    isResultFlipped
                      ? result.staked.amount1
                      : result.staked.amount0
                  )}{" "}
                  {resBaseSym} +{" "}
                  {fmtAmt(
                    isResultFlipped
                      ? result.staked.amount0
                      : result.staked.amount1
                  )}{" "}
                  {resQuoteSym}
                </span>
              </div>
            )}

            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-soft font-mono">
              <span>
                区间价格: {fmtFull(resPriceLow)} ~ {fmtFull(resPriceHigh)}{" "}
                {resQuoteSym}
              </span>
              <span>池 {short(result.pool)}</span>
            </div>

            {/* CEX 对比（如有） */}
            {result.cex &&
              (() => {
                const c = result.cex;
                const diffPct = ((c.absDiff ?? Math.abs(c.diff ?? 0)) * 100).toFixed(2);
                const sign = (c.diff ?? 0) >= 0 ? "+" : "-";
                const cexDisplay =
                  isResultFlipped && c.cexRate > 0 ? 1 / c.cexRate : c.cexRate;
                return (
                  <div
                    className={`rounded-lg border px-2.5 py-1.5 text-[11px] flex flex-wrap items-center justify-between gap-2 ${
                      c.exceedsThreshold
                        ? "border-warn/40 bg-warn/10 text-warn"
                        : "border-ok/30 bg-ok/10 text-ok"
                    }`}
                  >
                    <span>
                      📊 币安参考: 1 {resBaseSym} ={" "}
                      <strong className="font-mono">
                        {fmtFull(cexDisplay)}
                      </strong>{" "}
                      {resQuoteSym}
                    </span>
                    <span className="font-mono font-semibold">
                      偏差 {sign}
                      {diffPct}%{" "}
                      {c.exceedsThreshold ? "⚠️ 超阈值" : "(正常)"}
                    </span>
                  </div>
                );
              })()}
          </div>
        )}
      </div>

      {/* 3. 常驻极速建仓 & 自动质押面板（与上方收藏池无缝联动） */}
      {showMint && mintChainId > 0 && mintPool ? (
        <MintPositionPanel
          chainId={mintChainId}
          pool={mintPool}
          onCreated={() => {
            mutate("/api/positions");
          }}
          onFlipChanged={() => {
            if (mintChainId && mintPool) {
              doQuery({
                chainId: mintChainId,
                pool: mintPool,
                staker: stakerAddr,
              });
            }
          }}
        />
      ) : (
        <div className="card p-3.5 flex items-center justify-between text-xs text-ink-soft">
          <span>点选上方任意收藏池即可展开「极速建仓 & 自动质押」面板</span>
          {favList.length > 0 && (
            <button
              type="button"
              className="btn-primary btn-xs"
              onClick={() => applyFavoriteAndProbe(favList[0])}
            >
              载入默认收藏池
            </button>
          )}
        </div>
      )}
    </div>
  );
}
