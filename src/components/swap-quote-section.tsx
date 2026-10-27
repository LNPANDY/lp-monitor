"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { fetcher, authHeaders, short } from "./util";
import { useWallet } from "@/lib/wallet/use-wallet";
import { buildSwapCalldata } from "@/lib/wallet/build-swap";

interface CexToken {
  token_symbol: string;
  token_addr: string; // '__native__' 表示原生币
  chain_id_ref: number;
}

interface DexWithQuoter {
  id: number;
  name: string;
  chain_id_ref: number;
  chain_name: string;
  quoter: string;
  router02: string;
  swaprouter: string;
}

interface QuoteResult {
  chain: { id: number; name: string };
  dexName: string;
  pool: string;
  fee: number;
  availableFees: { fee: number; liquidity: string }[];
  tokenIn: { addr: string; symbol: string; decimals: number; isNative: boolean };
  tokenOut: { addr: string; symbol: string; decimals: number; isNative: boolean };
  amountIn: string;
  amountInHuman: string;
  amountOut: string;
  amountOutHuman: string;
  amountOutMin: string;
  amountOutMinHuman: string;
  slippagePct: number;
  priceImpactPct: number | null;
  gasEstimate: string;
  router: { addr: string; kind: "router02" | "swaprouter" } | null;
  balances?: { in: string; out: string } | null;
  executionPrice?: number;
}

/**
 * 代币兑换（QuoterV2 报价 + SwapRouter 执行）。
 *
 * - DEX 自动读取已配置 quoter 的 v3 DEX（显示为 链-DEX 名）
 * - token 下拉读取 CEX 报价匹配的代币（含 __native__ 原生币）
 * - 任一侧输入数量 → 防抖自动算另一侧（正向 exact-in 报价，反向用成交价反算）
 * - 「兑换」按钮 = 调钱包执行 swap（exactInputSingle，带滑点保护）
 */
export function SwapQuoteSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: allDexes } = useSWR<DexWithQuoter[]>("/api/dexes", fetcher);
  const { data: allMappings } = useSWR<CexToken[]>("/api/cex-mapping", fetcher);
  const { address, sendTx, switchChain, connect } = useWallet();

  // 可用 DEX：配了 quoter 的（显示 链-DEX）
  const dexOptions = (allDexes ?? []).filter((d) => d.quoter);
  const [dexId, setDexId] = useState<number | "">("");
  // 选中的 DEX 对象
  const dex = dexOptions.find((d) => d.id === dexId) ?? dexOptions[0] ?? null;

  // 该链的 CEX 代币列表
  const chainTokens = (allMappings ?? []).filter((m) => dex && m.chain_id_ref === dex.chain_id_ref);
  const [inSym, setInSym] = useState("");
  const [outSym, setOutSym] = useState("");
  // 初始化：进 DEX 后默认选第 1、2 个代币
  useEffect(() => {
    if (dex && chainTokens.length >= 2 && !inSym && !outSym) {
      setInSym(chainTokens[0].token_symbol);
      setOutSym(chainTokens[1].token_symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex?.id]);

  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  // 哪一侧是用户输入的（另一侧自动算）
  const [editingSide, setEditingSide] = useState<"in" | "out">("in");
  const [slippage, setSlippage] = useState<number>(0.1);
  const [feeOverride, setFeeOverride] = useState<number | undefined>(undefined);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");
  // 两个 token 的钱包余额（报价返回）
  const [balances, setBalances] = useState<{ in: string; out: string } | null>(null);

  const tokenInMeta = chainTokens.find((t) => t.token_symbol === inSym);
  const tokenOutMeta = chainTokens.find((t) => t.token_symbol === outSym);

  /** 报价：用输入侧的金额 */
  const doQuote = useCallback(async (amount: string, dir: "in" | "out") => {
    setErr("");
    if (!dex || !tokenInMeta || !tokenOutMeta || !amount || Number(amount) <= 0) {
      setQuote(null);
      return;
    }
    setQuoting(true);
    try {
      const body: any = {
        chain_id: dex.chain_id_ref,
        token_in_addr: tokenInMeta.token_addr,
        token_out_addr: tokenOutMeta.token_addr,
        slippage_pct: slippage,
        ...(feeOverride ? { fee: feeOverride } : {}),
        ...(address ? { wallet: address } : {}),
      };
      if (dir === "in") {
        body.amount_in = amount;
      } else {
        // 反向输入：直接把目标输出数量传给后端迭代反算（精确，无近似）
        body.target_out = amount;
      }
      const r = await fetch("/api/swap-quote", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setQuote(j.data);
      setBalances((j.data as QuoteResult).balances ?? null);
      // 把另一侧的数量填回输入框（用户没在编辑那侧时）
      if (dir === "in") {
        setAmountOut(trimNum(j.data.amountOutHuman));
      } else {
        setAmountIn(trimNum(j.data.amountInHuman));
      }
    } catch (e: any) {
      setErr(e.message);
      setQuote(null);
    } finally { setQuoting(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex, tokenInMeta, tokenOutMeta, slippage, feeOverride]);

  // 防抖自动报价
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      const amount = editingSide === "in" ? amountIn : amountOut;
      if (amount && Number(amount) > 0) doQuote(amount, editingSide);
    }, 700);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, amountOut, editingSide, inSym, outSym, slippage, feeOverride]);

  // 选完 token 对后立即加载（用最小金额 1 触发一次报价，拿到余额 + 池子信息）
  const initialLoadedRef = useRef("");
  useEffect(() => {
    if (!dex || !tokenInMeta || !tokenOutMeta || inSym === outSym) return;
    const key = `${dex.id}-${inSym}-${outSym}`;
    if (initialLoadedRef.current === key) return;
    initialLoadedRef.current = key;
    doQuote("1", "in");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex?.id, inSym, outSym]);

  /** 执行兑换 */
  async function executeSwap() {
    if (!address) { await connect(); return; }
    if (!quote) { setErr("请先输入数量获取报价"); return; }
    if (!quote.router) { setErr("该 DEX 未配置 SwapRouter 地址（请在配置页 DEX 设置里填写）"); return; }
    if (!tokenInMeta) return;

    // 授权检查提示（不做静默 approve，用户自行确认额度）
    setSwapping(true); setErr(""); setTxHash("");
    try {
      await switchChain(quote.chain.id);
      // 输出是 wrapped native（isNative 且地址非原生——报价时已映射为 wrapped）时自动 unwrap
      // 判定：tokenOut 的 symbol 与链原生 symbol 前缀匹配（W0G/0G、WETH/ETH）
      const outIsWrappedNative = quote.tokenOut.symbol.toUpperCase().startsWith("W") &&
        quote.tokenOut.symbol.length > 1;
      const swap = buildSwapCalldata(
        quote.router.addr,
        quote.router.kind,
        {
          tokenIn: quote.tokenIn.addr,
          tokenOut: quote.tokenOut.addr,
          fee: quote.fee,
          recipient: address,
          amountIn: BigInt(quote.amountIn),
          amountOutMinimum: BigInt(quote.amountOutMin),
          deadline: 0n, // buildSwapCalldata 内部默认 +20 分钟
        },
        quote.tokenIn.isNative,
        outIsWrappedNative
      );
      const h = await sendTx({ to: swap.to, data: swap.data, value: swap.value ? BigInt(swap.value) : undefined });
      setTxHash(h);
    } catch (e: any) {
      setErr(`兑换失败：${e?.message ?? e}`);
    } finally { setSwapping(false); }
  }

  /** 交换两侧 */
  function swapSides() {
    setInSym(outSym);
    setOutSym(inSym);
    setAmountIn(amountOut);
    setAmountOut(amountIn);
    setEditingSide(editingSide === "in" ? "out" : "in");
    setQuote(null);
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">💱 代币兑换</h2>
      <p className="mb-3 text-xs text-ink-soft">
        QuoterV2 精确报价 + SwapRouter 链上执行。需在配置页给 DEX 填写 QuoterV2 和 SwapRouter 地址。
      </p>

      {/* DEX 选择 */}
      <div className="mb-3">
        <span className="label">DEX</span>
        {dexOptions.length === 0 ? (
          <p className="text-xs text-warn">暂无可用 DEX（请先在配置页给 DEX 填写 QuoterV2 地址）</p>
        ) : (
          <select
            className="input max-w-[240px]"
            value={dex?.id ?? ""}
            onChange={(e) => { setDexId(e.target.value ? Number(e.target.value) : ""); setInSym(""); setOutSym(""); setQuote(null); }}
          >
            {dexOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {(chains ?? []).find((c: any) => c.id === d.chain_id_ref)?.name ?? d.chain_id_ref}-{d.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 兑换输入区：三列 grid，中列交换按钮对齐输入行，右列滑点+兑换对齐 */}
      {dex && chainTokens.length >= 2 && (
        <div className="mb-3 grid grid-cols-[auto_auto_auto_1fr] items-start gap-2">
          {/* 输入侧（含余额，固定宽度防跳动） */}
          <label className="text-xs">
            <div className="mb-1 text-ink-soft">卖出</div>
            <div className="flex items-center gap-1">
              <input
                className="input w-[130px]"
                value={amountIn}
                onChange={(e) => { setEditingSide("in"); setAmountIn(e.target.value); }}
                placeholder="0.0"
              />
              <select className="input w-[110px]" value={inSym} onChange={(e) => { setInSym(e.target.value); setQuote(null); setBalances(null); }}>
                {chainTokens.map((t) => <option key={t.token_symbol} value={t.token_symbol}>{t.token_symbol}</option>)}
              </select>
            </div>
            <div className="mt-0.5 h-[16px] text-[11px] text-ink-soft">
              {balances && tokenInMeta && `余额：${fmtBalance(balances.in, quote?.tokenIn?.decimals ?? 18)}`}
            </div>
          </label>

          {/* 交换按钮：与输入行垂直居中（label 标题 20px + 输入框 38px 的一半） */}
          <div className="pt-[26px]">
            <button
              className="rounded border border-slate-300 bg-white px-2 py-1.5 text-xs hover:bg-slate-100"
              title="交换方向"
              onClick={swapSides}
            >⇄</button>
          </div>

          {/* 输出侧 */}
          <label className="text-xs">
            <div className="mb-1 text-ink-soft">得到（自动算）</div>
            <div className="flex items-center gap-1">
              <input
                className="input w-[130px]"
                value={amountOut}
                onChange={(e) => { setEditingSide("out"); setAmountOut(e.target.value); }}
                placeholder="0.0"
              />
              <select className="input w-[110px]" value={outSym} onChange={(e) => { setOutSym(e.target.value); setQuote(null); setBalances(null); }}>
                {chainTokens.map((t) => <option key={t.token_symbol} value={t.token_symbol}>{t.token_symbol}</option>)}
              </select>
            </div>
            <div className="mt-0.5 h-[16px] text-[11px] text-ink-soft">
              {balances && tokenOutMeta && `余额：${fmtBalance(balances.out, quote?.tokenOut?.decimals ?? 18)}`}
            </div>
          </label>

          {/* 滑点 + 兑换按钮 */}
          <div className="flex items-end justify-end gap-2">
            <label className="text-xs">
              <div className="mb-1 text-ink-soft">滑点</div>
              <select className="input w-[92px]" value={slippage} onChange={(e) => setSlippage(Number(e.target.value))}>
                <option value={0.1}>0.1%</option>
                <option value={0.5}>0.5%</option>
                <option value={1}>1%</option>
                <option value={3}>3%</option>
              </select>
            </label>
            <button
              className="btn-primary h-[38px] px-5"
              disabled={swapping || quoting || !quote}
              onClick={executeSwap}
            >
              {swapping ? "执行中…" : quoting ? "报价中…" : "兑换"}
            </button>
          </div>
        </div>
      )}

      {/* fee 档位切换 */}
      {quote && quote.availableFees.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-ink-soft">费率档：</span>
          {quote.availableFees.map((f) => (
            <button
              key={f.fee}
              className={`rounded px-1.5 py-0.5 ${f.fee === quote.fee ? "bg-ink text-white" : "border border-slate-300 bg-white hover:bg-slate-100"}`}
              onClick={() => { setFeeOverride(f.fee); }}
            >
              {f.fee / 10000}%（流动性 {abbrev(f.liquidity)}）
            </button>
          ))}
        </div>
      )}

      {quoting && <p className="text-sm text-ink-soft">报价中…（自动找池子 + Quoter 调用）</p>}
      {err && <p className="text-sm text-warn">{err}</p>}
      {txHash && (
        <p className="text-sm text-emerald-700">
          ✅ 兑换交易已提交：<span className="font-mono">{short(txHash)}</span>
        </p>
      )}

      {/* 报价结果 */}
      {quote && !quoting && (
        <div className="rounded border border-slate-200 bg-slate-50 p-3 text-sm">
          <div className="flex items-center justify-between py-1">
            <span className="text-ink-soft">预计获得</span>
            <span className="font-semibold">{quote.amountOutHuman} {quote.tokenOut.symbol}</span>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 py-1">
            <span className="text-ink-soft">滑点 {quote.slippagePct}% 后最少</span>
            <span>{quote.amountOutMinHuman} {quote.tokenOut.symbol}</span>
          </div>
          <div className="flex items-center justify-between border-t border-slate-200 py-1">
            <span className="text-ink-soft">成交价</span>
            <span>1 {quote.tokenIn.symbol} ≈ {fmtNum(quote.executionPrice ?? 0)} {quote.tokenOut.symbol}</span>
          </div>
          {quote.priceImpactPct !== null && quote.priceImpactPct !== undefined && (
            <div className="flex items-center justify-between border-t border-slate-200 py-1">
              <span className="text-ink-soft">价格影响</span>
              <span className={quote.priceImpactPct > 3 ? "text-warn font-semibold" : ""}>
                {quote.priceImpactPct.toFixed(2)}%{quote.priceImpactPct > 3 && "（过高）"}
              </span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-slate-200 py-1">
            <span className="text-ink-soft">池子</span>
            <span className="font-mono text-xs">
              {short(quote.pool)} · fee {quote.fee / 10000}% · {quote.dexName}
              {quote.tokenIn.isNative && ` · ${quote.tokenIn.symbol}(native→wrapped)`}
            </span>
          </div>
          {!quote.router && (
            <p className="mt-1 text-xs text-warn">⚠️ 该 DEX 未配置 SwapRouter 地址，只能报价不能执行兑换</p>
          )}
        </div>
      )}
    </section>
  );
}

function trimNum(s: string): string {
  if (s.includes(".")) return s.replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function abbrev(v?: string): string {
  if (!v) return "0";
  try {
    const n = BigInt(v);
    if (n === 0n) return "0";
    const s = n.toString();
    const units: [number, string][] = [[18, "P"], [15, "P"], [12, "T"], [9, "B"], [6, "M"], [3, "K"]];
    for (const [exp, suffix] of units) {
      if (s.length > exp) {
        const intPart = s.slice(0, s.length - exp);
        const frac = s.slice(s.length - exp, s.length - exp + 1).replace(/0+$/, "");
        return `${intPart}${frac ? "." + frac : ""}${suffix}`;
      }
    }
    return s;
  } catch { return v; }
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  // 极小值：展开小数（最多 12 位有效），避免 1.13e-11 这类显示
  const s = n.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

/** raw 余额 → 可读（截断到 6 位有效小数） */
function fmtBalance(raw: string, decimals?: number): string {
  try {
    const n = BigInt(raw);
    const d = BigInt(decimals ?? 18);
    const base = 10n ** d;
    const intPart = n / base;
    const frac = (n % base).toString().padStart(Number(d), "0").slice(0, 6).replace(/0+$/, "");
    return frac ? `${intPart}.${frac}` : `${intPart}`;
  } catch { return "0"; }
}
