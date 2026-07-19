"use client";
import { useState } from "react";
import { useWallet } from "@/lib/wallet/use-wallet";
import { buildRemoveLiquidityCalldata, buildWithdrawCalldata } from "@/lib/wallet/build-multicall";
import { detectWalletName } from "@/lib/wallet/provider";
import { NPM_WRITE_ABI } from "@/lib/wallet/write-abi";
import { encodeFunctionData } from "viem";

interface Position {
  id: number;
  token_id: string;
  source: string;
  token0_symbol?: string;
  token1_symbol?: string;
}

interface RemoveParams {
  tokenId: string;
  npm: string;
  stakerContract: string;
  source: string;
  liquidity: string;
  realLiquidity: string;  // 链上实时 liquidity
  ownerOf: string;
  chain: {
    chainId: number;
    name: string;
    rpcUrls: string[];
    explorerUrl: string;
    nativeSymbol: string;
  };
}

interface RetryState {
  step1: boolean;
  step2: boolean;
}

type StepStatus = "idle" | "loading" | "done" | "error";

interface StepState {
  status: StepStatus;
  txHash?: string;
  error?: string;
}

const explorerTx = (explorerUrl: string, txHash: string) =>
  `${explorerUrl.replace(/\/$/, "")}/tx/${txHash}`;

/**
 * 嵌入仓位卡片的「移除仓位」按钮。
 *
 * 质押仓位（source=staking）：两步
 *   Step1: staker.withdraw(tokenId) → 拿 txHash 后立即触发 Step2（不等确认）
 *   Step2: NPM.multicall([decreaseLiquidity, collect, burn])
 *
 * 直接持有仓位（source=direct）：仅 Step2
 *
 * 全部写交易由用户在钱包里手动确认。
 */
export function RemovePositionButton({ position }: { position: Position }) {
  const { address, chainId, connect, switchChain, sendTx, status: walletStatus } = useWallet();
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [params, setParams] = useState<RemoveParams | null>(null);
  const [loadingParams, setLoadingParams] = useState(false);
  const [step1, setStep1] = useState<StepState>({ status: "idle" });
  const [step2, setStep2] = useState<StepState>({ status: "idle" });
  const [globalError, setGlobalError] = useState("");
  const [retryState, setRetryState] = useState<RetryState>({ step1: false, step2: false });

  const isStaking = position.source === "staking";
  const pairLabel = `${position.token0_symbol ?? ""}/${position.token1_symbol ?? ""}`;

  /** 打开移除确认面板，预取链上参数。 */
  async function openRemove() {
    setOpen(true);
    setGlobalError("");
    setStep1({ status: "idle" });
    setStep2({ status: "idle" });
    setParams(null);
    setLoadingParams(true);
    try {
      const r = await fetch(`/api/positions/${position.id}/remove-params`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "获取参数失败");
      setParams(j.data as RemoveParams);
    } catch (e: any) {
      setGlobalError(e.message);
    } finally {
      setLoadingParams(false);
    }
  }

  /** 执行移除（三步或单步）。 */
  async function executeRemove() {
    if (!params) return;
    setConfirming(true);
    setGlobalError("");
    try {
      // 0. 确保钱包已连接
      if (!address) {
        await connect();
      }
      // connect() 是异步更新状态的，这里用最新 address 需重新读取
      // （useWallet 返回的 address 在本作用域是闭包旧值，改为依赖 provider）
      const walletAddr = await getCurrentAddress();
      if (!walletAddr) {
        setGlobalError("钱包未连接");
        return;
      }

      // 1. ownerOf 校验：NFT owner 必须是 stakerContract（还在质押）或当前钱包（已取回/直持）
      //    其他 owner 说明 NFT 已被转移给第三方，禁止移除
      console.log("Owner validation:", {
        ownerOf: params.ownerOf,
        stakerContract: params.stakerContract,
        walletAddr: walletAddr,
        liquidity: params.liquidity
      });
      
      const ownerLower = params.ownerOf?.toLowerCase() ?? "";
      const walletLower = walletAddr.toLowerCase();
      const stakerLower = params.stakerContract?.toLowerCase() ?? "";
      const ownerIsStaker = ownerLower && ownerLower === stakerLower;
      const ownerIsWallet = ownerLower && ownerLower === walletLower;
      
      if (ownerLower && !ownerIsStaker && !ownerIsWallet) {
        setGlobalError(
          `NFT 当前归属(${params.ownerOf!.slice(0, 10)}…)既非质押合约也非当前钱包，可能已被转移`
        );
        return;
      }
      
      if (!ownerLower && !params.liquidity) {
        setGlobalError("该仓位无流动性数据或 NFT 已不存在，无法移除");
        return;
      }
      
      if (ownerLower && !ownerIsStaker && !ownerIsWallet) {
        setGlobalError(
          `NFT 归属异常：${params.ownerOf!.slice(0, 10)}… (预期: ${walletAddr.slice(0, 10)}… 或 ${params.stakerContract?.slice(0, 10)}…)`
        );
        return;
      }

      // 2. 切链（如不在目标链）
      if (chainId !== params.chain.chainId) {
        await switchChain(params.chain.chainId, {
          chainName: params.chain.name,
          nativeCurrency: {
            name: params.chain.nativeSymbol,
            symbol: params.chain.nativeSymbol,
            decimals: 18,
          },
          rpcUrls: params.chain.rpcUrls,
          blockExplorerUrls: [params.chain.explorerUrl],
        });
      }

      const liquidity = BigInt(params.realLiquidity || params.liquidity || "0");
      if (liquidity <= 0n) {
        setGlobalError("该仓位流动性为 0，无需移除");
        return;
      }

      // 3. 质押仓位且 NFT 还在质押合约：Step1 withdraw
      //    若 NFT 已在钱包（ownerIsWallet），跳过 Step1 直接 Step2
      console.log("Step1 decision:", {
        isStaking,
        hasStakerContract: !!params.stakerContract,
        ownerIsStaker,
        ownerIsWallet
      });
      
      const needStep1 = isStaking && !!params.stakerContract && ownerIsStaker;
      if (needStep1) {
        setStep1({ status: "loading" });
        try {
          console.log("Executing withdraw for token", params.tokenId);
          const withdrawData = buildWithdrawCalldata(BigInt(params.tokenId));
          console.log("Withdraw calldata:", withdrawData);
          
          // 使用带重试的交易发送
          const txHash = await sendTxWithRetry(
            { to: params.stakerContract, data: withdrawData },
            "step1"
          );
          
          setStep1({ status: "done", txHash });
          // 等待 1 秒后再进行下一步
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (e: any) {
          console.error("Withdraw failed:", e);
          const isUserCancel = isUserCancellation(e);
          
          if (isUserCancel) {
            setStep1({ status: "error", error: e.message || "用户取消交易" });
            setGlobalError("用户取消了 Step1（提取LP）交易");
          } else {
            setStep1({ status: "error", error: e.message || "withdraw 失败" });
            setGlobalError(`Step1（提取LP）失败：${e.message || "交易出错"}`);
          }
          return;
        }
      } else if (isStaking && !ownerIsWallet && !ownerIsStaker) {
        // ownerOf 既不是钱包也不是质押合约（前面已拦截，这里防御性）
        setGlobalError("NFT 归属异常，无法移除");
        return;
      }

      // 4. 检测 NPM 是否支持 multicall
      const supportsMulticall = await checkMulticallSupport(params.npm);
      
      if (supportsMulticall) {
        // 支持 multicall：一步完成 decreaseLiquidity + collect + burn
        await executeStep2Multicall(params, liquidity, walletAddr);
      } else {
        // 不支持 multicall：分三步执行
        await executeStep2Separate(params, liquidity, walletAddr);
      }
    } catch (e: any) {
      setGlobalError(e?.message || "操作失败");
    } finally {
      setConfirming(false);
    }
  }

  /** 重试 Step1（提取 LP） */
  async function retryStep1() {
    if (!params) return;
    
    setStep1({ status: "loading" });
    setGlobalError("");
    try {
      console.log("Retrying withdraw for token", params.tokenId);
      const withdrawData = buildWithdrawCalldata(BigInt(params.tokenId));
      console.log("Withdraw calldata:", withdrawData);
      const txHash = await sendTxWithRetry({ to: params.stakerContract, data: withdrawData }, "step1");
      console.log("Withdraw tx hash:", txHash);
      setStep1({ status: "done", txHash });
      // 等待 1 秒后再进行下一步
      await new Promise(resolve => setTimeout(resolve, 1000));
    } catch (e: any) {
      console.error("Retry withdraw failed:", e);
      const isUserCancel = isUserCancellation(e);
      
      if (isUserCancel) {
        setStep1({ status: "error", error: e.message || "用户取消交易" });
        setGlobalError("用户取消了提取交易，可以点击重试按钮继续");
      } else {
        setStep1({ status: "error", error: e.message || "withdraw 失败" });
        setGlobalError(`Step1（提取LP）失败：${e.message || "交易出错"}`);
      }
    }
  }

  /** 重试 Step2（解除流动性） */
  async function retryStep2() {
    if (!params) return;
    
    // 重新获取钱包地址（避免闭包问题）
    const currentWalletAddr = await getCurrentAddress();
    if (!currentWalletAddr) {
      setGlobalError("钱包未连接，无法重试");
      return;
    }
    
    setStep2({ status: "loading" });
    setGlobalError("");
    
    // 检测 NPM 是否支持 multicall
    const supportsMulticall = await checkMulticallSupport(params.npm);
    
    if (supportsMulticall) {
      // 支持 multicall：一步完成 decreaseLiquidity + collect + burn
      await executeStep2Multicall(params, BigInt(params.realLiquidity || params.liquidity || "0"), currentWalletAddr);
    } else {
      // 不支持 multicall：分三步执行
      await executeStep2Separate(params, BigInt(params.realLiquidity || params.liquidity || "0"), currentWalletAddr);
    }
  }

  /** 检查 NPM 是否支持 multicall */
  async function checkMulticallSupport(npm: string): Promise<boolean> {
    try {
      // 尝试调用 multicall 函数
      const multicallData = encodeFunctionData({
        abi: NPM_WRITE_ABI,
        functionName: "multicall",
        args: [[]],
      });
      const provider = (window as any).okxwallet || (window as any).ethereum;
      if (!provider) return false;
      
      await provider.request({
        method: "eth_call",
        params: [{
          to: npm,
          data: multicallData,
        }, "latest"]
      });
      return true;
    } catch (error) {
      console.log("NPM 不支持 multicall:", error);
      return false;
    }
  }

  /** 执行 Step2：使用 multicall（decreaseLiquidity + collect + burn） */
  async function executeStep2Multicall(params: RemoveParams, liquidity: bigint, walletAddr: string) {
    setStep2({ status: "loading" });
    try {
      console.log("Executing Step2 multicall for token", params.tokenId);
      const { to, data } = buildRemoveLiquidityCalldata(
        params.npm,
        BigInt(params.tokenId),
        liquidity,
        walletAddr
      );
      console.log("Multicall params:", { to, data: data.slice(0, 100) + "..." });
      
      // 使用带重试的交易发送
      const txHash = await sendTxWithRetry({ to, data }, "step2");
      
      setStep2({ status: "done", txHash });
    } catch (e: any) {
      console.error("Step2 multicall failed:", e);
      const isUserCancel = isUserCancellation(e);
      
      if (isUserCancel) {
        setStep2({ status: "error", error: e.message || "用户取消交易" });
        setGlobalError("用户取消了 Step2（解除流动性）交易，可以点击重试按钮继续");
      } else {
        setStep2({ status: "error", error: e.message || "multicall 失败" });
        setGlobalError(`Step2（解除流动性）失败：${e.message || "交易出错"}`);
      }
    }
  }

  /** 执行 Step2 和 Step3：分步执行（decreaseLiquidity + collect） */
  async function executeStep2Separate(params: RemoveParams, liquidity: bigint, walletAddr: string) {
    setStep2({ status: "loading" });
    
    // Step 2: decreaseLiquidity
    try {
      console.log("Executing Step2 decreaseLiquidity for token", params.tokenId);
      const decreaseData = encodeFunctionData({
        abi: NPM_WRITE_ABI,
        functionName: "decreaseLiquidity",
        args: [{
          tokenId: BigInt(params.tokenId),
          liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
        }],
      });
      
      // 使用带重试的交易发送
      const txHash1 = await sendTxWithRetry({ to: params.npm, data: decreaseData }, "step2");
      console.log("Decrease liquidity tx hash:", txHash1);
      
      // 等待交易确认
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Step 3: collect
      console.log("Executing Step3 collect for token", params.tokenId);
      const collectData = encodeFunctionData({
        abi: NPM_WRITE_ABI,
        functionName: "collect",
        args: [{
          tokenId: BigInt(params.tokenId),
          recipient: walletAddr as `0x${string}`,
          amount0Max: (1n << 128n) - 1n,
          amount1Max: (1n << 128n) - 1n,
        }],
      });
      
      const txHash2 = await sendTxWithRetry({ to: params.npm, data: collectData }, "step2");
      console.log("Collect tx hash:", txHash2);
      
      setStep2({ 
        status: "done", 
        txHash: `${txHash1.substring(0, 10)}...${txHash2.substring(txHash2.length - 8)}` 
      });
    } catch (e: any) {
      console.error("Step2/3 separate failed:", e);
      const isUserCancel = isUserCancellation(e);
      
      if (isUserCancel) {
        setStep2({ status: "error", error: e.message || "用户取消交易" });
        setGlobalError("用户取消了 Step2-3（解除流动性）交易，可以点击重试按钮继续");
      } else {
        setStep2({ status: "error", error: e.message || "解除流动性失败" });
        setGlobalError(`Step2-3（解除流动性）失败：${e.message || "交易出错"}`);
      }
    }
  }

  /** 带重试功能的交易发送函数 */
  async function sendTxWithRetry(
    txConfig: { to: string; data: string },
    step: "step1" | "step2",
    maxRetries: number = 2
  ): Promise<string> {
    const walletAddr = await getCurrentAddress();
    if (!walletAddr) {
      throw new Error("钱包未连接");
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        console.log(`发送交易 (尝试 ${attempt + 1}/${maxRetries + 1}):`, txConfig.to);
        const txHash = await sendTx(txConfig);
        console.log(`交易成功: ${txHash}`);
        return txHash;
      } catch (error: any) {
        console.error(`交易失败 (尝试 ${attempt + 1}/${maxRetries + 1}):`, error);
        
        // 检查是否是用户取消
        const isUserCancel = isUserCancellation(error);
        
        if (attempt === maxRetries) {
          throw new Error(isUserCancel ? "用户取消了交易" : `交易失败: ${error.message || "未知错误"}`);
        }
        
        if (isUserCancel) {
          // 用户取消，给用户选择权
          const shouldRetry = confirm(`用户取消了交易。是否重试第 ${attempt + 1} 次？`);
          if (!shouldRetry) {
            throw new Error("用户取消了交易");
          }
        }
        
        // 等待一段时间再重试
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    
    throw new Error("交易失败，已达到最大重试次数");
  }

  /** 检查错误是否是用户取消 */
  function isUserCancellation(error: any): boolean {
    if (!error) return false;
    
    // 常见的用户取消错误信息
    const cancellationMessages = [
      "user rejected transaction",
      "user denied transaction",
      "用户拒绝交易",
      "用户取消",
      "Transaction rejected",
      "User rejected",
      "revert",
      "denied"
    ];
    
    const message = error.message || error.toString() || "";
    return cancellationMessages.some(msg => 
      message.toLowerCase().includes(msg.toLowerCase())
    );
  }

  /** 直接从 provider 读当前账户（避免闭包旧值）。 */
  async function getCurrentAddress(): Promise<string | null> {
    if (typeof window === "undefined") return null;
    const w = window as any;
    const p = w.okxwallet || w.ethereum;
    if (!p) return null;
    try {
      const accounts = (await p.request({ method: "eth_accounts" })) as string[];
      return accounts?.[0] ?? null;
    } catch {
      return null;
    }
  }

  const done = step2.status === "done";

  return (
    <div className="mt-2 border-t border-slate-200 pt-2">
      <button
        className="btn-ghost text-xs text-warn hover:text-warn"
        onClick={openRemove}
      >
        🔴 移除仓位
      </button>

      {open && (
        <div className="mt-2 rounded border border-warn/30 bg-warn/5 p-3 text-xs">
          <div className="mb-2 font-semibold">
            移除仓位 #{position.token_id}（{pairLabel}）
          </div>

          {loadingParams && <div className="text-ink-soft">读取链上参数…</div>}

          {params && (
            <div className="space-y-1.5">
              <div className="text-ink-soft">
                {isStaking ? "质押仓位，需两步操作：" : "直接持有仓位，一步解除："}
              </div>

              {/* 流程说明 */}
              <ol className="ml-4 list-decimal space-y-0.5 text-ink-soft">
                {isStaking && (
                  <li>
                    提取 LP：调用质押合约 withdraw，把 NFT 取回钱包
                    {step1.status === "done" && step1.txHash && (
                      <a
                        className="ml-1 text-ok underline"
                        href={explorerTx(params.chain.explorerUrl, step1.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ✓ 查看
                      </a>
                    )}
                  </li>
                )}
                {step2.error?.includes("不支持 multicall") ? (
                  <>
                    <li>
                      解除流动性：调用 NPM decreaseLiquidity
                      {step2.status === "done" && step2.txHash && (
                        <span className="ml-1 text-xs text-ink-soft">
                          ({step2.txHash})
                        </span>
                      )}
                    </li>
                    <li>
                      收取代币：调用 NPM collect
                      {step2.status === "done" && step2.txHash && (
                        <span className="ml-1 text-xs text-ink-soft">
                          (同上交易)
                        </span>
                      )}
                    </li>
                  </>
                ) : (
                  <li>
                    解除流动性：{step2.error?.includes("不支持 multicall") ? "NPM 分步操作" : "NPM multicall（decreaseLiquidity + collect + burn）"}
                    {step2.status === "done" && step2.txHash && params?.chain?.explorerUrl && (
                      <a
                        className="ml-1 text-ok underline"
                        href={explorerTx(params.chain.explorerUrl, step2.txHash)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        ✓ 查看
                      </a>
                    )}
                  </li>
                )}
              </ol>

              {/* 步骤进度 */}
              {(step1.status !== "idle" || step2.status !== "idle") && (
                <div className="space-y-0.5 pt-1">
                  {isStaking && (
                    <StepRow 
                      label="Step1 提取 LP" 
                      state={step1} 
                      onRetry={step1.status === "error" ? retryStep1 : undefined} 
                    />
                  )}
                  <StepRow 
                    label="Step2 解除流动性" 
                    state={step2} 
                    onRetry={step2.status === "error" ? retryStep2 : undefined} 
                  />
                </div>
              )}

              {globalError && (
                <div className="rounded bg-warn/10 p-1.5 text-warn">{globalError}</div>
              )}

              {/* 操作按钮 */}
              {!done && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    className="rounded bg-warn px-3 py-1 text-xs text-white hover:bg-warn/90 disabled:opacity-50"
                    disabled={confirming || loadingParams}
                    onClick={executeRemove}
                  >
                    {confirming
                      ? "请在钱包确认…"
                      : isStaking
                        ? "确认移除（两步）"
                        : "确认移除"}
                  </button>
                  <button
                    className="btn-ghost text-xs"
                    disabled={confirming}
                    onClick={() => setOpen(false)}
                  >
                    取消
                  </button>
                </div>
              )}

              {done && (
                <div className="flex items-center gap-2 pt-1">
                  <span className="text-ok">✓ 移除完成，代币已到账</span>
                  <button
                    className="btn-ghost text-xs"
                    onClick={() => setOpen(false)}
                  >
                    关闭
                  </button>
                </div>
              )}

              {/* 未连接钱包提示 */}
              {walletStatus !== "connected" && !confirming && (
                <div className="pt-1 text-ink-soft">
                  请先在顶栏「连接钱包」（{detectWalletName() || "OKX/MetaMask"}）
                </div>
              )}
            </div>
          )}

          {!loadingParams && !params && globalError && (
            <div className="rounded bg-warn/10 p-1.5 text-warn">{globalError}</div>
          )}
        </div>
      )}
    </div>
  );
}

function StepRow({ label, state, onRetry }: { label: string; state: StepState; onRetry?: () => void }) {
  const icon =
    state.status === "done"
      ? "✓"
      : state.status === "loading"
        ? "⏳"
        : state.status === "error"
          ? "✗"
          : "○";
  const color =
    state.status === "done"
      ? "text-ok"
      : state.status === "error"
        ? "text-warn"
        : state.status === "loading"
          ? "text-ink"
          : "text-ink-soft";
  
  return (
    <div className={`flex items-center gap-1.5 ${color}`}>
      <span>{icon}</span>
      <span>{label}</span>
      {state.status === "loading" && <span className="text-ink-soft">等待钱包确认…</span>}
      {state.status === "error" && state.error && (
        <>
          <span className="text-warn">{state.error}</span>
          {onRetry && (
            <button
              className="ml-1 rounded bg-warn/10 px-2 py-0.5 text-xs text-warn hover:bg-warn/20"
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </>
      )}
    </div>
  );
}
