"use client";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
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

export interface ExternalSwapPair {
  chainId: number;
  pool?: string;
  fee?: number;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  token0Decimals?: number;
  token1Decimals?: number;
  balances?: {
    token0: string;
    token1: string;
  } | null;
  pairFlip?: number;
  ts?: number;
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
  allowanceSufficient?: boolean;
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
 * 支持通过 externalPair 与上方探针/建仓选中的池子自动联动双币。
 */
export function SwapQuoteSection({
  externalPair,
  embedded = false,
}: {
  externalPair?: ExternalSwapPair | null;
  embedded?: boolean;
}) {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: allDexes } = useSWR<DexWithQuoter[]>("/api/dexes", fetcher);
  const { data: allMappings } = useSWR<CexToken[]>("/api/cex-mapping", fetcher);
  const { address, chainId: walletChainId, sendTx, switchChain, connect } = useWallet();

  // 可用 DEX：配了 quoter 的（显示 链-DEX）
  const dexOptions = useMemo(
    () => (allDexes ?? []).filter((d) => d.quoter),
    [allDexes]
  );
  const [dexId, setDexId] = useState<number | "">("");
  const dex = dexOptions.find((d) => d.id === dexId) ?? dexOptions[0] ?? null;

  // 合并当前探针池的双币 + 该链 CEX 映射代币列表（确保探针池的任意两个代币都可直接 Swap）
  const chainTokens = useMemo(() => {
    const list: CexToken[] = [];
    const seenSym = new Set<string>();
    const seenAddr = new Set<string>();

    const targetChainId = dex?.chain_id_ref ?? externalPair?.chainId;
    if (
      externalPair &&
      targetChainId === externalPair.chainId &&
      externalPair.token0 &&
      externalPair.token1
    ) {
      const sym0 = externalPair.token0Symbol || short(externalPair.token0);
      const sym1 = externalPair.token1Symbol || short(externalPair.token1);
      const p0: CexToken = {
        token_symbol: sym0,
        token_addr: externalPair.token0,
        chain_id_ref: externalPair.chainId,
      };
      const p1: CexToken = {
        token_symbol: sym1,
        token_addr: externalPair.token1,
        chain_id_ref: externalPair.chainId,
      };
      // 若翻转（token1 为主币），把主币排前
      const ordered = externalPair.pairFlip === 1 ? [p1, p0] : [p0, p1];
      for (const item of ordered) {
        list.push(item);
        seenSym.add(item.token_symbol);
        seenAddr.add(item.token_addr.toLowerCase());
      }
    }

    for (const m of allMappings ?? []) {
      if (!dex || m.chain_id_ref !== dex.chain_id_ref) continue;
      const addrLower = (m.token_addr || "").toLowerCase();
      if (seenSym.has(m.token_symbol)) continue;
      if (addrLower !== "__native__" && seenAddr.has(addrLower)) continue;
      list.push(m);
      seenSym.add(m.token_symbol);
      if (addrLower !== "__native__") seenAddr.add(addrLower);
    }
    return list;
  }, [dex, allMappings, externalPair]);

  const [inSym, setInSym] = useState("");
  const [outSym, setOutSym] = useState("");
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

  // 当外部探针选中池子时，自动切换 DEX 并锁定该池的两个代币
  const lastExternalKeyRef = useRef<string>("");
  useEffect(() => {
    if (!externalPair || !externalPair.token0 || !externalPair.token1) return;
    const key = `${externalPair.chainId}:${externalPair.token0.toLowerCase()}:${externalPair.token1.toLowerCase()}:${externalPair.pairFlip ?? 0}:${externalPair.ts ?? 0}`;
    if (lastExternalKeyRef.current === key) return;
    lastExternalKeyRef.current = key;

    const matchedDex = dexOptions.find(
      (d) => d.chain_id_ref === externalPair.chainId
    );
    if (matchedDex) {
      setDexId(matchedDex.id);
    }
    const sym0 = externalPair.token0Symbol || short(externalPair.token0);
    const sym1 = externalPair.token1Symbol || short(externalPair.token1);
    const dec0 = externalPair.token0Decimals ?? 18;
    const dec1 = externalPair.token1Decimals ?? 18;
    // 默认把主币放卖出或按翻转方向设置，点击 ⇄ 可一键互换
    const nextInSym = externalPair.pairFlip === 1 ? sym1 : sym0;
    const nextOutSym = externalPair.pairFlip === 1 ? sym0 : sym1;
    setInSym(nextInSym);
    setOutSym(nextOutSym);

    // 若探针已顺带返回钱包双币余额，直接注入，免去重复调 /api/token-balances
    if (externalPair.balances) {
      const isFlipped = externalPair.pairFlip === 1;
      setBalances({
        in: isFlipped ? externalPair.balances.token1 : externalPair.balances.token0,
        out: isFlipped ? externalPair.balances.token0 : externalPair.balances.token1,
        decIn: isFlipped ? dec1 : dec0,
        decOut: isFlipped ? dec0 : dec1,
      });
      const targetDexId = matchedDex?.chain_id_ref ?? externalPair.chainId;
      if (address) {
        initialLoadedRef.current = `${targetDexId}-${nextInSym}-${nextOutSym}-${address}`;
      }
    }

    if (externalPair.fee) {
      setFeeOverride(externalPair.fee);
    } else {
      setFeeOverride(undefined);
    }
    setQuote(null);
    setErr("");
  }, [externalPair, dexOptions, address]);

  // 默认初始化两个代币
  useEffect(() => {
    if (dex && chainTokens.length >= 2 && (!inSym || !outSym)) {
      setInSym(chainTokens[0].token_symbol);
      setOutSym(chainTokens[1].token_symbol);
    }
  }, [dex, chainTokens, inSym, outSym]);

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
    },
    [dex, tokenInMeta, tokenOutMeta, slippage, feeOverride, address]
  );

  // 防抖自动报价（350ms 极速响应）
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const autoFillTsRef = useRef(0);
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      if (Date.now() - autoFillTsRef.current < 800) return;
      const amount = editingSide === "in" ? amountIn : amountOut;
      if (amount && Number(amount) > 0) doQuote(amount, editingSide);
    }, 350);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [amountIn, amountOut, editingSide, inSym, outSym, slippage, feeOverride, doQuote]);

  const initialLoadedRef = useRef("");
  useEffect(() => {
    if (!dex || !address || !tokenInMeta || !tokenOutMeta || inSym === outSym)
      return;
    const key = `${dex.chain_id_ref}-${inSym}-${outSym}-${address}`;
    if (initialLoadedRef.current === key) return;
    initialLoadedRef.current = key;
    fetchBalances();
  }, [dex, inSym, outSym, address, tokenInMeta, tokenOutMeta, fetchBalances]);

  /** 执行兑换（报价阶段已并发返回 allowanceSufficient，点击后 0 前置 RPC 秒弹钱包） */
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
      if (walletChainId !== quote.chain.chain_id) {
        await switchChain(quote.chain.chain_id);
      }

      const routerAddr = quote.router.addr;
      const amountInBig = BigInt(quote.amountIn);

      if (!quote.tokenIn.isNative) {
        let needApprove = !quote.allowanceSufficient;
        // 仅当报价时未携带钱包地址（未能预检 allowanceSufficient）时才兜底查一次链上 allowance
        if (quote.allowanceSufficient === undefined) {
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
        }

        if (needApprove) {
          const appTx = buildApproveCalldata(
            quote.tokenIn.addr,
            routerAddr,
            MAX_UINT256
          );
          const appHash = await sendTx({ ...appTx, gas: 80000n });
          await waitForTxReceipt(appHash, 15_000);
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

  /** 按钱包余额比例快捷填入卖出数量 */
  function applyBalancePct(pct: number) {
    if (!balances || balances.in === "0") return;
    try {
      const raw = BigInt(balances.in);
      const part = (raw * BigInt(pct)) / 100n;
      const human = fmtBalanceFull(part.toString(), balances.decIn);
      setEditingSide("in");
      setAmountIn(human);
    } catch {
      /* ignore */
    }
  }

  const linkedPairLabel = externalPair
    ? externalPair.pairFlip === 1
      ? `${externalPair.token1Symbol}/${externalPair.token0Symbol}`
      : `${externalPair.token0Symbol}/${externalPair.token1Symbol}`
    : "";

  return (
    <section className={embedded ? "panel-inset p-3.5" : "card p-4"}>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h2 className="text-sm font-semibold text-ink">
            {embedded ? "③ 💱 当前池双币极速兑换 (Swap)" : "💱 代币兑换 (Swap)"}
          </h2>
          {linkedPairLabel && (
            <span className="tag-info" title="已自动同步上方探针选中的交易对双币">
              🔗 已同步 {linkedPairLabel}
            </span>
          )}
        </div>

        {/* DEX 选择（紧凑宽度） */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-ink-soft shrink-0">DEX</span>
          {dexOptions.length === 0 ? (
            <span className="text-warn">未配 QuoterV2</span>
          ) : (
            <select
              className="input !w-auto max-w-[145px] py-1 pl-2 pr-5 text-xs"
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
      </div>

      {/* 兑换输入区：左右严格等宽等高对齐 */}
      {dex && chainTokens.length >= 2 && (
        <div className="space-y-2.5">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:items-stretch">
            {/* 输入侧（卖出 In） */}
            <div className="flex flex-col justify-between rounded-lg border border-white/[0.08] bg-surface-base/70 p-2.5 text-xs">
              <div className="mb-1.5 flex h-[18px] items-center justify-between gap-1 text-ink-soft">
                <span className="shrink-0">卖出 (In)</span>
                <span className="truncate font-mono text-[11px]">
                  余额:{" "}
                  {balances && tokenInMeta
                    ? fmtBalance(balances.in, balances.decIn)
                    : "—"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  className="input flex-1 min-w-0 px-2 py-1.5 font-mono text-xs"
                  value={amountIn}
                  onChange={(e) => {
                    setEditingSide("in");
                    setAmountIn(e.target.value);
                  }}
                  placeholder="输入数量 0.0"
                />
                <select
                  className="input !w-[78px] shrink-0 py-1.5 pl-2 pr-5 text-xs font-semibold truncate"
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
              <div className="mt-1.5 flex h-[22px] items-center gap-1">
                {[25, 50, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={!balances || balances.in === "0"}
                    onClick={() => applyBalancePct(pct)}
                    className="rounded border border-white/[0.12] bg-white/[0.05] px-1.5 py-0.5 text-[10px] text-ink-soft transition hover:border-cyan-400/50 hover:text-cyan-300 disabled:opacity-40 disabled:pointer-events-none"
                  >
                    {pct === 100 ? "MAX" : `${pct}%`}
                  </button>
                ))}
              </div>
            </div>

            {/* 交换按钮（垂直居中对齐） */}
            <div className="flex items-center justify-center">
              <button
                type="button"
                className="btn-ghost h-8 w-8 p-0 text-xs font-bold"
                title="交换买卖方向"
                onClick={swapSides}
              >
                ⇄
              </button>
            </div>

            {/* 输出侧（得到 Out） */}
            <div className="flex flex-col justify-between rounded-lg border border-white/[0.08] bg-surface-base/70 p-2.5 text-xs">
              <div className="mb-1.5 flex h-[18px] items-center justify-between gap-1 text-ink-soft">
                <span className="shrink-0">得到 (Out)</span>
                <span className="truncate font-mono text-[11px]">
                  余额:{" "}
                  {balances && tokenOutMeta
                    ? fmtBalance(balances.out, balances.decOut)
                    : "—"}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <input
                  className="input flex-1 min-w-0 px-2 py-1.5 font-mono text-xs"
                  value={amountOut}
                  onChange={(e) => {
                    setEditingSide("out");
                    setAmountOut(e.target.value);
                  }}
                  placeholder="预估数量 0.0"
                />
                <select
                  className="input !w-[78px] shrink-0 py-1.5 pl-2 pr-5 text-xs font-semibold truncate"
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
              <div className="mt-1.5 flex h-[22px] items-center justify-between text-[10px] text-ink-muted">
                {quote ? (
                  <span className="truncate font-mono text-ink-soft">
                    最少得: {trimNum(quote.amountOutMinHuman)} {quote.tokenOut.symbol}
                  </span>
                ) : (
                  <span>输入任一侧自动寻优报价</span>
                )}
              </div>
            </div>
          </div>

          {/* 滑点 + 费率档 + 兑换按钮（单行水平对齐） */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-ink-soft shrink-0">滑点</span>
              <select
                className="input !w-[68px] shrink-0 py-1 pl-2 pr-5 text-xs"
                value={slippage}
                onChange={(e) => setSlippage(Number(e.target.value))}
              >
                <option value={0.1}>0.1%</option>
                <option value={0.5}>0.5%</option>
                <option value={1}>1%</option>
                <option value={3}>3%</option>
              </select>

              {quote && quote.availableFees.length > 1 && (
                <div className="flex flex-wrap items-center gap-1">
                  {quote.availableFees.map((f) => (
                    <button
                      key={f.fee}
                      type="button"
                      className={`rounded px-2 py-0.5 text-[11px] transition ${
                        f.fee === quote.fee
                          ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/50"
                          : "border border-white/15 bg-white/[0.05] text-ink-soft hover:bg-white/[0.1] hover:text-white"
                      }`}
                      onClick={() => setFeeOverride(f.fee)}
                    >
                      {f.fee / 10000}% ({abbrev(f.liquidity)})
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button
              type="button"
              className="btn-primary h-[30px] px-4 text-xs"
              disabled={swapping || quoting || !quote}
              onClick={executeSwap}
            >
              {swapping
                ? "兑换执行中…"
                : quoting
                  ? "报价中…"
                  : `⚡ 立即兑换 ${inSym} → ${outSym}`}
            </button>
          </div>
        </div>
      )}

      {quoting && (
        <p className="mt-2 text-xs text-ink-soft">
          报价中…（自动寻优池子 + Quoter 调用）
        </p>
      )}
      {err && <p className="mt-2 text-xs text-warn">❌ {err}</p>}
      {txHash && (
        <p className="mt-2 text-xs text-ok">
          ✅ 兑换交易已提交：<span className="font-mono">{short(txHash)}</span>
        </p>
      )}

      {/* 报价结果 */}
      {quote && !quoting && (
        <div className="mt-2.5 rounded-lg border border-white/[0.08] bg-surface-base/80 p-3 text-xs space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-ink-soft">预计获得</span>
            <span className="font-semibold font-mono text-ink">
              {quote.amountOutHuman} {quote.tokenOut.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.06] pt-1">
            <span className="text-ink-soft">
              滑点 {quote.slippagePct}% 后最少
            </span>
            <span className="font-mono text-ink">
              {quote.amountOutMinHuman} {quote.tokenOut.symbol}
            </span>
          </div>
          <div className="flex items-center justify-between border-t border-white/[0.06] pt-1">
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
              <div className="flex items-center justify-between border-t border-white/[0.06] pt-1">
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
            <div className="flex items-center justify-between border-t border-white/[0.06] pt-1">
              <span
                className="text-ink-soft"
                title="同口径对比：CEX 报价 vs 本次 DEX 实际成交价"
              >
                CEX 对比 ({quote.cexCompare.otherSymbol}→
                {quote.cexCompare.stableSymbol})
              </span>
              <span
                className={
                  Math.abs(quote.cexCompare.diffPct) > 1
                    ? "text-warn font-semibold font-mono"
                    : "font-mono text-ink"
                }
              >
                CEX {quote.cexCompare.cexPrice.toPrecision(6)} · DEX{" "}
                {quote.cexCompare.executionPriceInStable.toPrecision(6)} ·{" "}
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
          <div className="flex items-center justify-between border-t border-white/[0.06] pt-1">
            <span className="text-ink-soft">路由池</span>
            <span className="font-mono text-[11px] text-ink">
              {short(quote.pool)} · fee {quote.fee / 10000}% · {quote.dexName}
            </span>
          </div>
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
      .slice(0, 4)
      .replace(/0+$/, "");
    return frac ? `${intPart}.${frac}` : `${intPart}`;
  } catch {
    return "0";
  }
}

function fmtBalanceFull(raw: string, decimals?: number): string {
  try {
    const n = BigInt(raw);
    const d = BigInt(decimals ?? 18);
    const base = 10n ** d;
    const intPart = n / base;
    const frac = (n % base)
      .toString()
      .padStart(Number(d), "0")
      .slice(0, 8)
      .replace(/0+$/, "");
    return frac ? `${intPart}.${frac}` : `${intPart}`;
  } catch {
    return "0";
  }
}
