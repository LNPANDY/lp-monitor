"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { fetcher, authHeaders, short } from "./util";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";
import { buildSwapCalldata } from "@/lib/wallet/build-swap";
import { buildApproveCalldata, MAX_UINT256 } from "@/lib/wallet/build-mint";

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
  chain: { id: number; name: string; chain_id: number };
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
  cexCompare?: {
    stableSymbol: string;
    otherSymbol: string;
    cexPrice: number;
    executionPriceInStable: number;
    diffPct: number;
    cexSymbolLabel: string;
    displayPrice: number;
  } | null;
}

/**
 * 代币兑换（QuoterV2 报价 + SwapRouter 执行）。
 */
export function SwapQuoteSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: allDexes } = useSWR<DexWithQuoter[]>("/api/dexes", fetcher);
  const { data: allMappings } = useSWR<CexToken[]>("/api/cex-mapping", fetcher);
  const { address, sendTx, switchChain, connect } = useWallet();

  // 可用 DEX：配了 quoter 的（显示 链-DEX）
  const dexOptions = (allDexes ?? []).filter((d) => d.quoter);
  const [dexId, setDexId] = useState<number | "">("");
  const dex = dexOptions.find((d) => d.id === dexId) ?? dexOptions[0] ?? null;

  // 该链的 CEX 代币列表
  const chainTokens = (allMappings ?? []).filter(
    (m) => dex && m.chain_id_ref === dex.chain_id_ref
  );
  const [inSym, setInSym] = useState("");
  const [outSym, setOutSym] = useState("");
  useEffect(() => {
    if (dex && chainTokens.length >= 2 && !inSym && !outSym) {
      setInSym(chainTokens[0].token_symbol);
      setOutSym(chainTokens[1].token_symbol);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex?.id, chainTokens.length]);

  const [amountIn, setAmountIn] = useState("");
  const [amountOut, setAmountOut] = useState("");
  const [editingSide, setEditingSide] = useState<"in" | "out">("in");
  const [slippage, setSlippage] = useState<number>(0.1);
  const [feeOverride, setFeeOverride] = useState<number | undefined>(undefined);
  const [quote, setQuote] = useState<QuoteResult | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [swapping, setSwapping] = useState(false);
  const [err, setErr] = useState("");
  const [txHash, setTxHash] = useState("");
  const [balances, setBalances] = useState<{
    in: string;
    out: string;
    decIn: number;
    decOut: number;
  } | null>(null);

  const tokenInMeta = chainTokens.find((t) => t.token_symbol === inSym);
  const tokenOutMeta = chainTokens.find((t) => t.token_symbol === outSym);

  /** 只查钱包余额（不走报价） */
  const fetchBalances = useCallback(async () => {
    if (!dex || !address || !tokenInMeta || !tokenOutMeta) return;
    try {
      const r = await fetch("/api/token-balances", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: dex.chain_id_ref,
          wallet: address,
          tokens: [tokenInMeta.token_addr, tokenOutMeta.token_addr],
        }),
      });
      const j = await r.json();
      if (!j.ok) return;
      const arr: string[] = j.data.balances;
      const decs: number[] = j.data.decimals ?? [18, 18];
      setBalances({
        in: arr[0] ?? "0",
        out: arr[1] ?? "0",
        decIn: decs[0] ?? 18,
        decOut: decs[1] ?? 18,
      });
    } catch {
      /* ignore */
    }
  }, [dex, address, tokenInMeta, tokenOutMeta]);

  /** 报价：用输入侧的金额 */
  const doQuote = useCallback(
    async (amount: string, dir: "in" | "out") => {
      setErr("");
      if (
        !dex ||
        !tokenInMeta ||
        !tokenOutMeta ||
        !amount ||
        Number(amount) <= 0
      ) {
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
        const qb = (j.data as QuoteResult).balances;
        setBalances(
          qb
            ? {
                in: qb.in,
                out: qb.out,
                decIn: (j.data as QuoteResult).tokenIn.decimals,
                decOut: (j.data as QuoteResult).tokenOut.decimals,
              }
            : null
        );
        autoFillTsRef.current = Date.now();
        if (dir === "in") {
          setAmountOut(trimNum(j.data.amountOutHuman));
        } else {
          setAmountIn(trimNum(j.data.amountInHuman));
        }
      } catch (e: any) {
        setErr(e.message);
        setQuote(null);
      } finally {
        setQuoting(false);
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [dex, tokenInMeta, tokenOutMeta, slippage, feeOverride, address]
  );

  // 防抖自动报价
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFillTsRef = useRef(0);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (Date.now() - autoFillTsRef.current < 1000) return;
      const amount = editingSide === "in" ? amountIn : amountOut;
      if (amount && Number(amount) > 0) doQuote(amount, editingSide);
    }, 600);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amountIn, amountOut, editingSide, inSym, outSym, slippage, feeOverride]);

  const initialLoadedRef = useRef("");
  useEffect(() => {
    if (!dex || !address || !tokenInMeta || !tokenOutMeta || inSym === outSym)
      return;
    const key = `${dex.chain_id_ref}-${inSym}-${outSym}-${address}`;
    if (initialLoadedRef.current === key) return;
    initialLoadedRef.current = key;
    fetchBalances();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dex?.id, inSym, outSym, address]);

  /** 执行兑换（若 ERC20 授权不足会自动发起 approve 再执行 swap） */
  async function executeSwap() {
    let addr = address;
    if (!addr) {
      addr = await connect();
      if (!addr) return;
    }
    if (!quote) {
      setErr("请先输入数量获取报价");
      return;
    }
    if (!quote.router) {
      setErr("该 DEX 未配置 SwapRouter 地址（请在配置页 DEX 设置里填写）");
      return;
    }
    if (!tokenInMeta) return;

    setSwapping(true);
    setErr("");
    setTxHash("");
    try {
      await switchChain(quote.chain.chain_id);

      const routerAddr = quote.router.addr;
      const amountInBig = BigInt(quote.amountIn);

      if (!quote.tokenIn.isNative) {
        let needApprove = true;
        try {
          const ownerPad = addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
          const spenderPad = routerAddr
            .toLowerCase()
            .replace(/^0x/, "")
            .padStart(64, "0");
          const p = (window as any).okxwallet || (window as any).ethereum;
          const raw = p
            ? ((await p.request({
                method: "eth_call",
                params: [
                  {
                    to: quote.tokenIn.addr,
                    data: "0xdd62ed3e" + ownerPad + spenderPad,
                  },
                  "latest",
                ],
              })) as string)
            : "0x0";
          if (raw && raw !== "0x" && BigInt(raw) >= amountInBig) {
            needApprove = false;
          }
        } catch {}

        if (needApprove) {
          const appTx = buildApproveCalldata(
            quote.tokenIn.addr,
            routerAddr,
            MAX_UINT256
          );
          const appHash = await sendTx(appTx);
          await waitForTxReceipt(appHash, 45_000);
        }
      }

      const swap = buildSwapCalldata(
        routerAddr,
        quote.router.kind,
        {
          tokenIn: quote.tokenIn.addr,
          tokenOut: quote.tokenOut.addr,
          fee: quote.fee,
          recipient: addr,
          amountIn: amountInBig,
          amountOutMinimum: BigInt(quote.amountOutMin),
          deadline: 0n,
        },
        quote.tokenIn.isNative
      );
      const h = await sendTx({
        to: swap.to,
        data: swap.data,
        value: swap.value ? BigInt(swap.value) : undefined,
      });
      setTxHash(h);
      fetchBalances();
    } catch (e: any) {
      setErr(`兑换失败：${e?.message ?? e}`);
    } finally {
      setSwapping(false);
    }
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
          <p className="text-xs text-warn">
            暂无可用 DEX（请先在配置页给 DEX 填写 QuoterV2 地址）
          </p>
        ) : (
          <select
            className="input max-w-[240px]"
            value={dex?.id ?? ""}
            onChange={(e) => {
              setDexId(e.target.value ? Number(e.target.value) : "");
              setInSym("");
              setOutSym("");
              setQuote(null);
            }}
          >
            {dexOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {(chains ?? []).find((c: any) => c.id === d.chain_id_ref)
                  ?.name ?? d.chain_id_ref}
                -{d.name}
              </option>
            ))}
          </select>
        )}
      </div>

      {/* 兑换输入区：宽屏四列横排 */}
      {dex && chainTokens.length >= 2 && (
        <div className="mb-3 grid grid-cols-1 items-start gap-2 md:grid-cols-[auto_auto_auto_auto] md:items-start md:gap-x-1.5">
          {/* 输入侧 */}
          <label className="text-xs">
            <div className="mb-1 text-ink-soft">卖出</div>
            <div className="flex items-center gap-1">
              <input
                className="input w-[135px] font-mono"
                value={amountIn}
                onChange={(e) => {
                  setEditingSide("in");
                  setAmountIn(e.target.value);
                }}
                placeholder="0.0"
              />
              <select
                className="input w-[115px]"
                value={inSym}
                onChange={(e) => {
                  setInSym(e.target.value);
                  setQuote(null);
                  setBalances(null);
                }}
              >
                {chainTokens.map((t) => (
                  <option key={t.token_symbol} value={t.token_symbol}>
                    {t.token_symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1 h-[16px] text-[11px] text-ink-soft font-mono">
              {balances &&
                tokenInMeta &&
                (balances.in !== "0"
                  ? `余额：${fmtBalance(balances.in, balances.decIn)}`
                  : "余额：…")}
            </div>
          </label>

          {/* 交换按钮 */}
          <div className="pt-[24px]">
            <button
              className="btn-ghost px-2 py-1.5 text-xs"
              title="交换方向"
              onClick={swapSides}
            >
              ⇄
            </button>
          </div>

          {/* 输出侧 */}
          <label className="text-xs">
            <div className="mb-1 text-ink-soft">得到（自动算）</div>
            <div className="flex items-center gap-1">
              <input
                className="input w-[135px] font-mono"
                value={amountOut}
                onChange={(e) => {
                  setEditingSide("out");
                  setAmountOut(e.target.value);
                }}
                placeholder="0.0"
              />
              <select
                className="input w-[115px]"
                value={outSym}
                onChange={(e) => {
                  setOutSym(e.target.value);
                  setQuote(null);
                  setBalances(null);
                }}
              >
                {chainTokens.map((t) => (
                  <option key={t.token_symbol} value={t.token_symbol}>
                    {t.token_symbol}
                  </option>
                ))}
              </select>
            </div>
            <div className="mt-1 h-[16px] text-[11px] text-ink-soft font-mono">
              {balances &&
                tokenOutMeta &&
                (balances.out !== "0"
                  ? `余额：${fmtBalance(balances.out, balances.decOut)}`
                  : "余额：…")}
            </div>
          </label>

          {/* 滑点 + 兑换按钮 */}
          <div className="flex items-end gap-2 md:pl-2">
            <label className="text-xs">
              <div className="mb-1 text-ink-soft">滑点</div>
              <select
                className="input w-[92px]"
                value={slippage}
                onChange={(e) => setSlippage(Number(e.target.value))}
              >
                <option value={0.1}>0.1%</option>
                <option value={0.5}>0.5%</option>
                <option value={1}>1%</option>
                <option value={3}>3%</option>
              </select>
            </label>
            <button
              className="btn-primary h-[32px] px-5"
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
              className={`rounded-lg px-2 py-0.5 text-xs transition ${
                f.fee === quote.fee
                  ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/50"
                  : "border border-white/15 bg-white/[0.05] text-ink-soft hover:bg-white/[0.1] hover:text-white"
              }`}
              onClick={() => setFeeOverride(f.fee)}
            >
              {f.fee / 10000}%（流动性 {abbrev(f.liquidity)}）
            </button>
          ))}
        </div>
      )}

      {quoting && (
        <p className="text-sm text-ink-soft">
          报价中…（自动找池子 + Quoter 调用）
        </p>
      )}
      {err && <p className="text-sm text-warn">{err}</p>}
      {txHash && (
        <p className="text-sm text-ok">
          ✅ 兑换交易已提交：<span className="font-mono">{short(txHash)}</span>
        </p>
      )}

      {/* 报价结果 */}
      {quote && !quoting && (
        <div className="panel-inset p-3.5 text-sm">
          <div className="flex items-center justify-between py-1">
            <span className="text-ink-soft">预计获得</span>
            <span className="font-semibold font-mono text-ink">
              {quote.amountOutHuman} {quote.tokenOut.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.08] py-1">
            <span className="text-ink-soft">
              滑点 {quote.slippagePct}% 后最少
            </span>
            <span className="font-mono text-ink">
              {quote.amountOutMinHuman} {quote.tokenOut.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.08] py-1">
            <span className="text-ink-soft">成交价</span>
            {quote.cexCompare ? (
              <span className="font-mono text-ink">
                1 {quote.cexCompare.otherSymbol} ≈{" "}
                {fmtNum(quote.cexCompare.displayPrice)}{" "}
                {quote.cexCompare.stableSymbol}
              </span>
            ) : (
              <span className="font-mono text-ink">
                1 {quote.tokenIn.symbol} ≈ {fmtNum(quote.executionPrice ?? 0)}{" "}
                {quote.tokenOut.symbol}
              </span>
            )}
          </div>
          {quote.priceImpactPct !== null &&
            quote.priceImpactPct !== undefined && (
              <div className="flex items-center justify-between border-t border-white/[0.08] py-1">
                <span className="text-ink-soft">价格影响</span>
                <span
                  className={
                    quote.priceImpactPct > 3
                      ? "text-warn font-semibold font-mono"
                      : "font-mono text-ink"
                  }
                >
                  {quote.priceImpactPct.toFixed(2)}%
                  {quote.priceImpactPct > 3 && "（过高）"}
                </span>
              </div>
            )}
          {quote.cexCompare && (
            <div className="flex items-center justify-between border-t border-white/[0.08] py-1">
              <span
                className="text-ink-soft"
                title="稳定币走 CEX 报价口径对比：DEX 成交价 vs CEX 价"
              >
                CEX 对比（{quote.cexCompare.otherSymbol}→
                {quote.cexCompare.stableSymbol}）
              </span>
              <span
                className={
                  Math.abs(quote.cexCompare.diffPct) > 1
                    ? "text-warn font-semibold font-mono"
                    : "font-mono text-ink"
                }
              >
                CEX {quote.cexCompare.cexPrice.toPrecision(6)} · DEX{" "}
                {quote.cexCompare.executionPriceInStable.toPrecision(6)}{" "}
                <span
                  className={
                    quote.cexCompare.diffPct >= 0 ? "text-ok" : "text-warn"
                  }
                >
                  {quote.cexCompare.diffPct >= 0 ? "+" : ""}
                  {quote.cexCompare.diffPct.toFixed(2)}%
                </span>
              </span>
            </div>
          )}
          <div className="flex items-center justify-between border-t border-white/[0.08] py-1">
            <span className="text-ink-soft">池子</span>
            <span className="font-mono text-xs text-ink">
              {short(quote.pool)} · fee {quote.fee / 10000}% · {quote.dexName}
              {quote.tokenIn.isNative &&
                ` · ${quote.tokenIn.symbol}(native→wrapped)`}
            </span>
          </div>
          {!quote.router && (
            <p className="mt-1 text-xs text-warn">
              ⚠️ 该 DEX 未配置 SwapRouter 地址，只能报价不能执行兑换
            </p>
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
    const units: [number, string][] = [
      [18, "P"],
      [15, "P"],
      [12, "T"],
      [9, "B"],
      [6, "M"],
      [3, "K"],
    ];
    for (const [exp, suffix] of units) {
      if (s.length > exp) {
        const intPart = s.slice(0, s.length - exp);
        const frac = s.slice(s.length - exp, s.length - exp + 1).replace(/0+$/, "");
        return `${intPart}${frac ? "." + frac : ""}${suffix}`;
      }
    }
    return s;
  } catch {
    return v;
  }
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  if (n >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 6 });
  const s = n.toFixed(18).replace(/0+$/, "").replace(/\.$/, "");
  return s;
}

function fmtBalance(raw: string, decimals?: number): string {
  try {
    const n = BigInt(raw);
    const d = BigInt(decimals ?? 18);
    const base = 10n ** d;
    const intPart = n / base;
    const frac = (n % base)
      .toString()
      .padStart(Number(d), "0")
      .slice(0, 6)
      .replace(/0+$/, "");
    return frac ? `${intPart}.${frac}` : `${intPart}`;
  } catch {
    return "0";
  }
}
