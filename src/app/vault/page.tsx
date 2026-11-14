"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import {
  createPublicClient,
  encodeFunctionData,
  formatUnits,
  http,
  maxUint256,
  parseAbi,
  parseUnits,
} from "viem";
import { toast } from "@/components/toast";
import { useWallet, waitForTxReceipt } from "@/lib/wallet/use-wallet";

const X_LAYER_CHAIN_ID = 196;
const X_LAYER_RPC = "https://rpc.xlayer.tech";
const OKLINK_BASE = "https://www.oklink.com/zh-hans/x-layer";
const VAULT_ADDRESS = "0x4802f950ec247bcc9126adf8e10ea025dec3bb92" as const;
const USDC_ADDRESS = "0xb6ceceab302e2e4948951ee7843fc24e92933061" as const;
const MORPHO_ADAPTER = "0xf68fe71631fcc9c755d2085f8b77557e7e909eff" as const;
const MERKL_OPP_ID = "7282086992852997306";

const X_LAYER_CHAIN_PARAMS = {
  chainName: "X Layer Mainnet",
  nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
  rpcUrls: ["https://rpc.xlayer.tech", "https://xlayerrpc.okx.com"],
  blockExplorerUrls: [OKLINK_BASE],
};

const VAULT_ABI = parseAbi([
  "function totalAssets() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
  "function convertToAssets(uint256 shares) view returns (uint256)",
  "function convertToShares(uint256 assets) view returns (uint256)",
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function withdraw(uint256 assets, address receiver, address owner) returns (uint256)",
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
]);

const publicClient = createPublicClient({
  transport: http(X_LAYER_RPC, { batch: { batchSize: 20, wait: 16 } }),
});

interface VaultState {
  totalAssets: bigint;
  totalSupply: bigint;
  idleUsdc: bigint;
  sharePriceRaw: bigint;
  userUsdc: bigint;
  userAllowance: bigint;
  userShares: bigint;
  userStakedUsdc: bigint;
  userOkb: bigint;
}

interface MerklStats {
  apr: number;
  dailyRewards: number;
  tvl: number;
}

function fmtUsd(raw: bigint, decimals = 6, dp = 2): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  });
}

function fmtToken(raw: bigint, decimals: number, maxDp = 6): string {
  const n = Number(formatUnits(raw, decimals));
  if (!Number.isFinite(n) || n === 0) return "0";
  if (n < 0.000001) return "< 0.000001";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: maxDp,
  });
}

function trimDecimalStr(val: bigint, decimals: number): string {
  const s = formatUnits(val, decimals);
  if (!s.includes(".")) return s;
  return s.replace(/\.?0+$/, "");
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export default function VaultPage() {
  const {
    address,
    chainId,
    status: walletStatus,
    error: walletError,
    walletName,
    hasRabby,
    connect,
    connectRabby,
    disconnect,
    switchChain,
    sendTxWithRetry,
  } = useWallet();

  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [amountStr, setAmountStr] = useState("");
  const [isMaxMode, setIsMaxMode] = useState(false);
  const [infiniteApprove, setInfiniteApprove] = useState(false);
  const [touched, setTouched] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const [vault, setVault] = useState<VaultState | null>(null);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState("");
  const [merkl, setMerkl] = useState<MerklStats | null>(null);

  const [txPendingLabel, setTxPendingLabel] = useState("");
  const [lastTx, setLastTx] = useState<{ hash: string; label: string; confirmed: boolean } | null>(
    null
  );
  const [copiedAddr, setCopiedAddr] = useState("");

  const inputId = useId();
  const hintId = useId();
  const errorId = useId();

  const refreshChain = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setReadError("");
    try {
      const userAddr =
        address && /^0x[a-fA-F0-9]{40}$/.test(address)
          ? (address as `0x${string}`)
          : null;

      const baseReads = Promise.all([
        publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "totalAssets",
        }),
        publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "totalSupply",
        }),
        publicClient.readContract({
          address: USDC_ADDRESS,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [VAULT_ADDRESS],
        }),
        publicClient.readContract({
          address: VAULT_ADDRESS,
          abi: VAULT_ABI,
          functionName: "convertToAssets",
          args: [10n ** 18n],
        }),
      ]);

      const userReads = userAddr
        ? Promise.all([
            publicClient.readContract({
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: "balanceOf",
              args: [userAddr],
            }),
            publicClient.readContract({
              address: USDC_ADDRESS,
              abi: ERC20_ABI,
              functionName: "allowance",
              args: [userAddr, VAULT_ADDRESS],
            }),
            publicClient.readContract({
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "balanceOf",
              args: [userAddr],
            }),
            publicClient.getBalance({ address: userAddr }),
          ])
        : Promise.resolve([0n, 0n, 0n, 0n] as const);

      const [[totalAssets, totalSupply, idleUsdc, sharePriceRaw], [userUsdc, userAllowance, userShares, userOkb]] =
        await Promise.all([baseReads, userReads]);

      const userStakedUsdc =
        userShares > 0n
          ? await publicClient.readContract({
              address: VAULT_ADDRESS,
              abi: VAULT_ABI,
              functionName: "convertToAssets",
              args: [userShares],
            })
          : 0n;

      setVault({
        totalAssets,
        totalSupply,
        idleUsdc,
        sharePriceRaw,
        userUsdc,
        userAllowance,
        userShares,
        userStakedUsdc,
        userOkb,
      });
    } catch (e: any) {
      setReadError(e?.shortMessage || e?.message || "读取 X Layer 链上数据失败");
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    refreshChain(false);
    const timer = setInterval(() => refreshChain(true), 15_000);
    return () => clearInterval(timer);
  }, [refreshChain]);

  useEffect(() => {
    let alive = true;
    fetch(`https://api.merkl.xyz/v4/opportunities/${MERKL_OPP_ID}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!alive || !d) return;
        if (typeof d.apr === "number" || typeof d.dailyRewards === "number") {
          setMerkl({
            apr: Number(d.apr || 0),
            dailyRewards: Number(d.dailyRewards || 0),
            tvl: Number(d.tvl || 0),
          });
        }
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const switchTab = (next: "deposit" | "withdraw") => {
    setTab(next);
    setAmountStr("");
    setIsMaxMode(false);
    setTouched(false);
    setSubmitted(false);
  };

  const parsedAmountRaw = useMemo((): bigint | null => {
    const trimmed = amountStr.trim();
    if (!trimmed) return null;
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) return null;
    try {
      return parseUnits(trimmed, 6);
    } catch {
      return null;
    }
  }, [amountStr]);

  const effectiveAmountRaw = useMemo((): bigint | null => {
    if (!vault) return parsedAmountRaw;
    if (isMaxMode) {
      return tab === "deposit" ? vault.userUsdc : vault.userStakedUsdc;
    }
    return parsedAmountRaw;
  }, [vault, isMaxMode, tab, parsedAmountRaw]);

  const validationError = useMemo(() => {
    const trimmed = amountStr.trim();
    if (!trimmed) return "请输入 USDC 数量";
    if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
      return "请输入有效的数字金额（最多支持 6 位小数）";
    }
    if (effectiveAmountRaw === null || effectiveAmountRaw <= 0n) {
      return "金额必须大于 0";
    }
    if (vault && tab === "deposit" && effectiveAmountRaw > vault.userUsdc) {
      return `超出钱包可用余额（当前可用 ${fmtUsd(vault.userUsdc, 6, 4)} USDC）`;
    }
    if (vault && tab === "withdraw" && !isMaxMode && effectiveAmountRaw > vault.userStakedUsdc) {
      return `超出已质押余额（当前已质押 ${fmtUsd(vault.userStakedUsdc, 6, 4)} USDC）`;
    }
    if (vault && tab === "withdraw" && isMaxMode && vault.userShares <= 0n) {
      return "当前没有可提取的质押份额";
    }
    return "";
  }, [amountStr, effectiveAmountRaw, vault, tab, isMaxMode]);

  const showValidationError = (touched || submitted) && Boolean(validationError);

  const estimatedShares = useMemo(() => {
    if (!vault || !effectiveAmountRaw || effectiveAmountRaw <= 0n || vault.sharePriceRaw <= 0n) {
      return 0n;
    }
    return (effectiveAmountRaw * 10n ** 18n) / vault.sharePriceRaw;
  }, [vault, effectiveAmountRaw]);

  const needsApproval = useMemo(() => {
    if (tab !== "deposit" || !vault || !effectiveAmountRaw || effectiveAmountRaw <= 0n) {
      return false;
    }
    return vault.userAllowance < effectiveAmountRaw;
  }, [tab, vault, effectiveAmountRaw]);

  const exceedsIdleLiquidity = useMemo(() => {
    if (tab !== "withdraw" || !vault || !effectiveAmountRaw) return false;
    return effectiveAmountRaw > vault.idleUsdc;
  }, [tab, vault, effectiveAmountRaw]);

  const poolSharePct = useMemo(() => {
    if (!vault || vault.totalAssets <= 0n || vault.userStakedUsdc <= 0n) return "0.00%";
    const pct = (Number(vault.userStakedUsdc) / Number(vault.totalAssets)) * 100;
    return `${pct.toFixed(2)}%`;
  }, [vault]);

  const deployedMorphoUsdc = useMemo(() => {
    if (!vault) return 0n;
    return vault.totalAssets > vault.idleUsdc ? vault.totalAssets - vault.idleUsdc : 0n;
  }, [vault]);

  const handleQuickFill = (ratio: number) => {
    if (!vault) return;
    const base = tab === "deposit" ? vault.userUsdc : vault.userStakedUsdc;
    if (base <= 0n) {
      setAmountStr("0");
      setIsMaxMode(false);
      return;
    }
    if (ratio === 1) {
      setIsMaxMode(true);
      setAmountStr(trimDecimalStr(base, 6));
      setTouched(false);
      setSubmitted(false);
      return;
    }
    setIsMaxMode(false);
    const part = (base * BigInt(Math.round(ratio * 100))) / 100n;
    setAmountStr(trimDecimalStr(part, 6));
    setTouched(false);
    setSubmitted(false);
  };

  const ensureXLayerNetwork = async () => {
    if (chainId === X_LAYER_CHAIN_ID) return;
    setTxPendingLabel("正在切换至 X Layer (196)…");
    await switchChain(X_LAYER_CHAIN_ID, X_LAYER_CHAIN_PARAMS);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    setTouched(true);

    if (walletStatus !== "connected" || !address) {
      toast.warn("请先连接 Rabby 钱包");
      return;
    }
    if (validationError || !effectiveAmountRaw) {
      return;
    }

    const userAddr = address as `0x${string}`;

    try {
      await ensureXLayerNetwork();

      if (tab === "deposit") {
        // 1. 授权 USDC（如额度不足）
        if (needsApproval) {
          setTxPendingLabel("1/2 请在 Rabby 确认 USDC 授权…");
          const approveAmount = infiniteApprove ? maxUint256 : effectiveAmountRaw;
          const approveData = encodeFunctionData({
            abi: ERC20_ABI,
            functionName: "approve",
            args: [VAULT_ADDRESS, approveAmount],
          });
          const approveHash = await sendTxWithRetry(
            { to: USDC_ADDRESS, data: approveData },
            "授权 USDC 给 Gauntlet 金库"
          );
          setLastTx({ hash: approveHash, label: "USDC 授权", confirmed: false });
          setTxPendingLabel("1/2 等待 USDC 授权上链确认…");
          await waitForTxReceipt(approveHash);
          setLastTx({ hash: approveHash, label: "USDC 授权", confirmed: true });
          toast.success("USDC 授权已确认", shortAddr(approveHash));
        }

        // 2. 存入质押
        setTxPendingLabel(
          needsApproval ? "2/2 请在 Rabby 确认质押存入…" : "请在 Rabby 确认质押存入…"
        );
        const depositData = encodeFunctionData({
          abi: VAULT_ABI,
          functionName: "deposit",
          args: [effectiveAmountRaw, userAddr],
        });
        const depositHash = await sendTxWithRetry(
          { to: VAULT_ADDRESS, data: depositData },
          `质押 ${fmtUsd(effectiveAmountRaw, 6, 2)} USDC`
        );
        setLastTx({ hash: depositHash, label: "质押存入", confirmed: false });
        setTxPendingLabel("等待质押交易上链确认…");
        await waitForTxReceipt(depositHash);
        setLastTx({ hash: depositHash, label: "质押存入", confirmed: true });
        toast.success("质押成功！", `已存入 ${fmtUsd(effectiveAmountRaw, 6, 4)} USDC`);
      } else {
        // 提取：MAX 模式直接按 shares 调用 redeem，彻底避免留粉尘份额
        const isFullRedeem = isMaxMode && vault && vault.userShares > 0n;
        setTxPendingLabel("请在 Rabby 确认提取交易…");
        const txData = isFullRedeem
          ? encodeFunctionData({
              abi: VAULT_ABI,
              functionName: "redeem",
              args: [vault.userShares, userAddr, userAddr],
            })
          : encodeFunctionData({
              abi: VAULT_ABI,
              functionName: "withdraw",
              args: [effectiveAmountRaw, userAddr, userAddr],
            });
        const withdrawHash = await sendTxWithRetry(
          { to: VAULT_ADDRESS, data: txData },
          isFullRedeem
            ? "全部提取 USDC（按份额赎回）"
            : `提取 ${fmtUsd(effectiveAmountRaw, 6, 2)} USDC`
        );
        setLastTx({ hash: withdrawHash, label: "金库提取", confirmed: false });
        setTxPendingLabel("等待提取交易上链确认…");
        await waitForTxReceipt(withdrawHash);
        setLastTx({ hash: withdrawHash, label: "金库提取", confirmed: true });
        toast.success(
          "提取成功！",
          isFullRedeem
            ? "已全额赎回本金与收益至钱包"
            : `已提取 ${fmtUsd(effectiveAmountRaw, 6, 4)} USDC`
        );
      }

      setAmountStr("");
      setIsMaxMode(false);
      setTouched(false);
      setSubmitted(false);
      await refreshChain(true);
    } catch (err: any) {
      const msg = err?.shortMessage || err?.message || "交易未完成";
      toast.error("操作失败", msg);
    } finally {
      setTxPendingLabel("");
    }
  };

  const copyAddr = (addr: string) => {
    navigator.clipboard?.writeText(addr).then(() => {
      setCopiedAddr(addr);
      setTimeout(() => setCopiedAddr(""), 1600);
    });
  };

  const isXLayer = chainId === X_LAYER_CHAIN_ID;
  const isBusy = Boolean(txPendingLabel);

  return (
    <div className="mx-auto max-w-4xl space-y-4">
      {/* 顶部标题与 Rabby 钱包控制栏 */}
      <div className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-base font-bold text-white">
                Gauntlet USDC Earn 金库
              </h1>
              <span className="tag-info">X Layer · 196</span>
              <span className="tag-muted font-mono">gtusdce</span>
              <span className="tag-ok">ERC-4626 无白名单</span>
            </div>
            <p className="text-xs text-slate-400">
              直连 X Layer 链上金库合约，支持 Rabby 钱包一键质押原生 USDC、按份额无尘提取、实时查看已质押与池子总余额。
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {walletStatus === "connected" && address ? (
              <>
                <span
                  className={`tag ${isXLayer ? "tag-ok" : "tag-warn"} font-mono`}
                >
                  {walletName || "钱包"} · {shortAddr(address)}
                </span>
                {!isXLayer ? (
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    onClick={() =>
                      switchChain(X_LAYER_CHAIN_ID, X_LAYER_CHAIN_PARAMS).catch(
                        (e) => toast.error("切链失败", e?.message)
                      )
                    }
                  >
                    切换至 X Layer
                  </button>
                ) : (
                  <span className="tag-ok">X Layer 已就绪</span>
                )}
                {walletName !== "Rabby" && hasRabby && (
                  <button
                    type="button"
                    className="btn-ghost btn-xs"
                    onClick={connectRabby}
                  >
                    切到 Rabby
                  </button>
                )}
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  onClick={disconnect}
                >
                  断开
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="btn-primary btn-xs"
                  disabled={walletStatus === "connecting"}
                  onClick={connectRabby}
                >
                  {walletStatus === "connecting" ? "连接中…" : "连接 Rabby 钱包"}
                </button>
                <button
                  type="button"
                  className="btn-ghost btn-xs"
                  disabled={walletStatus === "connecting"}
                  onClick={connect}
                >
                  其他钱包
                </button>
              </>
            )}
            <button
              type="button"
              className="btn-ghost btn-xs"
              disabled={loading}
              onClick={() => refreshChain(false)}
            >
              {loading ? "读取中…" : "↻ 刷新"}
            </button>
          </div>
        </div>

        {(walletError || readError) && (
          <div className="mt-3 rounded-lg border border-rose-500/35 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
            {walletError || readError}
          </div>
        )}
      </div>

      {/* 4 个核心实时指标卡片 */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className="card p-3.5">
          <div className="text-[11px] font-medium text-slate-400">
            当前池子总余额 (Total Assets)
          </div>
          <div className="mt-1 font-mono text-xl font-bold text-white">
            {vault ? `$${fmtUsd(vault.totalAssets, 6, 2)}` : "—"}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 text-[11px] text-slate-400">
            <span>
              金库闲置可提：
              <strong className="font-mono text-emerald-300">
                {vault ? `$${fmtUsd(vault.idleUsdc, 6, 2)}` : "—"}
              </strong>
            </span>
            {vault && deployedMorphoUsdc > 0n && (
              <span>· 策略中 ${fmtUsd(deployedMorphoUsdc, 6, 0)}</span>
            )}
          </div>
        </div>

        <div className="card p-3.5">
          <div className="text-[11px] font-medium text-slate-400">
            我的已质押余额 (Staked)
          </div>
          <div className="mt-1 font-mono text-xl font-bold text-cyan-300">
            {address && vault ? `$${fmtUsd(vault.userStakedUsdc, 6, 4)}` : "—"}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">
            {address && vault ? (
              <>
                份额{" "}
                <span className="font-mono text-slate-200">
                  {fmtToken(vault.userShares, 18, 4)} gtusdce
                </span>{" "}
                ({poolSharePct})
              </>
            ) : (
              "连接钱包后显示个人质押"
            )}
          </div>
        </div>

        <div className="card p-3.5">
          <div className="text-[11px] font-medium text-slate-400">
            钱包可用 USDC (X Layer)
          </div>
          <div className="mt-1 font-mono text-xl font-bold text-emerald-300">
            {address && vault ? `${fmtUsd(vault.userUsdc, 6, 4)}` : "—"}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">
            {address && vault ? (
              <>
                Gas (OKB)：
                <span
                  className={`font-mono ${
                    vault.userOkb === 0n ? "text-amber-300" : "text-slate-200"
                  }`}
                >
                  {fmtToken(vault.userOkb, 18, 4)} OKB
                </span>
              </>
            ) : (
              "原生 Circle USDC (0xb6ce…3061)"
            )}
          </div>
        </div>

        <div className="card p-3.5">
          <div className="text-[11px] font-medium text-slate-400">
            份额净值 &amp; Merkl 激励
          </div>
          <div className="mt-1 font-mono text-xl font-bold text-amber-300">
            {merkl ? `${merkl.apr.toFixed(2)}% APR` : vault ? `1 : ${fmtUsd(vault.sharePriceRaw, 6, 6)}` : "—"}
          </div>
          <div className="mt-1.5 text-[11px] text-slate-400">
            {vault ? `1 gtusdce = ${fmtUsd(vault.sharePriceRaw, 6, 6)} USDC` : "—"}
            {merkl && merkl.dailyRewards > 0 && (
              <span className="ml-1.5 text-amber-200">
                · 日奖 ${merkl.dailyRewards.toFixed(1)}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* 质押 / 提取操作面板 */}
      <div className="card p-4 sm:p-5">
        <div
          role="tablist"
          aria-label="金库操作切换"
          className="grid grid-cols-2 gap-2 rounded-xl border border-white/10 bg-[#080d17] p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={tab === "deposit"}
            onClick={() => switchTab("deposit")}
            className={`rounded-lg py-2 text-xs font-semibold transition ${
              tab === "deposit"
                ? "bg-cyan-500/20 text-cyan-200 border border-cyan-400/40 shadow-sm"
                : "text-slate-400 hover:text-white border border-transparent"
            }`}
          >
            ➕ 质押存入 (Deposit)
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "withdraw"}
            onClick={() => switchTab("withdraw")}
            className={`rounded-lg py-2 text-xs font-semibold transition ${
              tab === "withdraw"
                ? "bg-emerald-500/20 text-emerald-200 border border-emerald-400/40 shadow-sm"
                : "text-slate-400 hover:text-white border border-transparent"
            }`}
          >
            ➖ 提取赎回 (Withdraw)
          </button>
        </div>

        <form onSubmit={handleSubmit} noValidate className="mt-4 space-y-4">
          <div>
            <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-xs">
              <label htmlFor={inputId} className="font-medium text-slate-200">
                {tab === "deposit" ? "质押数量 (USDC)" : "提取数量 (USDC)"}
              </label>
              <span id={hintId} className="text-[11px] text-slate-400">
                {tab === "deposit" ? (
                  <>
                    可用：
                    <span className="font-mono text-slate-200">
                      {address && vault ? `${fmtUsd(vault.userUsdc, 6, 4)} USDC` : "未连接"}
                    </span>
                    {address && vault && (
                      <span className="ml-2 text-slate-500">
                        (已授权 {vault.userAllowance > 10n ** 15n ? "无限" : `${fmtUsd(vault.userAllowance, 6, 2)}`})
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    可提取：
                    <span className="font-mono text-slate-200">
                      {address && vault ? `${fmtUsd(vault.userStakedUsdc, 6, 4)} USDC` : "未连接"}
                    </span>
                  </>
                )}
              </span>
            </div>

            <div className="relative flex items-center">
              <input
                id={inputId}
                type="text"
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                value={amountStr}
                aria-invalid={showValidationError ? "true" : "false"}
                aria-describedby={showValidationError ? `${hintId} ${errorId}` : hintId}
                onChange={(e) => {
                  setIsMaxMode(false);
                  setAmountStr(e.target.value);
                }}
                onBlur={() => setTouched(true)}
                className={`input h-11 pr-20 font-mono text-base ${
                  showValidationError
                    ? "border-rose-500/80 bg-rose-950/20 focus:border-rose-400 focus:ring-rose-400/20"
                    : ""
                }`}
              />
              <span className="pointer-events-none absolute right-3 rounded bg-white/10 px-2 py-0.5 font-mono text-xs font-semibold text-slate-200">
                USDC
              </span>
            </div>

            {showValidationError && (
              <div
                id={errorId}
                className="mt-1.5 flex items-center gap-1.5 text-xs text-rose-300"
              >
                <span role="img" aria-label="错误">
                  ❌
                </span>
                <span>{validationError}</span>
              </div>
            )}

            <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-1.5">
                {[0.25, 0.5, 0.75, 1].map((r) => (
                  <button
                    key={r}
                    type="button"
                    disabled={!address || !vault || isBusy}
                    onClick={() => handleQuickFill(r)}
                    className={`rounded-md border px-2.5 py-1 font-mono text-[11px] font-medium transition ${
                      r === 1 && isMaxMode
                        ? "border-cyan-400/60 bg-cyan-500/20 text-cyan-200"
                        : "border-white/10 bg-white/[0.04] text-slate-300 hover:border-white/25 hover:text-white"
                    } disabled:opacity-40`}
                  >
                    {r === 1 ? (tab === "withdraw" ? "全部提取 (MAX)" : "MAX") : `${r * 100}%`}
                  </button>
                ))}
              </div>

              {tab === "deposit" && needsApproval && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-300 select-none">
                  <input
                    type="checkbox"
                    checked={infiniteApprove}
                    onChange={(e) => setInfiniteApprove(e.target.checked)}
                    className="h-3.5 w-3.5 accent-cyan-400"
                  />
                  <span>无限授权 USDC（后续免重复授权）</span>
                </label>
              )}
            </div>
          </div>

          {/* 交易详情预览 */}
          <div className="panel-inset space-y-1.5 p-3 text-xs">
            <div className="flex items-center justify-between text-slate-400">
              <span>{tab === "deposit" ? "预计铸造份额" : "提取方式"}</span>
              <span className="font-mono text-slate-200">
                {tab === "deposit"
                  ? estimatedShares > 0n
                    ? `≈ ${fmtToken(estimatedShares, 18, 6)} gtusdce`
                    : "0 gtusdce"
                  : isMaxMode
                    ? "redeem(全部 shares) · 零粉尘清零"
                    : "withdraw(指定 USDC)"}
              </span>
            </div>
            <div className="flex items-center justify-between text-slate-400">
              <span>网络与目标合约</span>
              <span className="font-mono text-slate-300">
                X Layer · {shortAddr(VAULT_ADDRESS)}
              </span>
            </div>
          </div>

          {exceedsIdleLiquidity && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              ⚠️ 当前提取金额超过金库闲置流动性（${fmtUsd(vault!.idleUsdc, 6, 2)} USDC），超出部分位于 Morpho Blue 策略中，直接赎回可能受即时流动性限制。
            </div>
          )}

          {address && vault && vault.userOkb === 0n && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
              ⚠️ 当前钱包在 X Layer 链上的 OKB 余额为 0，可能无法支付 Gas 费，请先跨入少量 OKB。
            </div>
          )}

          {walletStatus !== "connected" ? (
            <button
              type="button"
              onClick={connectRabby}
              className="btn-primary h-10 w-full text-xs"
            >
              连接 Rabby 钱包开始{tab === "deposit" ? "质押" : "提取"}
            </button>
          ) : (
            <button
              type="submit"
              disabled={isBusy}
              className={`h-10 w-full text-xs ${
                tab === "deposit" ? "btn-primary" : "btn-secondary"
              }`}
            >
              {isBusy
                ? txPendingLabel
                : !isXLayer
                  ? `切换至 X Layer 并${tab === "deposit" ? "质押" : "提取"}`
                  : tab === "deposit"
                    ? needsApproval
                      ? "授权并质押 USDC（2 步确认）"
                      : "确认质押 USDC"
                    : isMaxMode
                      ? "全部提取 USDC（无尘赎回）"
                      : "确认提取 USDC"}
            </button>
          )}
        </form>

        {lastTx && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-white/10 bg-[#080d17] px-3 py-2 text-xs">
            <div className="flex items-center gap-2">
              <span
                className={`h-2 w-2 rounded-full ${
                  lastTx.confirmed ? "bg-emerald-400" : "animate-pulse bg-amber-400"
                }`}
              />
              <span className="text-slate-300">
                最近交易 · {lastTx.label}（{lastTx.confirmed ? "已上链确认" : "确认中…"}）
              </span>
            </div>
            <a
              href={`${OKLINK_BASE}/tx/${lastTx.hash}`}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-cyan-300 hover:underline"
            >
              {shortAddr(lastTx.hash)} ↗
            </a>
          </div>
        )}
      </div>

      {/* 合约信息核对栏 */}
      <div className="card p-3.5 text-[11px] text-slate-400">
        <div className="mb-2 font-semibold text-slate-300">链上合约地址核对（X Layer Mainnet · 196）</div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {[
            { label: "金库合约 (gtusdce)", addr: VAULT_ADDRESS },
            { label: "原生 USDC", addr: USDC_ADDRESS },
            { label: "Morpho Blue 适配器", addr: MORPHO_ADAPTER },
          ].map((item) => (
            <div
              key={item.addr}
              className="panel-inset flex items-center justify-between gap-2 px-2.5 py-2"
            >
              <div className="min-w-0">
                <div className="text-[10px] text-slate-500">{item.label}</div>
                <a
                  href={`${OKLINK_BASE}/address/${item.addr}`}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-slate-200 hover:text-cyan-300 hover:underline"
                >
                  {shortAddr(item.addr)}
                </a>
              </div>
              <button
                type="button"
                onClick={() => copyAddr(item.addr)}
                className="rounded border border-white/10 px-1.5 py-0.5 text-[10px] text-slate-300 hover:border-white/25 hover:text-white"
              >
                {copiedAddr === item.addr ? "已复制" : "复制"}
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
