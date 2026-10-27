"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { fetcher, authHeaders } from "./util";

/** QuoterV2 兑换报价（单池单跳），防抖自动报价，支持滑点 */
export function SwapQuoteSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const [pool, setPool] = useState("");
  const [quote, setQuote] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [side, setSide] = useState<"exact_in_token0" | "exact_in_token1">("exact_in_token0");
  const [amount, setAmount] = useState("");
  const [slippage, setSlippage] = useState<number>(0.5);

  /** 报价（防抖 600ms） */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const doQuote = useCallback(async (a: string, s: string, sl: number) => {
    setErr(""); setQuote(null);
    if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(pool.trim()) || !a || Number(a) <= 0) return;
    setLoading(true);
    try {
      const r = await fetch("/api/swap-quote", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ chain_id: chainId, pool: pool.trim(), amount_in: a, side: s, slippage_pct: sl }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setQuote(j.data);
    } catch (e: any) {
      setErr(e.message);
    } finally { setLoading(false); }
  }, [chainId, pool]);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => doQuote(amount, side, slippage), 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side, slippage]);

  const inSym = quote?.tokenIn?.symbol ?? (side === "exact_in_token0" ? "token0" : "token1");
  const outSym = quote?.tokenOut?.symbol ?? (side === "exact_in_token0" ? "token1" : "token0");

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">💱 代币兑换报价</h2>
      <p className="mb-3 text-xs text-ink-soft">QuoterV2 精确报价（单池）。仅报价，实际兑换请到 DEX 网站。</p>

      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">链</div>
          <select className="input" value={chainId || ""} onChange={(e) => { setChainId(e.target.value ? Number(e.target.value) : ""); setQuote(null); }}>
            <option value="">选择链</option>
            {(chains ?? []).filter((c: any) => c.enabled).map((c: any) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </label>
        <label className="text-xs flex-1 min-w-[280px]">
          <div className="mb-1 text-ink-soft">池子地址</div>
          <input className="input" value={pool} onChange={(e) => { setPool(e.target.value); setQuote(null); }} placeholder="0x… 池子地址" />
        </label>
      </div>

      {/* 方向与金额 */}
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">方向</div>
          <div className="flex items-center gap-1">
            <button
              className={`rounded px-2 py-1.5 text-xs ${side === "exact_in_token0" ? "bg-ink text-white" : "border border-slate-300 bg-white"}`}
              onClick={() => setSide("exact_in_token0")}
            >{quote ? quote.tokenIn.symbol : "token0"} → {quote ? quote.tokenOut.symbol : "token1"}</button>
            <button
              className="rounded border border-slate-300 bg-white px-1.5 py-1.5 text-xs"
              title="交换方向"
              onClick={() => setSide(side === "exact_in_token0" ? "exact_in_token1" : "exact_in_token0")}
            >⇄</button>
          </div>
        </label>
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">数量</div>
          <input className="input max-w-[160px]" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="输入数量" />
        </label>
        <label className="text-xs">
          <div className="mb-1 text-ink-soft">滑点</div>
          <select className="input max-w-[92px]" value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
            <option value={0.1}>0.1%</option>
            <option value={0.5}>0.5%</option>
            <option value={1}>1%</option>
            <option value={3}>3%</option>
          </select>
        </label>
      </div>

      {loading && <p className="text-sm text-ink-soft">报价中…</p>}
      {err && <p className="text-sm text-warn">{err}</p>}

      {quote && !loading && (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between py-1">
            <span className="text-ink-soft">预计获得</span>
            <span className="font-semibold">{quote.amountOutHuman} {outSym}</span>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 py-1">
            <span className="text-ink-soft">滑点 {quote.slippagePct}% 后最少</span>
            <span>{quote.amountOutMinHuman} {outSym}</span>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 py-1">
            <span className="text-ink-soft">成交价</span>
            <span>1 {inSym} ≈ {fmtNum(quote.executionPrice)} {outSym}</span>
          </div>
          {quote.priceImpactPct !== null && quote.priceImpactPct !== undefined && (
            <div className="flex items-center justify-between border-t border-slate-200 py-1">
              <span className="text-ink-soft">价格影响</span>
              <span className={quote.priceImpactPct > 3 ? "text-warn font-semibold" : ""}>
                {quote.priceImpactPct.toFixed(2)}%
                {quote.priceImpactPct > 3 && "（过高，建议减少数量）"}
              </span>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  return n.toPrecision(6).replace(/0+$/, "").replace(/\.$/, "");
}
