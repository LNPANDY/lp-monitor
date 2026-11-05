"use client";
import { useState } from "react";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";
import {
  buildRemoveLiquidityCalldata,
  buildDecreaseLiquidityCalldata,
  buildCollectCalldata,
  buildWithdrawCalldata,
  checkMulticallSupport,
} from "@/lib/wallet/build-multicall";
import { authHeaders, short } from "./util";
import { toast } from "./toast";

interface Position {
  id: number;
  chain_id_ref: number;
  chain_id: number;
  chain_name: string;
  dex_name: string;
  pool: string;
  token_id: string;
  token0_symbol: string;
  token1_symbol: string;
  pair_flip?: number;
  wallet_address: string;
  source: string;
  staker_contract: string;
}

interface RemoveParams {
  tokenId: string;
  npm: string;
  dexName: string;
  pool: string;
  chainIdRef: number;
  pairFlip: number;
  stakerContract: string;
  source: string;
  liquidity: string;
  realLiquidity: string;
  ownerOf: string;
  chain: {
    chainId: number;
    name: string;
    rpcUrls: string[];
    explorerUrl: string;
    nativeSymbol: string;
  };
}

// 缓存每个 NPM 合约是否支持 multicall，避免每次撤池多发一次 eth_call 探测
const multicallSupportCache = new Map<string, boolean>();

export function RemovePositionButton({
  position,
  onRemoved,
  onReopenPool,
}: {
  position: Position;
  onRemoved?: () => void;
  onReopenPool?: (chainIdRef: number, pool: string) => void;
}) {
  const wallet = useWallet();
  const [step, setStep] = useState<string>("");
  const [busyMode, setBusyMode] = useState<"" | "remove" | "reopen">("");
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [explorerUrl, setExplorerUrl] = useState<string>("");

  const isStakedPos =
    position.source === "staking" && !!position.staker_contract;

  /**
   * 一键执行「解质押（如质押中）→ 撤池 → 领币」完整流水线，无需二次点击确认。
   * 若 andReopen=true，同时将该池子载入右侧建仓面板以便立即按新区间重开。
   */
  async function handleQuickRemove(andReopen: boolean) {
    setBusyMode(andReopen ? "reopen" : "remove");
    setTxHashes([]);
    setStep("读取链上流动性…");

    try {
      // 1. 拉取链上实时参数
      const r = await fetch(`/api/positions/${position.id}/remove-params`, {
        headers: authHeaders(),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "获取撤池参数失败");
      const params: RemoveParams = j.data;
      setExplorerUrl(params.chain?.explorerUrl || "");

      // 若点了「撤池重开」，立刻先把右侧建仓面板切到当前池子，撤池同时即可准备参数
      if (andReopen && onReopenPool && params.chainIdRef && params.pool) {
        onReopenPool(params.chainIdRef, params.pool);
      }

      const liq = BigInt(params.realLiquidity || params.liquidity || "0");
      const isStaked =
        params.source === "staking" && !!params.stakerContract;

      if (liq === 0n && !isStaked) {
        // 链上已无流动性且未质押，直接同步数据库关闭
        await fetch(`/api/positions/${position.id}/remove-params`, {
          method: "POST",
          headers: authHeaders(),
        });
        toast.info(
          `仓位 #${position.token_id} 链上流动性已为 0，已为您归档关闭`
        );
        setStep("");
        setBusyMode("");
        onRemoved?.();
        return;
      }

      // 2. 连接钱包
      let addr = wallet.address;
      if (!addr) {
        setStep("连接钱包…");
        addr = await wallet.connect();
        if (!addr) throw new Error("未连接钱包");
      }

      // 3. 校验钱包归属
      if (addr.toLowerCase() !== position.wallet_address.toLowerCase()) {
        throw new Error(
          `请切换钱包至仓位持有人 ${short(
            position.wallet_address
          )}（当前连接 ${short(addr)}）`
        );
      }

      // 4. 切换链（如需要）
      if (wallet.chainId !== params.chain.chainId) {
        setStep(`切换到 ${params.chain.name}…`);
        await wallet.switchChain(params.chain.chainId, {
          chainName: params.chain.name,
          nativeCurrency: {
            name: params.chain.nativeSymbol || "ETH",
            symbol: params.chain.nativeSymbol || "ETH",
            decimals: 18,
          },
          rpcUrls: params.chain.rpcUrls,
          blockExplorerUrls: params.chain.explorerUrl
            ? [params.chain.explorerUrl]
            : undefined,
        });
      }

      const tokenId = BigInt(params.tokenId);
      const npm = params.npm as `0x${string}`;
      const recipient = addr as `0x${string}`;

      // 5. 若质押中，先调 Staker.withdraw(tokenId)
      if (isStaked && params.stakerContract) {
        setStep(`1/3 · 解质押 #${params.tokenId}…`);
        const withdrawData = buildWithdrawCalldata(tokenId);
        const h1 = await wallet.sendTx({
          to: params.stakerContract,
          data: withdrawData,
          gas: 280000n,
        });
        setTxHashes((prev) => [...prev, h1]);
        setStep(`等待解质押确认…`);
        await waitForTxReceipt(h1, 45_000);
      }

      // 6. 判断是否支持 multicall（ZIA DEX 直接跳过探测走分步连签，节省一次 RPC 往返）
      const cacheKey = `${params.chain.chainId}:${npm.toLowerCase()}`;
      const isZia = (params.dexName || position.dex_name || "")
        .toUpperCase()
        .includes("ZIA");
      let supportsMulticall = false;
      if (!isZia) {
        if (multicallSupportCache.has(cacheKey)) {
          supportsMulticall = multicallSupportCache.get(cacheKey)!;
        } else {
          supportsMulticall = await checkMulticallSupport(
            npm,
            tokenId,
            liq,
            recipient
          );
          multicallSupportCache.set(cacheKey, supportsMulticall);
        }
      }

      if (supportsMulticall) {
        setStep("2/2 · 合并撤池 + 领币 (multicall)…");
        const removeTx = buildRemoveLiquidityCalldata(
          npm,
          tokenId,
          liq,
          recipient
        );
        const h2 = await wallet.sendTx({ ...removeTx, gas: 400000n });
        setTxHashes((prev) => [...prev, h2]);
        setStep("等待撤池确认…");
        await waitForTxReceipt(h2, 45_000);
      } else {
        // ZIA DEX 等无 multicall 的 NPM：先 decreaseLiquidity，确认后立即自动弹 collect
        if (liq > 0n) {
          setStep(
            isStaked ? "2/3 · 移除全部流动性…" : "1/2 · 移除全部流动性…"
          );
          const decTx = buildDecreaseLiquidityCalldata(npm, tokenId, liq);
          const h2 = await wallet.sendTx({ ...decTx, gas: 280000n });
          setTxHashes((prev) => [...prev, h2]);
          setStep("等待移除确认…");
          await waitForTxReceipt(h2, 45_000);
        }

        setStep(
          isStaked ? "3/3 · 提取本金与手续费…" : "2/2 · 提取本金与手续费…"
        );
        const colTx = buildCollectCalldata(npm, tokenId, recipient);
        const h3 = await wallet.sendTx({ ...colTx, gas: 250000n });
        setTxHashes((prev) => [...prev, h3]);
        setStep("等待提取确认…");
        await waitForTxReceipt(h3, 45_000);
      }

      // 7. 通知后端立即将该仓位标记为已关闭，界面秒级刷新
      await fetch(`/api/positions/${position.id}/remove-params`, {
        method: "POST",
        headers: authHeaders(),
      });

      const pairLabel =
        position.pair_flip === 1
          ? `${position.token1_symbol}/${position.token0_symbol}`
          : `${position.token0_symbol}/${position.token1_symbol}`;

      toast.success(
        andReopen
          ? `#${position.token_id} (${pairLabel}) 已撤池！右侧已自动载入该池，可直接重开`
          : `#${position.token_id} (${pairLabel}) 撤池 & 领币完成！`
      );
      setStep("");
      setBusyMode("");
      onRemoved?.();
    } catch (e: any) {
      toast.error(e.message || String(e));
      setStep("");
      setBusyMode("");
    }
  }

  return (
    <div className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        onClick={() => handleQuickRemove(false)}
        disabled={!!busyMode}
        className="btn-danger btn-xs"
        title={
          isStakedPos
            ? "自动连签：解质押 → 移除流动性 → 领取本金与手续费"
            : "自动连签：移除流动性 → 领取本金与手续费"
        }
      >
        {busyMode === "remove"
          ? step || "撤池中…"
          : isStakedPos
          ? "⚡ 解押并撤池"
          : "⚡ 一键撤池"}
      </button>

      {onReopenPool && position.pool && (
        <button
          type="button"
          onClick={() => handleQuickRemove(true)}
          disabled={!!busyMode}
          className="btn-ghost btn-xs border-brand/30 text-brand-light hover:bg-brand/15 hover:border-brand/50"
          title="撤出当前越界/旧仓位，并同时在右侧建仓台载入该池，按最新 Tick 一键重开"
        >
          {busyMode === "reopen" ? step || "处理中…" : "🔄 撤池重开"}
        </button>
      )}

      {txHashes.length > 0 && (
        <span className="inline-flex items-center gap-1 font-mono text-[10px] text-ink-soft">
          {txHashes.map((h, i) =>
            explorerUrl ? (
              <a
                key={h}
                href={`${explorerUrl.replace(/\/$/, "")}/tx/${h}`}
                target="_blank"
                rel="noreferrer"
                className="text-brand-light underline"
              >
                Tx{i + 1}↗
              </a>
            ) : (
              <span key={h}>{short(h)}</span>
            )
          )}
        </span>
      )}
    </div>
  );
}
