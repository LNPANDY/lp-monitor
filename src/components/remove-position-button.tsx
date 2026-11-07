"use client";
import { useState, useMemo } from "react";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";
import {
  buildRemoveLiquidityCalldata,
  buildDecreaseLiquidityCalldata,
  buildCollectCalldata,
  buildWithdrawCalldata,
  buildIncreaseLiquidityCalldata,
  buildPartialDecreaseMulticallCalldata,
  checkMulticallSupport,
} from "@/lib/wallet/build-multicall";
import {
  buildApproveCalldata,
  buildNftApproveCalldata,
  buildStakeDepositCalldata,
  computeLiquidityFromAmount,
  amountsForLiquidity,
  tickToSqrtPriceX96,
  MAX_UINT256,
} from "@/lib/wallet/build-mint";
import { authHeaders, short, fmtFull } from "./util";
import { toast } from "./toast";

interface Position {
  id: number;
  chain_id_ref: number;
  chain_id: number;
  chain_name: string;
  chain_rpc_urls?: string;
  chain_symbol?: string;
  explorer_url?: string;
  dex_name: string;
  dex_npm?: string;
  pool: string;
  token_id: string;
  token0?: string;
  token1?: string;
  token0_symbol?: string;
  token1_symbol?: string;
  pair_flip?: number;
  wallet_label?: string;
  wallet_address: string;
  source: string;
  staker_contract: string;
  available_staker_contract?: string;
  available_staker_label?: string;
  last_liquidity?: string;
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

interface AdjustInitData {
  positionId: number;
  tokenId: string;
  npm: string;
  dexName: string;
  pool: string;
  chainIdRef: number;
  pairFlip: number;
  token0: {
    address: string;
    symbol: string;
    decimals: number;
    currentAmount: string;
    walletBalance: string;
    allowance: string;
  };
  token1: {
    address: string;
    symbol: string;
    decimals: number;
    currentAmount: string;
    walletBalance: string;
    allowance: string;
  };
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  sqrtPriceX96: string;
  realLiquidity: string;
  ownerOf: string;
  source: string;
  stakerContract: string;
  stakerLabel: string;
  currentlyStakedOnChain: boolean;
  nftApprovedForAll: boolean;
  singleTokenApproved: boolean;
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

function parseUnitsHuman(input: string, decimals: number): bigint {
  const s = (input || "").trim();
  if (!s || !/^\d*\.?\d*$/.test(s)) return 0n;
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt((intPart || "0") + frac);
  } catch {
    return 0n;
  }
}

function formatUnitsHuman(raw: bigint, decimals: number, maxFrac = 6): string {
  if (raw <= 0n) return "0";
  const base = 10n ** BigInt(decimals);
  const intPart = raw / base;
  const fracFull = (raw % base).toString().padStart(decimals, "0");
  const frac = fracFull.slice(0, maxFrac).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : `${intPart}`;
}

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
  const [busyMode, setBusyMode] = useState<
    "" | "remove" | "reopen" | "stake" | "adjust"
  >("");
  const [txHashes, setTxHashes] = useState<string[]>([]);
  const [explorerUrl, setExplorerUrl] = useState<string>(
    position.explorer_url || ""
  );

  // 「⚖️ 增减流动性」内联抽屉状态
  const [adjustOpen, setAdjustOpen] = useState(false);
  const [adjustLoading, setAdjustLoading] = useState(false);
  const [adjustData, setAdjustData] = useState<AdjustInitData | null>(null);
  const [adjustTab, setAdjustTab] = useState<"increase" | "decrease">(
    "increase"
  );
  const [incSide, setIncSide] = useState<"token0" | "token1">(
    position.pair_flip === 1 ? "token1" : "token0"
  );
  const [incAmount, setIncAmount] = useState("");
  const [decPct, setDecPct] = useState<string>("50");
  const [autoRestake, setAutoRestake] = useState(true);

  const isStakedPos =
    position.source === "staking" && !!position.staker_contract;
  const matchedStaker =
    position.staker_contract || position.available_staker_contract || "";

  /** 确保钱包已连接且处于仓位所属链与持有人账户 */
  async function ensureWalletAndChain(chainInfo: {
    chainId: number;
    name: string;
    rpcUrls: string[];
    explorerUrl: string;
    nativeSymbol: string;
  }): Promise<`0x${string}`> {
    let addr = wallet.address;
    if (!addr) {
      setStep("连接钱包…");
      addr = await wallet.connect();
      if (!addr) throw new Error("未连接钱包");
    }
    if (addr.toLowerCase() !== position.wallet_address.toLowerCase()) {
      throw new Error(
        `请切换钱包至仓位持有人 ${short(
          position.wallet_address
        )}（当前连接 ${short(addr)}）`
      );
    }
    if (wallet.chainId !== chainInfo.chainId) {
      setStep(`切换到 ${chainInfo.name}…`);
      await wallet.switchChain(chainInfo.chainId, {
        chainName: chainInfo.name,
        nativeCurrency: {
          name: chainInfo.nativeSymbol || "ETH",
          symbol: chainInfo.nativeSymbol || "ETH",
          decimals: 18,
        },
        rpcUrls: chainInfo.rpcUrls,
        blockExplorerUrls: chainInfo.explorerUrl
          ? [chainInfo.explorerUrl]
          : undefined,
      });
    }
    return addr as `0x${string}`;
  }

  /**
   * 针对未质押仓位（或中断后留在钱包的仓位）：一键质押到已配置的质押合约
   */
  async function handleDirectStake(customStaker?: string) {
    const targetStaker = customStaker || matchedStaker;
    if (!targetStaker) {
      toast.error("未找到匹配的质押合约，请先在配置页添加");
      return;
    }
    setBusyMode("stake");
    setTxHashes([]);
    setStep("准备质押…");
    try {
      // 1. 拉取或复用链与授权状态
      let info = adjustData;
      if (!info) {
        const q = wallet.address
          ? `?wallet=${encodeURIComponent(wallet.address)}`
          : "";
        const r = await fetch(`/api/positions/${position.id}/adjust${q}`, {
          headers: authHeaders(),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "读取仓位状态失败");
        info = j.data as AdjustInitData;
        setAdjustData(info);
      }
      setExplorerUrl(info.chain.explorerUrl || "");

      if (info.currentlyStakedOnChain) {
        await fetch(`/api/positions/${position.id}/adjust`, {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ stakerContract: targetStaker }),
        });
        toast.success(`#${position.token_id} 已在质押合约中，状态已同步`);
        setStep("");
        setBusyMode("");
        onRemoved?.();
        return;
      }

      await ensureWalletAndChain(info.chain);
      const tokenIdBig = BigInt(info.tokenId);

      // 2. 若未开启全局免签且当前 tokenId 未单次授权，先授权 NFT
      if (!info.nftApprovedForAll && !info.singleTokenApproved) {
        setStep(`1/2 · 授权 NFT #${info.tokenId}…`);
        const appTx = buildNftApproveCalldata(
          info.npm,
          targetStaker,
          tokenIdBig
        );
        const h1 = await wallet.sendTx({ ...appTx, gas: 100000n });
        setTxHashes((prev) => [...prev, h1]);
        setStep("等待授权确认…");
        await waitForTxReceipt(h1, 25_000);
      }

      // 3. 调用 staker.deposit(tokenId)
      setStep(
        info.nftApprovedForAll || info.singleTokenApproved
          ? `1/1 · 质押 #${info.tokenId}…`
          : `2/2 · 质押 #${info.tokenId}…`
      );
      const depTx = buildStakeDepositCalldata(targetStaker, tokenIdBig);
      const h2 = await wallet.sendTx({ ...depTx, gas: 350000n });
      setTxHashes((prev) => [...prev, h2]);
      setStep("等待质押确认…");
      await waitForTxReceipt(h2, 35_000);

      // 4. 同步数据库
      await fetch(`/api/positions/${position.id}/adjust`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ stakerContract: targetStaker }),
      });

      toast.success(`#${position.token_id} 质押成功！`);
      setStep("");
      setBusyMode("");
      if (adjustOpen) {
        loadAdjustData();
      }
      onRemoved?.();
    } catch (e: any) {
      toast.error(e?.message || String(e));
      setStep("");
      setBusyMode("");
    }
  }

  /** 展开/刷新「⚖️ 增减流动性」面板数据 */
  async function loadAdjustData() {
    setAdjustLoading(true);
    try {
      const q = wallet.address
        ? `?wallet=${encodeURIComponent(wallet.address)}`
        : "";
      const r = await fetch(`/api/positions/${position.id}/adjust${q}`, {
        headers: authHeaders(),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "读取仓位参数失败");
      const d = j.data as AdjustInitData;
      setAdjustData(d);
      setExplorerUrl(d.chain.explorerUrl || "");
      setIncSide(d.pairFlip === 1 ? "token1" : "token0");
      setAutoRestake(Boolean(d.stakerContract));
    } catch (e: any) {
      toast.error(e?.message || String(e));
    } finally {
      setAdjustLoading(false);
    }
  }

  function toggleAdjustDrawer() {
    if (adjustOpen) {
      setAdjustOpen(false);
      return;
    }
    setAdjustOpen(true);
    loadAdjustData();
  }

  // 前端 0ms 实时计算「➕ 增加流动性」配平金额与新增 liquidity
  const increasePreview = useMemo(() => {
    if (!adjustData || !incAmount || Number(incAmount) <= 0) return null;
    const dec =
      incSide === "token0"
        ? adjustData.token0.decimals
        : adjustData.token1.decimals;
    const rawIn = parseUnitsHuman(incAmount, dec);
    if (rawIn <= 0n) return null;
    const sqrtP = BigInt(adjustData.sqrtPriceX96);
    const sqrtA = tickToSqrtPriceX96(adjustData.tickLower);
    const sqrtB = tickToSqrtPriceX96(adjustData.tickUpper);
    const { liquidity, amount0, amount1 } = computeLiquidityFromAmount(
      sqrtP,
      sqrtA,
      sqrtB,
      incSide,
      rawIn
    );
    const curLiq = BigInt(adjustData.realLiquidity || "0");
    const pctIncrease =
      curLiq > 0n ? (Number(liquidity) / Number(curLiq)) * 100 : 100;
    return {
      deltaLiquidity: liquidity,
      amount0Raw: amount0,
      amount1Raw: amount1,
      amount0Human: formatUnitsHuman(amount0, adjustData.token0.decimals, 6),
      amount1Human: formatUnitsHuman(amount1, adjustData.token1.decimals, 6),
      pctIncrease,
    };
  }, [adjustData, incAmount, incSide]);

  // 前端 0ms 实时计算「➖ 减少流动性」提取金额与剩余金额
  const decreasePreview = useMemo(() => {
    if (!adjustData) return null;
    const pctNum = Math.max(0, Math.min(99.9, Number(decPct) || 0));
    if (pctNum <= 0) return null;
    const curLiq = BigInt(adjustData.realLiquidity || "0");
    if (curLiq <= 0n) return null;
    const bps = BigInt(Math.round(pctNum * 100));
    const deltaLiq = (curLiq * bps) / 10000n;
    if (deltaLiq <= 0n) return null;
    const remainLiq = curLiq > deltaLiq ? curLiq - deltaLiq : 0n;

    const sqrtP = BigInt(adjustData.sqrtPriceX96);
    const sqrtA = tickToSqrtPriceX96(adjustData.tickLower);
    const sqrtB = tickToSqrtPriceX96(adjustData.tickUpper);
    const ext = amountsForLiquidity(sqrtP, sqrtA, sqrtB, deltaLiq);
    const rem = amountsForLiquidity(sqrtP, sqrtA, sqrtB, remainLiq);

    return {
      pctNum,
      deltaLiquidity: deltaLiq,
      remainLiquidity: remainLiq,
      extract0Human: formatUnitsHuman(
        ext.amount0,
        adjustData.token0.decimals,
        6
      ),
      extract1Human: formatUnitsHuman(
        ext.amount1,
        adjustData.token1.decimals,
        6
      ),
      remain0Human: formatUnitsHuman(
        rem.amount0,
        adjustData.token0.decimals,
        6
      ),
      remain1Human: formatUnitsHuman(
        rem.amount1,
        adjustData.token1.decimals,
        6
      ),
    };
  }, [adjustData, decPct]);

  /**
   * 执行「解质押（如在质押中）→ 增加/减少流动性 → 重新质押」完整流水线
   */
  async function handleExecuteAdjust() {
    if (!adjustData) return;
    setBusyMode("adjust");
    setTxHashes([]);

    try {
      const recipient = await ensureWalletAndChain(adjustData.chain);
      const tokenIdBig = BigInt(adjustData.tokenId);
      const npm = adjustData.npm as `0x${string}`;
      const staker = adjustData.stakerContract;
      const needUnstake = adjustData.currentlyStakedOnChain && !!staker;
      const needRestake = Boolean(staker && (adjustData.currentlyStakedOnChain || autoRestake));

      if (adjustTab === "increase") {
        if (!increasePreview || increasePreview.deltaLiquidity <= 0n) {
          throw new Error("请输入有效的加仓数量（若价格已越界，请输入单边所需币种）");
        }
        const need0 = increasePreview.amount0Raw;
        const need1 = increasePreview.amount1Raw;
        const allow0 = BigInt(adjustData.token0.allowance || "0");
        const allow1 = BigInt(adjustData.token1.allowance || "0");

        // Step 1: 若当前链上处于质押中，先解质押（若上次已解押在钱包，自动跳过！）
        if (needUnstake) {
          setStep(`1 · 解质押 #${adjustData.tokenId}…`);
          const wData = buildWithdrawCalldata(tokenIdBig);
          const hw = await wallet.sendTx({
            to: staker,
            data: wData,
            gas: 280000n,
          });
          setTxHashes((prev) => [...prev, hw]);
          setStep("等待解质押确认…");
          await waitForTxReceipt(hw, 35_000);
        }

        // Step 2: 检查并补充 ERC20 授权
        if (need0 > 0n && allow0 < need0) {
          setStep(`授权 ${adjustData.token0.symbol}…`);
          const a0 = buildApproveCalldata(
            adjustData.token0.address,
            npm,
            MAX_UINT256
          );
          const h0 = await wallet.sendTx({ ...a0, gas: 80000n });
          setTxHashes((prev) => [...prev, h0]);
          await waitForTxReceipt(h0, 20_000);
        }
        if (need1 > 0n && allow1 < need1) {
          setStep(`授权 ${adjustData.token1.symbol}…`);
          const a1 = buildApproveCalldata(
            adjustData.token1.address,
            npm,
            MAX_UINT256
          );
          const h1 = await wallet.sendTx({ ...a1, gas: 80000n });
          setTxHashes((prev) => [...prev, h1]);
          await waitForTxReceipt(h1, 20_000);
        }

        // Step 3: 调用 NPM.increaseLiquidity
        setStep(`2 · 增加流动性 #${adjustData.tokenId}…`);
        const incTx = buildIncreaseLiquidityCalldata(npm, {
          tokenId: tokenIdBig,
          amount0Desired: need0,
          amount1Desired: need1,
          slippagePct: 0.5,
        });
        const hi = await wallet.sendTx({ ...incTx, gas: 380000n });
        setTxHashes((prev) => [...prev, hi]);
        setStep("等待加仓确认…");
        await waitForTxReceipt(hi, 35_000);

        // Step 4: 重新质押回 Staker（保证质押合约按新流动性重新计息）
        if (needRestake && staker) {
          if (!adjustData.nftApprovedForAll) {
            setStep(`3 · 授权 NFT #${adjustData.tokenId}…`);
            const appNft = buildNftApproveCalldata(npm, staker, tokenIdBig);
            const ha = await wallet.sendTx({ ...appNft, gas: 100000n });
            setTxHashes((prev) => [...prev, ha]);
            await waitForTxReceipt(ha, 20_000);
          }
          setStep(`3 · 重新质押 #${adjustData.tokenId}…`);
          const depTx = buildStakeDepositCalldata(staker, tokenIdBig);
          const hd = await wallet.sendTx({ ...depTx, gas: 350000n });
          setTxHashes((prev) => [...prev, hd]);
          setStep("等待重新质押确认…");
          await waitForTxReceipt(hd, 35_000);
        }
      } else {
        // ==================== ➖ 减少部分流动性 ====================
        if (!decreasePreview || decreasePreview.deltaLiquidity <= 0n) {
          throw new Error("请选择或输入有效的减仓比例（1%~99%）");
        }
        const deltaLiq = decreasePreview.deltaLiquidity;

        // Step 1: 若链上处于质押中，先解质押
        if (needUnstake) {
          setStep(`1 · 解质押 #${adjustData.tokenId}…`);
          const wData = buildWithdrawCalldata(tokenIdBig);
          const hw = await wallet.sendTx({
            to: staker,
            data: wData,
            gas: 280000n,
          });
          setTxHashes((prev) => [...prev, hw]);
          setStep("等待解质押确认…");
          await waitForTxReceipt(hw, 35_000);
        }

        // Step 2: 减少部分流动性 + 领取本金与累积手续费（不销毁 NFT）
        const isZia = (adjustData.dexName || position.dex_name || "")
          .toUpperCase()
          .includes("ZIA");
        if (!isZia) {
          setStep(`2 · 减仓 ${decreasePreview.pctNum}% 并领币…`);
          const mcTx = buildPartialDecreaseMulticallCalldata(
            npm,
            tokenIdBig,
            deltaLiq,
            recipient
          );
          const hm = await wallet.sendTx({ ...mcTx, gas: 380000n });
          setTxHashes((prev) => [...prev, hm]);
          setStep("等待减仓确认…");
          await waitForTxReceipt(hm, 35_000);
        } else {
          setStep(`2/4 · 减少 ${decreasePreview.pctNum}% 流动性…`);
          const decTx = buildDecreaseLiquidityCalldata(
            npm,
            tokenIdBig,
            deltaLiq
          );
          const hd1 = await wallet.sendTx({ ...decTx, gas: 280000n });
          setTxHashes((prev) => [...prev, hd1]);
          setStep("等待减仓确认…");
          await waitForTxReceipt(hd1, 35_000);

          setStep(`3/4 · 提取本金与手续费到钱包…`);
          const colTx = buildCollectCalldata(npm, tokenIdBig, recipient);
          const hc = await wallet.sendTx({ ...colTx, gas: 250000n });
          setTxHashes((prev) => [...prev, hc]);
          setStep("等待提取确认…");
          await waitForTxReceipt(hc, 35_000);
        }

        // Step 3: 将剩余流动性的 NFT 重新质押回 Staker
        if (needRestake && staker) {
          if (!adjustData.nftApprovedForAll) {
            setStep(`授权 NFT #${adjustData.tokenId}…`);
            const appNft = buildNftApproveCalldata(npm, staker, tokenIdBig);
            const ha = await wallet.sendTx({ ...appNft, gas: 100000n });
            setTxHashes((prev) => [...prev, ha]);
            await waitForTxReceipt(ha, 20_000);
          }
          setStep(`重新质押 #${adjustData.tokenId}…`);
          const depTx = buildStakeDepositCalldata(staker, tokenIdBig);
          const hd2 = await wallet.sendTx({ ...depTx, gas: 350000n });
          setTxHashes((prev) => [...prev, hd2]);
          setStep("等待重新质押确认…");
          await waitForTxReceipt(hd2, 35_000);
        }
      }

      // 同步数据库最新流动性与质押状态
      await fetch(`/api/positions/${position.id}/adjust`, {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ stakerContract: staker }),
      });

      toast.success(
        adjustTab === "increase"
          ? `#${position.token_id} 加仓${needRestake ? "并重新质押" : ""}完成！`
          : `#${position.token_id} 减仓提取${needRestake ? "并重新质押" : ""}完成！`
      );
      setIncAmount("");
      setStep("");
      setBusyMode("");
      await loadAdjustData();
      onRemoved?.();
    } catch (e: any) {
      toast.error(e?.message || String(e));
      setStep("");
      setBusyMode("");
      // 若中途取消（如已解质押但未完成后续步骤），刷新一次链上 ownerOf 以便下次断点续签
      loadAdjustData();
      onRemoved?.();
    }
  }

  /**
   * 一键执行「解质押（如质押中）→ 撤池 → 领币」完整流水线，无需二次点击确认。
   * 若 andReopen=true，同时将该池子载入右侧建仓面板以便立即按新区间重开。
   */
  async function handleQuickRemove(andReopen: boolean) {
    setBusyMode(andReopen ? "reopen" : "remove");
    setTxHashes([]);

    try {
      // 若点了「撤池重开」，立刻先把左侧建仓面板切到当前池子，零延迟并发准备
      if (andReopen && onReopenPool && position.chain_id_ref && position.pool) {
        onReopenPool(position.chain_id_ref, position.pool);
      }

      // 1. 优先复用列表已缓存的 NPM 与 liquidity（0ms 直弹钱包，省去 ~1.1s 后端 RPC 查询）
      const cachedLiq = (() => {
        try {
          return BigInt(position.last_liquidity || "0");
        } catch {
          return 0n;
        }
      })();

      let params: RemoveParams;
      if (position.dex_npm && cachedLiq > 0n) {
        let parsedRpcUrls: string[] = [];
        try {
          parsedRpcUrls = position.chain_rpc_urls
            ? JSON.parse(position.chain_rpc_urls)
            : [];
        } catch {
          parsedRpcUrls = [];
        }
        params = {
          tokenId: position.token_id,
          npm: position.dex_npm,
          dexName: position.dex_name,
          pool: position.pool,
          chainIdRef: position.chain_id_ref,
          pairFlip: position.pair_flip ?? 0,
          stakerContract: position.staker_contract || "",
          source: position.source || "direct",
          liquidity: position.last_liquidity || "0",
          realLiquidity: position.last_liquidity || "0",
          ownerOf: position.wallet_address,
          chain: {
            chainId: position.chain_id,
            name: position.chain_name,
            rpcUrls: parsedRpcUrls,
            explorerUrl: position.explorer_url || "",
            nativeSymbol: position.chain_symbol || "ETH",
          },
        };
      } else {
        setStep("读取链上流动性…");
        const r = await fetch(`/api/positions/${position.id}/remove-params`, {
          headers: authHeaders(),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error || "获取撤池参数失败");
        params = j.data;
      }
      setExplorerUrl(params.chain?.explorerUrl || "");

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

      const recipient = await ensureWalletAndChain(params.chain);
      const tokenId = BigInt(params.tokenId);
      const npm = params.npm as `0x${string}`;

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
          ? `#${position.token_id} (${pairLabel}) 已撤池！左侧已自动载入该池，可直接重开`
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

  const ownerTag = position.wallet_label
    ? `${position.wallet_label} (${short(position.wallet_address)})`
    : short(position.wallet_address);
  const isWrongWallet =
    !!wallet.address &&
    !!position.wallet_address &&
    wallet.address.toLowerCase() !== position.wallet_address.toLowerCase();

  // 按翻转状态排布主币/计价币
  const isFlipped = (adjustData?.pairFlip ?? position.pair_flip) === 1;
  const primaryToken = adjustData
    ? isFlipped
      ? adjustData.token1
      : adjustData.token0
    : null;
  const secondaryToken = adjustData
    ? isFlipped
      ? adjustData.token0
      : adjustData.token1
    : null;

  return (
    <div className="mt-2.5 border-t border-white/[0.08] pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        {/* 1. 未质押但已配置对应质押合约时，显示「🔒 一键质押」按钮 */}
        {!isStakedPos && matchedStaker && (
          <button
            type="button"
            onClick={() => handleDirectStake(matchedStaker)}
            disabled={!!busyMode || isWrongWallet}
            className="btn-primary text-xs"
            title={
              position.available_staker_label
                ? `一键质押到已配置的质押合约：${position.available_staker_label} (${short(matchedStaker)})`
                : `一键质押到质押合约 ${short(matchedStaker)}`
            }
          >
            {busyMode === "stake" ? step || "质押中…" : "🔒 一键质押"}
          </button>
        )}

        {/* 2. ⚖️ 增减流动性按钮 */}
        <button
          type="button"
          onClick={toggleAdjustDrawer}
          disabled={!!busyMode || isWrongWallet}
          className={`text-xs ${
            adjustOpen ? "btn-primary" : "btn-secondary"
          }`}
          title="保持原区间不变，解质押 → 增加/减少流动性 → 自动重新质押"
        >
          {busyMode === "adjust"
            ? step || "处理中…"
            : adjustOpen
              ? "▾ 收起增减"
              : "⚖️ 增减流动性"}
        </button>

        {/* 3. 移除仓位按钮 */}
        <button
          type="button"
          onClick={() => handleQuickRemove(false)}
          disabled={!!busyMode || isWrongWallet}
          className="btn-danger text-xs"
          title={
            isWrongWallet
              ? `当前连接钱包 (${short(wallet.address!)}) 与${isStakedPos ? "质押" : "持仓"}钱包 (${ownerTag}) 不一致，请先在钱包插件中切换账户`
              : isStakedPos
                ? "自动连签：解质押 → 移除流动性 → 领取本金与手续费"
                : "自动连签：移除流动性 → 领取本金与手续费"
          }
        >
          {busyMode === "remove"
            ? step || "撤池中…"
            : isStakedPos
              ? "🔴 解押并移除"
              : "🔴 移除仓位"}
        </button>

        {/* 4. 撤池并重开按钮 */}
        {onReopenPool && position.pool && (
          <button
            type="button"
            onClick={() => handleQuickRemove(true)}
            disabled={!!busyMode || isWrongWallet}
            className="btn-secondary text-xs"
            title={
              isWrongWallet
                ? `请先切换钱包至 ${ownerTag} 后再执行撤池重开`
                : "撤出当前越界/旧仓位，并同时在左侧三段式工作台载入该池，按最新 Tick 一键重开"
            }
          >
            {busyMode === "reopen" ? step || "处理中…" : "🔄 撤池并重开"}
          </button>
        )}

        {isWrongWallet && (
          <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-200">
            ⚠️ 需切至 {ownerTag}
          </span>
        )}

        {txHashes.length > 0 && (
          <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-soft">
            {txHashes.map((h, i) =>
              explorerUrl ? (
                <a
                  key={h}
                  href={`${explorerUrl.replace(/\/$/, "")}/tx/${h}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-cyan-300 underline"
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

      {/* ==================== ⚖️ 增减流动性内联操作抽屉 ==================== */}
      {adjustOpen && (
        <div className="mt-2.5 rounded-lg border border-cyan-500/30 bg-surface-raised p-3 text-xs space-y-2.5">
          {adjustLoading && !adjustData ? (
            <div className="text-ink-soft py-2">
              正在读取链上仓位流动性与双币余额…
            </div>
          ) : adjustData ? (
            <>
              {/* 断点续签提示：若 NFT 已解质押在钱包但配置了质押合约 */}
              {!adjustData.currentlyStakedOnChain &&
                adjustData.stakerContract && (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-200">
                    <span>
                      💡 当前 NFT #{adjustData.tokenId} 在您的钱包中（未质押），执行增减时将跳过解质押并在完成后自动质押。
                    </span>
                    <button
                      type="button"
                      className="rounded bg-amber-500/25 px-2 py-0.5 font-semibold text-amber-100 hover:bg-amber-500/40"
                      disabled={!!busyMode}
                      onClick={() =>
                        handleDirectStake(adjustData.stakerContract)
                      }
                    >
                      🔒 仅质押回合约
                    </button>
                  </div>
                )}

              {/* 当前仓位持仓概览 */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded bg-black/25 px-2.5 py-1.5 text-[11px]">
                <span className="text-ink-soft">当前仓位资产：</span>
                <span className="font-mono font-medium text-ink">
                  {fmtFull(Number(primaryToken?.currentAmount || 0))}{" "}
                  {primaryToken?.symbol} +{" "}
                  {fmtFull(Number(secondaryToken?.currentAmount || 0))}{" "}
                  {secondaryToken?.symbol}
                </span>
              </div>

              {/* Tab 切换：➕ 增加流动性 / ➖ 减少流动性 */}
              <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-black/30 p-1">
                <button
                  type="button"
                  onClick={() => setAdjustTab("increase")}
                  className={`rounded-md py-1.5 text-xs font-medium transition ${
                    adjustTab === "increase"
                      ? "bg-cyan-500/25 text-cyan-200 border border-cyan-500/40"
                      : "text-ink-soft hover:text-ink"
                  }`}
                >
                  ➕ 增加流动性 (加仓)
                </button>
                <button
                  type="button"
                  onClick={() => setAdjustTab("decrease")}
                  className={`rounded-md py-1.5 text-xs font-medium transition ${
                    adjustTab === "decrease"
                      ? "bg-amber-500/25 text-amber-200 border border-amber-500/40"
                      : "text-ink-soft hover:text-ink"
                  }`}
                >
                  ➖ 减少流动性 (减仓)
                </button>
              </div>

              {adjustTab === "increase" ? (
                <div className="space-y-2">
                  {/* 选择输入币种 + 快捷余额比例 */}
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-1.5">
                      <span className="text-ink-soft">追加币种：</span>
                      {(
                        [
                          isFlipped ? "token1" : "token0",
                          isFlipped ? "token0" : "token1",
                        ] as const
                      ).map((s) => {
                        const tk =
                          s === "token0"
                            ? adjustData.token0
                            : adjustData.token1;
                        return (
                          <button
                            key={s}
                            type="button"
                            onClick={() => setIncSide(s)}
                            className={`rounded px-2 py-0.5 text-xs font-medium ${
                              incSide === s
                                ? "bg-cyan-500/30 text-cyan-200 border border-cyan-500/40"
                                : "bg-white/[0.06] text-ink-soft hover:text-ink"
                            }`}
                          >
                            {tk.symbol}
                          </button>
                        );
                      })}
                    </div>

                    {(() => {
                      const activeTk =
                        incSide === "token0"
                          ? adjustData.token0
                          : adjustData.token1;
                      const balRaw = BigInt(activeTk.walletBalance || "0");
                      const balHuman = formatUnitsHuman(
                        balRaw,
                        activeTk.decimals,
                        4
                      );
                      return (
                        <div className="flex items-center gap-1 text-[11px] text-ink-soft">
                          <span>
                            余额: <b className="font-mono text-ink">{balHuman}</b>
                          </span>
                          {[25, 50, 100].map((pct) => (
                            <button
                              key={pct}
                              type="button"
                              onClick={() => {
                                const part = (balRaw * BigInt(pct)) / 100n;
                                setIncAmount(
                                  formatUnitsHuman(part, activeTk.decimals, 6)
                                );
                              }}
                              className="rounded bg-white/[0.07] px-1.5 py-0.5 text-[10px] text-cyan-300 hover:bg-white/[0.14]"
                            >
                              {pct === 100 ? "Max" : `${pct}%`}
                            </button>
                          ))}
                        </div>
                      );
                    })()}
                  </div>

                  <input
                    type="text"
                    inputMode="decimal"
                    value={incAmount}
                    onChange={(e) => setIncAmount(e.target.value)}
                    placeholder={`输入追加的 ${
                      incSide === "token0"
                        ? adjustData.token0.symbol
                        : adjustData.token1.symbol
                    } 数量…`}
                    className="input w-full font-mono text-xs"
                  />

                  {increasePreview && (
                    <div className="rounded bg-black/25 p-2 space-y-1 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-ink-soft">本次追加双币配比：</span>
                        <span className="font-mono font-semibold text-cyan-200">
                          +{" "}
                          {isFlipped
                            ? `${increasePreview.amount1Human} ${adjustData.token1.symbol} + ${increasePreview.amount0Human} ${adjustData.token0.symbol}`
                            : `${increasePreview.amount0Human} ${adjustData.token0.symbol} + ${increasePreview.amount1Human} ${adjustData.token1.symbol}`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-soft">流动性增幅：</span>
                        <span className="font-mono text-ok">
                          +{increasePreview.pctIncrease.toFixed(2)}%
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-ink-soft">选择减仓比例：</span>
                    <div className="flex items-center gap-1.5">
                      {["25", "50", "75"].map((p) => (
                        <button
                          key={p}
                          type="button"
                          onClick={() => setDecPct(p)}
                          className={`rounded px-2.5 py-0.5 text-xs font-mono ${
                            decPct === p
                              ? "bg-amber-500/30 text-amber-200 border border-amber-500/40"
                              : "bg-white/[0.07] text-ink-soft hover:text-ink"
                          }`}
                        >
                          {p}%
                        </button>
                      ))}
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          min={1}
                          max={99}
                          value={decPct}
                          onChange={(e) => setDecPct(e.target.value)}
                          className="input w-16 py-0.5 px-1.5 text-right font-mono text-xs"
                        />
                        <span className="text-ink-soft">%</span>
                      </div>
                    </div>
                  </div>

                  {decreasePreview && (
                    <div className="rounded bg-black/25 p-2 space-y-1 text-[11px]">
                      <div className="flex justify-between">
                        <span className="text-ink-soft">
                          预计提取到手（+全部未领手续费）：
                        </span>
                        <span className="font-mono font-semibold text-amber-200">
                          {isFlipped
                            ? `${decreasePreview.extract1Human} ${adjustData.token1.symbol} + ${decreasePreview.extract0Human} ${adjustData.token0.symbol}`
                            : `${decreasePreview.extract0Human} ${adjustData.token0.symbol} + ${decreasePreview.extract1Human} ${adjustData.token1.symbol}`}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-ink-soft">减仓后剩余仓位：</span>
                        <span className="font-mono text-ink">
                          {isFlipped
                            ? `${decreasePreview.remain1Human} ${adjustData.token1.symbol} + ${decreasePreview.remain0Human} ${adjustData.token0.symbol}`
                            : `${decreasePreview.remain0Human} ${adjustData.token0.symbol} + ${decreasePreview.remain1Human} ${adjustData.token1.symbol}`}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* 底部执行按钮与自动质押勾选 */}
              <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                {adjustData.stakerContract ? (
                  <label className="flex items-center gap-1.5 text-[11px] text-ink-soft cursor-pointer">
                    <input
                      type="checkbox"
                      checked={autoRestake}
                      onChange={(e) => setAutoRestake(e.target.checked)}
                    />
                    <span>
                      完成后自动质押回 {adjustData.stakerLabel || "质押合约"}
                      {adjustData.nftApprovedForAll ? " (已免签授权)" : ""}
                    </span>
                  </label>
                ) : (
                  <span className="text-[11px] text-ink-muted">
                    直持仓位（直接修改流动性）
                  </span>
                )}

                <button
                  type="button"
                  disabled={!!busyMode}
                  onClick={handleExecuteAdjust}
                  className="btn-primary text-xs px-3 py-1.5"
                >
                  {busyMode === "adjust"
                    ? step || "执行中…"
                    : adjustTab === "increase"
                      ? adjustData.currentlyStakedOnChain
                        ? "⚡ 解押 → 加仓 → 重新质押"
                        : adjustData.stakerContract && autoRestake
                          ? "⚡ 加仓并质押"
                          : "⚡ 立即加仓"
                      : adjustData.currentlyStakedOnChain
                        ? "⚡ 解押 → 减仓领币 → 重新质押"
                        : adjustData.stakerContract && autoRestake
                          ? "⚡ 减仓领币并质押"
                          : "⚡ 立即减仓领币"}
                </button>
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
