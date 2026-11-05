"use client";
import { useState, useEffect } from "react";
import useSWR from "swr";
import { fetcher, authHeaders, short, fmtFull } from "./util";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";
import { buildSwapCalldata } from "@/lib/wallet/build-swap";
import { buildApproveCalldata, MAX_UINT256 } from "@/lib/wallet/build-mint";
import { getInjectedProvider } from "@/lib/wallet/provider";
import { toast } from "./toast";

interface CexMappingRow {
  id: number;
  chain_id_ref: number;
  chain_name: string;
  token_addr: string;
  token_symbol: string;
  cex_symbol: string;
  enabled: number;
}

interface QuoteData {
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
  executionPrice: number;
  router: { addr: string; kind: "router02" | "swaprouter" } | null;
  balances: { in: string; out: string } | null;
  cexCompare: {
    stableSymbol: string;
    otherSymbol: string;
    cexPrice: number;
    executionPriceInStable: number;
    diffPct: number;
    cexSymbolLabel: string;
    displayPrice: number;
  } | null;
}

export function SwapQuoteSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: mappings } = useSWR<CexMappingRow[]>("/api/cex-mapping", fetcher);
  const wallet = useWallet();

  const [chainId, setChainId] = useState<number | "">("");
  const [tokenIn, setTokenIn] = useState("");
  const [tokenOut, setTokenOut] = useState("");
  const [amountIn, setAmountIn] = useState("1");
  const [targetOut, setTargetOut] = useState("");
  const [inputMode, setInputMode] = useState<"in" | "out">("in");
  const [slippagePct, setSlippagePct] = useState("0.5");
  const [feeOverride, setFeeOverride] = useState<number | null>(null);

  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [quote, setQuote] = useState<QuoteData | null>(null);

  const [swapping, setSwapping] = useState(false);
  const [swapStep, setSwapStep] = useState("");
  const [txHash, setTxHash] = useState("");

  const enabledChains = (chains ?? []).filter((c) => c.enabled);

  // 默认选中第一个有代币映射的链
  useEffect(() => {
    if (!chainId && enabledChains.length > 0 && mappings) {
      const chainWithTokens = enabledChains.find((c) =>
        mappings.some((m) => m.enabled && m.chain_id_ref === c.id)
      );
      setChainId((chainWithTokens ?? enabledChains[0]).id);
    }
  }, [chainId, enabledChains, mappings]);

  const chainTokens = (mappings ?? []).filter(
    (m) => m.enabled && (!chainId || m.chain_id_ref === Number(chainId))
  );

  // 当链变化且尚未选币时，默认填入前两个常用币
  useEffect(() => {
    if (chainTokens.length >= 2 && !tokenIn && !tokenOut) {
      setTokenIn(chainTokens[0].token_addr);
      setTokenOut(chainTokens[1].token_addr);
    }
  }, [chainTokens, tokenIn, tokenOut]);

  function flipDirection() {
    const prevIn = tokenIn;
    const prevOut = tokenOut;
    setTokenIn(prevOut);
    setTokenOut(prevIn);
    setFeeOverride(null);
    setQuote(null);
    setErr("");
    setTxHash("");
  }

  async function doQuote(opts?: {
    overrideFee?: number | null;
    overrideAmountIn?: string;
  }) {
    if (!chainId || !tokenIn || !tokenOut) {
      toast.warn("请选择链以及卖出和买入代币");
      return;
    }
    const useAmtIn = opts?.overrideAmountIn ?? amountIn;
    if (inputMode === "in" && !useAmtIn) return;
    if (inputMode === "out" && !targetOut) return;

    setLoading(true);
    setErr("");
    setTxHash("");
    try {
      const useFee =
        opts && "overrideFee" in opts ? opts.overrideFee : feeOverride;
      const body: Record<string, any> = {
        chain_id: Number(chainId),
        token_in_addr: tokenIn,
        token_out_addr: tokenOut,
        slippage_pct: Number(slippagePct) || 0.5,
      };
      if (inputMode === "out") {
        body.target_out = targetOut;
      } else {
        body.amount_in = useAmtIn;
      }
      if (useFee) body.fee = useFee;
      if (wallet.address) body.wallet = wallet.address;

      const r = await fetch("/api/swap-quote", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "报价失败");
      setQuote(j.data);
      if (inputMode === "out" && j.data?.amountInHuman) {
        setAmountIn(j.data.amountInHuman);
      }
    } catch (e: any) {
      setErr(e.message);
      setQuote(null);
    } finally {
      setLoading(false);
    }
  }

  async function executeSwap() {
    if (!quote || !quote.router) return;
    setSwapping(true);
    setErr("");
    setTxHash("");
    try {
      let addr = wallet.address;
      if (!addr) {
        setSwapStep("连接钱包…");
        addr = await wallet.connect();
        if (!addr) throw new Error("未连接钱包");
      }

      const chainRow = enabledChains.find((c) => c.id === quote.chain.id);
      if (wallet.chainId !== quote.chain.chain_id) {
        setSwapStep(`切换到 ${quote.chain.name}…`);
        await wallet.switchChain(quote.chain.chain_id, {
          chainName: quote.chain.name,
          nativeCurrency: {
            name: chainRow?.symbol || "ETH",
            symbol: chainRow?.symbol || "ETH",
            decimals: 18,
          },
          rpcUrls: chainRow?.rpc_urls ?? [],
          blockExplorerUrls: chainRow?.explorer_url
            ? [chainRow.explorer_url]
            : undefined,
        });
      }

      const routerAddr = quote.router.addr;
      const amountInBig = BigInt(quote.amountIn);
      const amountOutMinBig = BigInt(quote.amountOutMin);

      // 非原生币时检查 allowance，不足则先 approve 并使用 350ms 极速回执轮询
      if (!quote.tokenIn.isNative) {
        setSwapStep(`检查 ${quote.tokenIn.symbol} 授权…`);
        const p = getInjectedProvider();
        let needApprove = true;
        if (p) {
          try {
            const ownerPad = addr
              .toLowerCase()
              .replace(/^0x/, "")
              .padStart(64, "0");
            const spenderPad = routerAddr
              .toLowerCase()
              .replace(/^0x/, "")
              .padStart(64, "0");
            const raw = (await p.request({
              method: "eth_call",
              params: [
                {
                  to: quote.tokenIn.addr,
                  data: "0xdd62ed3e" + ownerPad + spenderPad,
                },
                "latest",
              ],
            })) as string;
            if (raw && raw !== "0x" && BigInt(raw) >= amountInBig) {
              needApprove = false;
            }
          } catch {}
        }

        if (needApprove) {
          setSwapStep(`1/2 · 授权 ${quote.tokenIn.symbol}…`);
          const appTx = buildApproveCalldata(
            quote.tokenIn.addr,
            routerAddr,
            MAX_UINT256
          );
          const appHash = await wallet.sendTx({ ...appTx, gas: 80000n });
          setSwapStep(`等待 ${quote.tokenIn.symbol} 授权确认…`);
          await waitForTxReceipt(appHash, 45_000);
        }
      }

      setSwapStep("2/2 · 发送兑换交易…");
      const deadline = BigInt(Math.floor(Date.now() / 1000) + 1200);
      const swapTx = buildSwapCalldata(
        routerAddr,
        quote.router.kind,
        {
          tokenIn: quote.tokenIn.addr,
          tokenOut: quote.tokenOut.addr,
          fee: quote.fee,
          recipient: addr,
          amountIn: amountInBig,
          amountOutMinimum: amountOutMinBig,
          deadline,
        },
        quote.tokenIn.isNative
      );
      const h = await wallet.sendTx({
        to: swapTx.to,
        data: swapTx.data,
        value: swapTx.value ? BigInt(swapTx.value) : undefined,
        gas: 320000n,
      });
      setTxHash(h);
      setSwapStep("等待兑换上链确认…");
      await waitForTxReceipt(h, 45_000);
      setSwapStep("");
      toast.success(
        `兑换成功！${quote.amountInHuman} ${quote.tokenIn.symbol} → ${quote.amountOutHuman} ${quote.tokenOut.symbol}`
      );
      doQuote();
    } catch (e: any) {
      setErr(e?.message || String(e));
      toast.error(e?.message || "兑换中断");
      setSwapStep("");
    } finally {
      setSwapping(false);
    }
  }

  function fmtBal(rawStr: string, decimals: number): number {
    const n = Number(rawStr) / Math.pow(10, decimals);
    return Number.isFinite(n) ? n : 0;
  }

  const inBalanceNum =
    quote?.balances && quote.tokenIn
      ? fmtBal(quote.balances.in, quote.tokenIn.decimals)
      : null;
  const outBalanceNum =
    quote?.balances && quote.tokenOut
      ? fmtBal(quote.balances.out, quote.tokenOut.decimals)
      : null;

  return (
    <div className="card p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-2.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-ink">
            💱 极速询价 & 代币兑换
          </span>
          <span className="text-[11px] text-ink-muted">
            自动优选最大深度池并对比币安汇率
          </span>
        </div>
      </div>

      {/* 链 + 卖出币 + 互换 + 买入币 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 items-end">
        <div className="sm:col-span-3">
          <span className="label">链</span>
          <select
            className="input"
            value={chainId}
            onChange={(e) => {
              setChainId(e.target.value ? Number(e.target.value) : "");
              setTokenIn("");
              setTokenOut("");
              setQuote(null);
            }}
          >
            <option value="">选择链</option>
            {enabledChains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-4">
          <span className="label">卖出 (Token In)</span>
          <select
            className="input font-medium"
            value={tokenIn}
            onChange={(e) => {
              setTokenIn(e.target.value);
              setFeeOverride(null);
              setQuote(null);
            }}
          >
            <option value="">选择代币</option>
            {chainTokens.map((m) => (
              <option key={m.id} value={m.token_addr}>
                {m.token_symbol || short(m.token_addr)}
                {m.token_addr === "__native__" ? " (原生)" : ""}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-1 flex justify-center">
          <button
            type="button"
            className="btn-ghost px-2 py-1.5 text-xs"
            onClick={flipDirection}
            title="互换卖出与买入币种"
          >
            ⇄
          </button>
        </div>

        <div className="sm:col-span-4">
          <span className="label">买入 (Token Out)</span>
          <select
            className="input font-medium"
            value={tokenOut}
            onChange={(e) => {
              setTokenOut(e.target.value);
              setFeeOverride(null);
              setQuote(null);
            }}
          >
            <option value="">选择代币</option>
            {chainTokens.map((m) => (
              <option key={m.id} value={m.token_addr}>
                {m.token_symbol || short(m.token_addr)}
                {m.token_addr === "__native__" ? " (原生)" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* 正向卖出数量 / 反向目标买入数量 + 滑点 + 询价按钮 */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-12 items-end">
        <div className="sm:col-span-5">
          <span className="label flex items-center justify-between">
            <span>
              卖出数量{" "}
              {inputMode === "out" && (
                <span className="text-brand-light">(反算)</span>
              )}
            </span>
            {inBalanceNum !== null && (
              <span className="font-mono text-[10px] text-ink-soft">
                余额: {inBalanceNum.toFixed(4)}
              </span>
            )}
          </span>
          <input
            className={`input font-mono ${
              inputMode === "in" ? "border-brand/50" : "opacity-80"
            }`}
            value={amountIn}
            onFocus={() => setInputMode("in")}
            onChange={(e) => {
              setInputMode("in");
              setAmountIn(e.target.value);
              setTargetOut("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") doQuote();
            }}
            placeholder="输入卖出数量"
          />
        </div>

        <div className="sm:col-span-4">
          <span className="label flex items-center justify-between">
            <span>
              目标买入{" "}
              {inputMode === "out" && (
                <span className="text-brand-light">(优先)</span>
              )}
            </span>
            {outBalanceNum !== null && (
              <span className="font-mono text-[10px] text-ink-soft">
                余额: {outBalanceNum.toFixed(4)}
              </span>
            )}
          </span>
          <input
            className={`input font-mono ${
              inputMode === "out" ? "border-brand/50" : "opacity-80"
            }`}
            value={targetOut}
            onFocus={() => setInputMode("out")}
            onChange={(e) => {
              setInputMode("out");
              setTargetOut(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") doQuote();
            }}
            placeholder="可选：想得多少"
          />
        </div>

        <div className="sm:col-span-3 flex gap-1.5">
          <div className="w-16 shrink-0">
            <span className="label">滑点%</span>
            <input
              className="input font-mono px-2 text-center"
              value={slippagePct}
              onChange={(e) => setSlippagePct(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="btn-primary flex-1 h-[34px] self-end text-xs"
            disabled={loading || !chainId || !tokenIn || !tokenOut}
            onClick={() => doQuote()}
          >
            {loading ? "询价…" : "报价"}
          </button>
        </div>
      </div>

      {/* 快捷余额百分比按钮 */}
      {inBalanceNum !== null && inBalanceNum > 0 && (
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-ink-muted">快捷卖出:</span>
          {[25, 50, 75, 100].map((pct) => (
            <button
              key={pct}
              type="button"
              onClick={() => {
                const v =
                  pct === 100
                    ? inBalanceNum * (quote?.tokenIn.isNative ? 0.98 : 0.9999)
                    : (inBalanceNum * pct) / 100;
                const str = Number(v.toFixed(6)).toString();
                setInputMode("in");
                setAmountIn(str);
                setTargetOut("");
                doQuote({ overrideAmountIn: str });
              }}
              className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-ink-soft hover:border-brand/40 hover:text-brand-light"
            >
              {pct === 100 ? "MAX" : `${pct}%`}
            </button>
          ))}
        </div>
      )}

      {err && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          ❌ {err}
        </div>
      )}

      {/* 报价详情卡片 */}
      {quote && (
        <div className="rounded-xl border border-white/[0.08] bg-surface-raised/70 p-3 space-y-2.5 text-xs">
          {/* 费率档位切换 */}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-ink-muted">{quote.dexName}:</span>
              {quote.availableFees.map((f) => {
                const active = f.fee === quote.fee;
                return (
                  <button
                    key={f.fee}
                    type="button"
                    onClick={() => {
                      setFeeOverride(f.fee);
                      doQuote({ overrideFee: f.fee });
                    }}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition ${
                      active
                        ? "bg-brand/20 text-brand-light border border-brand/40 font-semibold"
                        : "bg-white/[0.04] text-ink-soft hover:text-ink"
                    }`}
                  >
                    {(f.fee / 10000).toFixed(2)}%
                  </button>
                );
              })}
            </div>
            <span className="font-mono text-[11px] text-ink-muted">
              池 {short(quote.pool)}
            </span>
          </div>

          {/* 兑换主数字 */}
          <div className="rounded-lg border border-ok/30 bg-ok/[0.07] px-3 py-2 space-y-1">
            <div className="font-mono text-sm font-bold text-ink">
              {fmtFull(Number(quote.amountInHuman))} {quote.tokenIn.symbol} →{" "}
              <span className="text-ok">
                {fmtFull(Number(quote.amountOutHuman))} {quote.tokenOut.symbol}
              </span>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-ink-soft font-mono">
              <span>
                最低可得: {fmtFull(Number(quote.amountOutMinHuman))}{" "}
                {quote.tokenOut.symbol}
              </span>
              {quote.priceImpactPct !== null && (
                <span
                  className={
                    quote.priceImpactPct > 1
                      ? "text-danger font-semibold"
                      : "text-ink-soft"
                  }
                >
                  价格冲击: {quote.priceImpactPct.toFixed(3)}%
                </span>
              )}
            </div>
          </div>

          {/* 成交价 & CEX 对比 */}
          <div className="space-y-1 text-[11px]">
            <div className="font-mono text-ink-soft">
              成交汇率:{" "}
              {quote.cexCompare ? (
                <strong className="text-ink">
                  1 {quote.cexCompare.otherSymbol} ={" "}
                  {fmtFull(quote.cexCompare.displayPrice)}{" "}
                  {quote.cexCompare.stableSymbol}
                </strong>
              ) : (
                <strong className="text-ink">
                  1 {quote.tokenIn.symbol} = {fmtFull(quote.executionPrice)}{" "}
                  {quote.tokenOut.symbol}
                </strong>
              )}
            </div>

            {quote.cexCompare && (
              <div
                className={`rounded-lg border px-2.5 py-1.5 flex flex-wrap items-center justify-between gap-1 ${
                  Math.abs(quote.cexCompare.diffPct) > 1
                    ? "border-warn/40 bg-warn/10 text-warn"
                    : "border-brand/30 bg-brand/10 text-brand-light"
                }`}
              >
                <span>
                  📊 币安 ({quote.cexCompare.cexSymbolLabel}):{" "}
                  <strong className="font-mono">
                    1 {quote.cexCompare.otherSymbol} ={" "}
                    {fmtFull(quote.cexCompare.cexPrice)}{" "}
                    {quote.cexCompare.stableSymbol}
                  </strong>
                </span>
                <span className="font-mono font-semibold">
                  偏差 {quote.cexCompare.diffPct >= 0 ? "+" : ""}
                  {quote.cexCompare.diffPct.toFixed(2)}%
                </span>
              </div>
            )}
          </div>

          {/* 立即兑换按钮 */}
          {quote.router ? (
            <button
              type="button"
              className="btn-primary w-full py-2 text-xs font-semibold"
              onClick={executeSwap}
              disabled={swapping}
            >
              {swapping
                ? swapStep || "处理中…"
                : `🚀 立即兑换 (${quote.tokenIn.symbol} → ${quote.tokenOut.symbol})`}
            </button>
          ) : (
            <div className="text-[11px] text-warn">
              ⚠️ 请先在「系统配置 → DEX」填写 SwapRouter02 或 SwapRouter 地址以启用直接兑换。
            </div>
          )}

          {txHash && (
            <div className="text-[11px] font-mono text-ok">
              ✅ 交易已上链: {short(txHash)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
