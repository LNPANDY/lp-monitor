"use client";
import { useState, useEffect, useCallback, useRef } from "react";
import { mutate } from "swr";
import {
  useWallet,
  waitForTxReceipt,
  verifyNftPoolMatch,
  extractMintedTokenIdFromReceipt,
} from "@/lib/wallet/use-wallet";
import {
  buildApproveCalldata,
  buildMintCalldata,
  buildNftApproveCalldata,
  buildSetApprovalForAllCalldata,
  buildStakeDepositCalldata,
} from "@/lib/wallet/build-mint";
import { authHeaders, short, fmtFull } from "./util";
import { toast } from "./toast";

interface MintData {
  chain: { id: number; name: string; chain_id: number };
  pairFlip: number;
  pool: {
    address: string;
    token0: string;
    token1: string;
    token0Symbol: string;
    token1Symbol: string;
    token0Decimals: number;
    token1Decimals: number;
    fee: number;
    tickSpacing: number;
    currentTick: number;
    sqrtPriceX96: string;
    priceCurrent: number;
  };
  range: {
    tickLower: number;
    tickUpper: number;
    priceLow: string | number;
    priceHigh: string | number;
    isMinimal: boolean;
  };
  compute: null | {
    liquidity: string;
    amount0: string;
    amount1: string;
    amount0Human: string;
    amount1Human: string;
    shareAfter?: number;
    poolLiquidity?: string;
    stakedLiquidity?: string;
    shareInPool?: number;
  };
  balances: null | {
    token0: string;
    token1: string;
    token0Human: string;
    token1Human: string;
  };
  matchedStaking: Array<{
    id: number;
    platform: string;
    pair_label: string;
    contract: string;
  }>;
  dex: null | { id: number; name: string; npm: string };
  approvals: null | {
    token0: { allowance: string; sufficient: boolean; decimals: number };
    token1: { allowance: string; sufficient: boolean; decimals: number };
    nftApprovedForAll?: boolean;
  };
}

export function MintPositionPanel({
  chainId: initialChainId,
  pool: initialPool,
  onClose,
  onCreated,
  onFlipChanged,
}: {
  chainId: number;
  pool?: string;
  onClose?: () => void;
  onCreated?: () => void;
  onFlipChanged?: () => void;
}) {
  const wallet = useWallet();
  const [poolInput, setPoolInput] = useState(initialPool ?? "");
  const [side, setSide] = useState<"token0" | "token1">("token0");
  const [amount, setAmount] = useState("100");
  const [slippageBps, setSlippageBps] = useState(100); // 默认 1%
  const [autoStake, setAutoStake] = useState(true);
  const [selectedStaking, setSelectedStaking] = useState<string>("");

  const [data, setData] = useState<MintData | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [step, setStep] = useState("");
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [mintedTokenId, setMintedTokenId] = useState<string | null>(null);
  const [togglingAllApprove, setTogglingAllApprove] = useState(false);

  // 记录上一次已初始化默认方向的池地址，换池或翻转时自动把输入代币切到主币
  const initializedPoolRef = useRef<string>("");

  const loadParams = useCallback(
    async (opts?: {
      poolOverride?: string;
      sideOverride?: "token0" | "token1";
      amountOverride?: string;
      walletOverride?: string;
      silent?: boolean;
    }): Promise<MintData | null> => {
      const targetPool = (opts?.poolOverride ?? poolInput).trim();
      const targetSide = opts?.sideOverride ?? side;
      const targetAmount = opts?.amountOverride ?? amount;
      const targetWallet = opts?.walletOverride ?? wallet.address ?? undefined;
      if (!initialChainId || !targetPool) return null;
      if (!opts?.silent) setLoading(true);
      setErr("");
      try {
        const r = await fetch("/api/liquidity-mint", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            chain_id: initialChainId,
            pool: targetPool,
            wallet: targetWallet,
            input_side: targetSide,
            input_amount: targetAmount || "0",
          }),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "加载建仓参数失败");
        let nextData: MintData = j.data;

        if (nextData.matchedStaking?.length > 0 && !selectedStaking) {
          setSelectedStaking(nextData.matchedStaking[0].contract);
        }

        // 首次加载该池时：若该池标记了翻转（pairFlip=1，即 token1 为主币如 ETH），自动将默认输入币种设为 token1
        const poolKey = `${initialChainId}:${nextData.pool.address.toLowerCase()}:${nextData.pairFlip}`;
        if (initializedPoolRef.current !== poolKey && !opts?.sideOverride) {
          initializedPoolRef.current = poolKey;
          const preferredSide: "token0" | "token1" =
            nextData.pairFlip === 1 ? "token1" : "token0";
          if (preferredSide !== targetSide) {
            setSide(preferredSide);
            const r2 = await fetch("/api/liquidity-mint", {
              method: "POST",
              headers: authHeaders({ "Content-Type": "application/json" }),
              body: JSON.stringify({
                chain_id: initialChainId,
                pool: targetPool,
                wallet: targetWallet,
                input_side: preferredSide,
                input_amount: targetAmount || "0",
              }),
            });
            const j2 = await r2.json();
            if (j2.ok) nextData = j2.data;
          }
        }

        setData(nextData);
        return nextData;
      } catch (e: any) {
        setErr(e.message || String(e));
        return null;
      } finally {
        if (!opts?.silent) setLoading(false);
      }
    },
    [initialChainId, poolInput, side, amount, wallet.address, selectedStaking]
  );

  // 当从外部收藏条或「撤池重开」传入新池子时，立即同步并加载
  useEffect(() => {
    if (initialPool && initialPool !== poolInput) {
      setPoolInput(initialPool);
      setTxHashes([]);
      setMintedTokenId(null);
      loadParams({ poolOverride: initialPool });
    } else if (initialPool && !data && !loading) {
      loadParams({ poolOverride: initialPool });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChainId, initialPool]);

  // 当钱包连接地址变化时，静默刷新余额与授权状态
  useEffect(() => {
    if (data && wallet.address) {
      loadParams({ silent: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet.address]);

  /** 在建仓面板内一键切换翻转状态，同时同步输入主币 */
  async function handleToggleFlip() {
    if (!data) return;
    try {
      const r = await fetch("/api/liquidity-probe/pair-flip", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: initialChainId,
          token0: data.pool.token0,
          token1: data.pool.token1,
          flip: data.pairFlip !== 1,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "翻转失败");
      const newFlip = data.pairFlip === 1 ? 0 : 1;
      const nextSide: "token0" | "token1" = newFlip === 1 ? "token1" : "token0";
      setSide(nextSide);
      initializedPoolRef.current = `${initialChainId}:${data.pool.address.toLowerCase()}:${newFlip}`;
      await loadParams({ sideOverride: nextSide });
      mutate("/api/positions");
      mutate("/api/liquidity-favorites");
      onFlipChanged?.();
      toast.success(
        `已切换计价方向：主币设为 ${
          newFlip === 1 ? data.pool.token1Symbol : data.pool.token0Symbol
        }`
      );
    } catch (e: any) {
      toast.error(e.message || "翻转失败");
    }
  }

  /** 一键开启/撤销 Staker 的 setApprovalForAll（免每次建仓后的单 NFT 授权交易） */
  async function handleToggleSetApprovalForAll(approve: boolean) {
    if (!data || !data.dex || !selectedStaking) return;
    setTogglingAllApprove(true);
    setErr("");
    try {
      let addr = wallet.address;
      if (!addr) {
        addr = await wallet.connect();
        if (!addr) throw new Error("未连接钱包");
      }
      if (wallet.chainId !== data.chain.chain_id) {
        await wallet.switchChain(data.chain.chain_id, {
          chainName: data.chain.name,
          rpcUrls: [],
        });
      }
      const txParams = buildSetApprovalForAllCalldata(
        data.dex.npm as `0x${string}`,
        selectedStaking as `0x${string}`,
        approve
      );
      const h = await wallet.sendTx({ ...txParams, gas: 100000n });
      toast.info(approve ? "正在授权 Staker 免签通道…" : "正在撤销 Staker 批量授权…");
      await waitForTxReceipt(h, 45_000);
      await loadParams({ silent: true, walletOverride: addr });
      toast.success(
        approve
          ? "已开启「免每次 NFT 授权」！后续建仓+质押将直接跳过 NFT 授权步骤"
          : "已撤销 Staker 的批量 NFT 授权"
      );
    } catch (e: any) {
      toast.error(e.message || String(e));
    } finally {
      setTogglingAllApprove(false);
    }
  }

  /** 按钱包余额百分比快捷填入 */
  function fillBalancePct(pct: number) {
    if (!data?.balances) return;
    const rawBal = Number(
      side === "token0" ? data.balances.token0Human : data.balances.token1Human
    );
    if (!Number.isFinite(rawBal) || rawBal <= 0) return;
    const val = pct >= 100 ? rawBal * 0.9999 : (rawBal * pct) / 100;
    const decimals =
      side === "token0" ? data.pool.token0Decimals : data.pool.token1Decimals;
    const formatted = Number(val.toFixed(Math.min(decimals, 6))).toString();
    setAmount(formatted);
    loadParams({ amountOverride: formatted });
  }

  async function execute() {
    if (!data || !data.compute || !data.dex) return;
    setErr("");
    setTxHashes([]);
    setMintedTokenId(null);

    try {
      // 1. 连接钱包
      let addr = wallet.address;
      if (!addr) {
        setStep("连接钱包…");
        addr = await wallet.connect();
        if (!addr) throw new Error("未连接钱包");
      }

      // 2. 切链
      if (wallet.chainId !== data.chain.chain_id) {
        setStep(`切换到 ${data.chain.name}…`);
        await wallet.switchChain(data.chain.chain_id, {
          chainName: data.chain.name,
          rpcUrls: [],
        });
      }

      // 3. 重新带钱包地址拉取最新授权 & 金额
      setStep("校验余额与授权状态…");
      const fresh = await loadParams({
        walletOverride: addr,
        silent: true,
      });
      if (!fresh || !fresh.compute || !fresh.dex) {
        throw new Error("无法计算建仓金额，请检查输入或 DEX 配置");
      }

      const npm = fresh.dex.npm as `0x${string}`;
      const amount0 = BigInt(fresh.compute.amount0);
      const amount1 = BigInt(fresh.compute.amount1);

      // 4. Approve token0（若需要）
      if (fresh.approvals && !fresh.approvals.token0.sufficient && amount0 > 0n) {
        setStep(`1/3 · 授权 ${fresh.pool.token0Symbol} 给 NPM…`);
        const tx = buildApproveCalldata(fresh.pool.token0 as `0x${string}`, npm);
        const h = await wallet.sendTx({ ...tx, gas: 80000n });
        setTxHashes((p) => [...p, h]);
        setStep(`等待 ${fresh.pool.token0Symbol} 授权上链…`);
        await waitForTxReceipt(h, 45_000);
      }

      // 5. Approve token1（若需要）
      if (fresh.approvals && !fresh.approvals.token1.sufficient && amount1 > 0n) {
        setStep(`1/3 · 授权 ${fresh.pool.token1Symbol} 给 NPM…`);
        const tx = buildApproveCalldata(fresh.pool.token1 as `0x${string}`, npm);
        const h = await wallet.sendTx({ ...tx, gas: 80000n });
        setTxHashes((p) => [...p, h]);
        setStep(`等待 ${fresh.pool.token1Symbol} 授权上链…`);
        await waitForTxReceipt(h, 45_000);
      }

      // 6. NPM.mint
      const factor = BigInt(10000 - slippageBps);
      const amount0Min = (amount0 * factor) / 10000n;
      const amount1Min = (amount1 * factor) / 10000n;

      setStep("2/3 · 创建集中流动性仓位（NPM.mint）…");
      const mintTx = buildMintCalldata(npm, {
        token0: fresh.pool.token0 as `0x${string}`,
        token1: fresh.pool.token1 as `0x${string}`,
        fee: fresh.pool.fee,
        tickLower: fresh.range.tickLower,
        tickUpper: fresh.range.tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min,
        amount1Min,
        recipient: addr as `0x${string}`,
      });
      const mintHash = await wallet.sendTx({ ...mintTx, gas: 550000n });
      setTxHashes((p) => [...p, mintHash]);

      setStep("等待 Mint 交易确认并解析 NFT #tokenId…");
      const tokenId = await extractMintedTokenIdFromReceipt(
        mintHash,
        addr as `0x${string}`,
        npm,
        45_000
      );
      if (tokenId !== null) setMintedTokenId(tokenId.toString());

      // 7. 自动质押（如勾选且配置了匹配的质押合约）
      if (autoStake && selectedStaking && tokenId !== null) {
        // 前端强校验：核验该 NFT 的底层 (token0, token1, fee) 是否 100% 匹配当前池子，杜绝错池质押
        setStep(`核验 NFT #${tokenId.toString()} 池子归属…`);
        const check = await verifyNftPoolMatch(
          npm,
          tokenId,
          fresh.pool.token0,
          fresh.pool.token1,
          fresh.pool.fee
        );
        if (!check.valid) {
          throw new Error(
            check.reason || `NFT #${tokenId.toString()} 校验未通过，已中止质押`
          );
        }

        // 若尚未开启 setApprovalForAll，则执行单笔 approve(staker, tokenId)
        if (!fresh.approvals?.nftApprovedForAll) {
          setStep(`3/3 · 授权 NFT #${tokenId.toString()} 给质押合约…`);
          const approveNftTx = buildNftApproveCalldata(
            npm,
            selectedStaking as `0x${string}`,
            tokenId
          );
          const h1 = await wallet.sendTx({ ...approveNftTx, gas: 120000n });
          setTxHashes((p) => [...p, h1]);
          setStep(`等待 NFT #${tokenId.toString()} 授权确认…`);
          await waitForTxReceipt(h1, 45_000);
        }

        setStep(`3/3 · 质押 NFT #${tokenId.toString()}（deposit）…`);
        const stakeTx = buildStakeDepositCalldata(
          selectedStaking as `0x${string}`,
          tokenId
        );
        const h2 = await wallet.sendTx({ ...stakeTx, gas: 320000n });
        setTxHashes((p) => [...p, h2]);
        setStep(`等待质押交易确认…`);
        await waitForTxReceipt(h2, 45_000);
      }

      setStep("");
      toast.success(
        tokenId !== null
          ? `建仓成功！NFT #${tokenId.toString()} ${
              autoStake && selectedStaking ? "已自动质押" : "已入账"
            }`
          : "建仓成功！"
      );

      // 触发后端快速扫描以立即把新仓位收录进监控面板
      fetch("/api/monitor", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mode: "combined" }),
      })
        .then(() => mutate("/api/positions"))
        .catch(() => {});

      loadParams({ silent: true, walletOverride: addr });
      onCreated?.();
    } catch (e: any) {
      setErr(e.message || String(e));
      toast.error(e.message || "建仓操作中断");
      setStep("");
    }
  }

  // 根据 pairFlip 决定展示口径（翻转后 token1 为主币 Base，token0 为计价币 Quote）
  const isFlipped = data?.pairFlip === 1;
  const baseSymbol = data
    ? isFlipped
      ? data.pool.token1Symbol
      : data.pool.token0Symbol
    : "Token0";
  const quoteSymbol = data
    ? isFlipped
      ? data.pool.token0Symbol
      : data.pool.token1Symbol
    : "Token1";

  const rawPriceCurr = Number(data?.pool.priceCurrent ?? 0);
  const rawPriceLow = Number(data?.range.priceLow ?? 0);
  const rawPriceHigh = Number(data?.range.priceHigh ?? 0);

  const displayPriceCurrent =
    isFlipped && rawPriceCurr > 0 ? 1 / rawPriceCurr : rawPriceCurr;
  const displayPriceLow =
    isFlipped && rawPriceHigh > 0 ? 1 / rawPriceHigh : rawPriceLow;
  const displayPriceHigh =
    isFlipped && rawPriceLow > 0 ? 1 / rawPriceLow : rawPriceHigh;

  // 下拉选项按「当前主币在前」排序，避免用户翻转后还要手动找 ETH
  const sideOptions: Array<{
    value: "token0" | "token1";
    symbol: string;
    roleLabel: string;
  }> = data
    ? isFlipped
      ? [
          { value: "token1", symbol: data.pool.token1Symbol, roleLabel: "主币" },
          {
            value: "token0",
            symbol: data.pool.token0Symbol,
            roleLabel: "计价币",
          },
        ]
      : [
          { value: "token0", symbol: data.pool.token0Symbol, roleLabel: "主币" },
          {
            value: "token1",
            symbol: data.pool.token1Symbol,
            roleLabel: "计价币",
          },
        ]
    : [
        { value: "token0", symbol: "Token0", roleLabel: "" },
        { value: "token1", symbol: "Token1", roleLabel: "" },
      ];

  const currentSideBalance = data?.balances
    ? side === "token0"
      ? data.balances.token0Human
      : data.balances.token1Human
    : null;
  const currentSideSymbol = data
    ? side === "token0"
      ? data.pool.token0Symbol
      : data.pool.token1Symbol
    : "";

  return (
    <div className="rounded-xl border border-brand/30 bg-surface-card/95 p-3.5 space-y-3 shadow-card">
      <div className="flex items-center justify-between gap-2 border-b border-white/[0.07] pb-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <span className="inline-flex h-2 w-2 rounded-full bg-brand shadow-[0_0_8px_#06b6d4]" />
          <h3 className="text-sm font-semibold text-ink truncate">
            极速建仓 & 自动质押
          </h3>
          {data && (
            <span className="tag-info font-mono text-[11px]">
              {baseSymbol}/{quoteSymbol} · {(data.pool.fee / 10000).toFixed(2)}%
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {data && (
            <button
              type="button"
              onClick={handleToggleFlip}
              className={`btn-ghost btn-xs ${
                isFlipped
                  ? "border-brand/40 text-brand-light bg-brand/10"
                  : ""
              }`}
              title="切换主币/计价币方向（自动同步输入主币与价格展示）"
            >
              ⇄ 翻转计价
            </button>
          )}
          {onClose && (
            <button className="btn-ghost btn-xs" onClick={onClose}>
              收起
            </button>
          )}
        </div>
      </div>

      {/* 未选定池子时的轻量提示 */}
      {!data && !loading && (
        <div className="rounded-lg border border-dashed border-white/[0.12] bg-surface-raised/40 p-3 text-xs text-ink-soft">
          👆 点击上方<strong>「★ 收藏池工作台」</strong>任意标签，即可一键加载该池的最小区间并在此直接建仓+质押。
        </div>
      )}

      {/* 池子核心参数概览 */}
      {data && (
        <div className="space-y-3">
          <div className="rounded-lg border border-white/[0.07] bg-surface-raised/60 p-2.5 text-xs space-y-1.5">
            <div className="flex flex-wrap items-center justify-between gap-1">
              <div className="flex items-center gap-1.5">
                <span className="font-semibold text-ink">
                  {baseSymbol} / {quoteSymbol}
                </span>
                <span className="text-[11px] text-ink-soft">
                  ({data.chain.name}
                  {data.dex ? ` · ${data.dex.name}` : ""})
                </span>
              </div>
              <span className="font-mono text-[11px] text-ink-muted">
                池 {short(data.pool.address)}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pt-1 border-t border-white/[0.05]">
              <div>
                <span className="text-ink-soft">当前池价：</span>
                <span className="font-mono font-semibold text-brand-light">
                  1 {baseSymbol} = {fmtFull(displayPriceCurrent)} {quoteSymbol}
                </span>
              </div>
              <div>
                <span className="text-ink-soft">当前 Tick：</span>
                <span className="font-mono text-ink">
                  {data.pool.currentTick}
                </span>
                <span className="text-ink-muted ml-1">
                  (步长 {data.pool.tickSpacing})
                </span>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-1 pt-1 border-t border-white/[0.05]">
              <div>
                <span className="text-ink-soft">建仓最小区间：</span>
                <span className="font-mono font-semibold text-ok">
                  [{data.range.tickLower}, {data.range.tickUpper}]
                </span>
              </div>
              <div className="font-mono text-[11px] text-ink-soft">
                {fmtFull(displayPriceLow)} ~ {fmtFull(displayPriceHigh)}{" "}
                {quoteSymbol}
              </div>
            </div>
          </div>

          {/* 输入币种 & 数量 + 余额快捷按钮 */}
          <div className="rounded-lg border border-white/[0.07] bg-surface-raised/40 p-2.5 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-soft font-medium">
                输入单边数量（自动配平另一侧）
              </span>
              {currentSideBalance !== null && (
                <span className="font-mono text-[11px] text-ink-soft">
                  余额:{" "}
                  <strong className="text-ink">
                    {Number(currentSideBalance).toFixed(4)} {currentSideSymbol}
                  </strong>
                </span>
              )}
            </div>

            <div className="grid grid-cols-12 gap-2">
              <div className="col-span-5">
                <select
                  className="input font-medium"
                  value={side}
                  onChange={(e) => {
                    const s = e.target.value as "token0" | "token1";
                    setSide(s);
                    loadParams({ sideOverride: s });
                  }}
                >
                  {sideOptions.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.symbol} {opt.roleLabel ? `(${opt.roleLabel})` : ""}
                    </option>
                  ))}
                </select>
              </div>
              <div className="col-span-7 flex gap-1.5">
                <input
                  className="input font-mono flex-1"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") loadParams();
                  }}
                  placeholder="数量"
                />
                <button
                  type="button"
                  className="btn-ghost px-2.5 text-xs shrink-0"
                  onClick={() => loadParams()}
                  disabled={loading}
                >
                  {loading ? "…" : "重算"}
                </button>
              </div>
            </div>

            {/* 快捷百分比填入 + 滑点选择 */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-ink-muted mr-0.5">快捷:</span>
                {[25, 50, 75, 100].map((pct) => (
                  <button
                    key={pct}
                    type="button"
                    disabled={
                      !currentSideBalance || Number(currentSideBalance) <= 0
                    }
                    onClick={() => fillBalancePct(pct)}
                    className="rounded border border-white/[0.08] bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] text-ink-soft hover:border-brand/40 hover:text-brand-light disabled:opacity-40"
                  >
                    {pct === 100 ? "MAX" : `${pct}%`}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-1 text-[11px] text-ink-soft">
                <span>滑点:</span>
                {[50, 100, 200].map((bps) => (
                  <button
                    key={bps}
                    type="button"
                    onClick={() => setSlippageBps(bps)}
                    className={`rounded px-1.5 py-0.5 font-mono text-[10px] transition ${
                      slippageBps === bps
                        ? "bg-brand/20 text-brand-light border border-brand/40 font-semibold"
                        : "bg-white/[0.03] text-ink-soft border border-white/[0.06]"
                    }`}
                  >
                    {(bps / 100).toFixed(1)}%
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* 配平结果预览（按翻转后的主币优先展示） */}
          {data.compute && (
            <div className="space-y-1.5">
              <div className="grid grid-cols-2 gap-2 text-xs">
                {(isFlipped
                  ? [
                      {
                        sym: data.pool.token1Symbol,
                        amt: data.compute.amount1Human,
                        bal: data.balances?.token1Human,
                        needsApprove:
                          data.approvals && !data.approvals.token1.sufficient,
                      },
                      {
                        sym: data.pool.token0Symbol,
                        amt: data.compute.amount0Human,
                        bal: data.balances?.token0Human,
                        needsApprove:
                          data.approvals && !data.approvals.token0.sufficient,
                      },
                    ]
                  : [
                      {
                        sym: data.pool.token0Symbol,
                        amt: data.compute.amount0Human,
                        bal: data.balances?.token0Human,
                        needsApprove:
                          data.approvals && !data.approvals.token0.sufficient,
                      },
                      {
                        sym: data.pool.token1Symbol,
                        amt: data.compute.amount1Human,
                        bal: data.balances?.token1Human,
                        needsApprove:
                          data.approvals && !data.approvals.token1.sufficient,
                      },
                    ]
                ).map((item) => {
                  const insufficient =
                    item.bal !== undefined &&
                    Number(item.amt) > Number(item.bal) * 1.0001;
                  return (
                    <div
                      key={item.sym}
                      className={`rounded-lg border p-2 ${
                        insufficient
                          ? "border-danger/40 bg-danger/10"
                          : "border-white/[0.07] bg-surface-raised/60"
                      }`}
                    >
                      <div className="flex items-center justify-between text-[11px] text-ink-soft">
                        <span>需要 {item.sym}</span>
                        {item.needsApprove && (
                          <span className="text-[10px] text-warn">需授权</span>
                        )}
                      </div>
                      <div className="mt-0.5 font-mono text-sm font-semibold text-ink truncate">
                        {Number(item.amt).toFixed(6)}
                      </div>
                      {item.bal !== undefined && (
                        <div
                          className={`mt-0.5 font-mono text-[10px] ${
                            insufficient
                              ? "text-danger font-semibold"
                              : "text-ink-muted"
                          }`}
                        >
                          钱包: {Number(item.bal).toFixed(4)}{" "}
                          {insufficient ? "(余额不足)" : ""}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {data.compute.shareAfter !== undefined &&
                data.compute.shareAfter > 0 && (
                  <div className="flex items-center justify-between rounded-lg border border-white/[0.06] bg-surface-raised/40 px-2.5 py-1 text-[11px]">
                    <span className="text-ink-soft">预计建仓后池内占比</span>
                    <span className="font-mono font-bold text-brand-light">
                      {(data.compute.shareAfter * 100).toFixed(2)}%
                    </span>
                  </div>
                )}
            </div>
          )}

          {/* 质押与 ZIA DEX 免授权加速设置 */}
          {data.matchedStaking.length > 0 && (
            <div className="rounded-lg border border-ok/25 bg-ok/[0.06] p-2.5 text-xs space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="flex items-center gap-1.5 font-medium text-ok cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoStake}
                    onChange={(e) => setAutoStake(e.target.checked)}
                  />
                  Mint 后自动质押挖矿
                </label>

                {autoStake && selectedStaking && (
                  <div className="flex items-center gap-1.5">
                    {data.approvals?.nftApprovedForAll ? (
                      <>
                        <span className="tag-ok text-[10px]">
                          ⚡ 已开启免 NFT 授权
                        </span>
                        <button
                          type="button"
                          disabled={togglingAllApprove}
                          onClick={() => handleToggleSetApprovalForAll(false)}
                          className="text-[11px] text-ink-soft underline hover:text-danger"
                          title="撤销 Staker 对 NPM 的 setApprovalForAll 授权"
                        >
                          撤销
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        disabled={togglingAllApprove}
                        onClick={() => handleToggleSetApprovalForAll(true)}
                        className="rounded border border-brand/40 bg-brand/15 px-2 py-0.5 text-[11px] font-medium text-brand-light hover:bg-brand/25 transition"
                        title="开启后，每次建仓+质押可省去中间的 approve(tokenId) 钱包确认，且前端强制验证池子归属防错存"
                      >
                        {togglingAllApprove
                          ? "处理中…"
                          : "⚡ 开启免每次 NFT 授权"}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {autoStake && (
                <select
                  className="input text-xs"
                  value={selectedStaking}
                  onChange={(e) => setSelectedStaking(e.target.value)}
                >
                  {data.matchedStaking.map((s) => (
                    <option key={s.id} value={s.contract}>
                      {s.platform} · {s.pair_label} ({short(s.contract)})
                    </option>
                  ))}
                </select>
              )}
            </div>
          )}

          {/* 一键执行主按钮 */}
          <button
            type="button"
            className="btn-primary w-full py-2.5 text-sm font-semibold"
            onClick={execute}
            disabled={loading || !data.compute || !data.dex || !!step}
          >
            {step
              ? step
              : autoStake && data.matchedStaking.length > 0
              ? data.approvals?.nftApprovedForAll
                ? `⚡ 极速建仓 + 质押（免 NFT 授权 · 2 步直达）`
                : `🚀 一键建仓 + 质押（自动连签）`
              : "🚀 一键建仓（NPM.mint）"}
          </button>

          {mintedTokenId && (
            <div className="rounded-lg border border-ok/30 bg-ok/10 px-3 py-2 text-xs text-ok flex items-center justify-between">
              <span>🎉 新仓位 NFT #{mintedTokenId} 已就绪</span>
              <span className="font-mono text-[11px]">已同步至左侧监控列表</span>
            </div>
          )}

          {txHashes.length > 0 && (
            <div className="space-y-1 text-[11px] text-ink-soft">
              {txHashes.map((h, i) => (
                <div
                  key={h}
                  className="font-mono flex items-center justify-between"
                >
                  <span>交易 {i + 1}:</span>
                  <span>{short(h)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {err && (
        <div className="rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-xs text-danger">
          ❌ {err}
        </div>
      )}
    </div>
  );
}
