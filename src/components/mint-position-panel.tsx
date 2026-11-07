"use client";
/**
 * 直接创建 LP 仓位面板（最小 tickSpacing 窗口）+ 自动质押。
 *
 * 1. 读取池子的翻转状态（pairFlip）：若已翻转（如 ETH/USDC.e 中 token1=ETH 为主币），
 *    自动将默认投入币种切为 token1（ETH），下拉框与计算结果均按主币优先展示。
 * 2. 支持 ZIA DEX 一键开启 NFT 全局免签质押（setApprovalForAll）+ 质押前链上校验 verifyNftPoolMatch，
 *    让原本 2~4 步签名压缩到 1~2 步。
 */
import { useState, useEffect, useCallback, useRef, useMemo } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, fmtFull, fmtTokenAmount } from "./util";
import {
  useWallet,
  verifyNftPoolMatch,
  extractMintedTokenIdFromReceipt,
  waitForTxReceipt,
} from "@/lib/wallet/use-wallet";
import {
  buildApproveCalldata,
  buildMintCalldata,
  buildNftApproveCalldata,
  buildSetApprovalForAllCalldata,
  buildStakeDepositCalldata,
  MAX_UINT256,
} from "@/lib/wallet/build-mint";
import { getAmountsForLiquidity, tickToSqrtPriceX96 } from "@/lib/v3/math";
import type { PoolRewardRadarItem } from "@/app/page";
import type { LivePairCexAnalysis, UseBinanceRealtimeReturn } from "@/lib/cex/use-binance-ws";

interface Props {
  chainId: number;
  pool: string;
  externalData?: any;
  probeLoading?: boolean;
  poolRadar?: PoolRewardRadarItem;
  liveCex?: LivePairCexAnalysis | null;
  w0gPriceUsd?: number;
  binanceRt?: UseBinanceRealtimeReturn;
  onClose?: () => void;
  onCreated?: () => void;
  onFlipChanged?: () => void;
}

export function MintPositionPanel({
  chainId: initialChainId,
  pool: initialPool,
  externalData,
  probeLoading,
  poolRadar,
  liveCex,
  w0gPriceUsd,
  binanceRt,
  onClose,
  onCreated,
  onFlipChanged,
}: Props) {
  const {
    address,
    chainId: walletChainId,
    connect,
    switchChain,
    sendTx,
  } = useWallet();
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);

  const [chainId, setChainId] = useState<number>(initialChainId || 0);
  const [pool, setPool] = useState(initialPool || "");

  // 区间：默认留空 = 使用最小窗口；可手动改
  const [tickLower, setTickLower] = useState<string>(
    externalData?.range ? String(externalData.range.tickLower) : ""
  );
  const [tickUpper, setTickUpper] = useState<string>(
    externalData?.range ? String(externalData.range.tickUpper) : ""
  );

  // 单侧金额输入
  const [side, setSide] = useState<"token0" | "token1">(
    externalData?.pairFlip === 1 ? "token1" : "token0"
  );
  const [amount, setAmount] = useState("");

  // 后端返回的状态
  const [data, setData] = useState<any>(externalData ?? null);
  const [busy, setBusy] = useState(false);
  const [togglingAllApprove, setTogglingAllApprove] = useState(false);
  const [msg, setMsg] = useState("");

  // 记录已初始化默认方向的池，首次加载或翻转变化时自动将投入币种设为主币
  const initializedPoolRef = useRef<string>("");

  // 执行进度
  const [steps, setSteps] = useState<
    {
      label: string;
      status: "pending" | "loading" | "done" | "skipped" | "error";
      hash?: string;
    }[]
  >([]);

  /** 拉取池子状态 + 反算两侧金额 */
  const fetchPool = useCallback(
    async (opts?: {
      range?: { tick_lower: number; tick_upper: number };
      withCompute?: boolean;
      withWallet?: boolean;
      sideOverride?: "token0" | "token1";
      poolOverride?: string;
      chainOverride?: number;
    }) => {
      const targetChain = opts?.chainOverride ?? chainId;
      const targetPool = (opts?.poolOverride ?? pool).trim();
      if (!targetChain || !/^0x[a-fA-F0-9]{40}$/.test(targetPool)) return;
      setBusy(true);
      setMsg("");
      try {
        const currentSide = opts?.sideOverride ?? side;
        const body: any = { chain_id: targetChain, pool: targetPool };
        if ((opts?.withWallet ?? !!address) && address) body.wallet = address;
        if ((opts?.withCompute ?? !!amount) && amount) {
          body.input_side = currentSide;
          body.input_amount = amount;
        }
        const rl =
          opts?.range?.tick_lower ??
          (tickLower !== "" ? Number(tickLower) : undefined);
        const ru =
          opts?.range?.tick_upper ??
          (tickUpper !== "" ? Number(tickUpper) : undefined);
        if (rl !== undefined && ru !== undefined && !Number.isNaN(rl) && !Number.isNaN(ru)) {
          body.tick_lower = rl;
          body.tick_upper = ru;
        }
        const r = await fetch("/api/liquidity-mint", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(body),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        let nextData = j.data;

        // 首次加载该池时：如果池子设置了翻转（pairFlip === 1，即 token1 为主币如 ETH），
        // 自动把默认投入币种切为 token1（主币）
        const poolKey = `${targetChain}:${targetPool.toLowerCase()}:${nextData.pairFlip ?? 0}`;
        if (initializedPoolRef.current !== poolKey && !opts?.sideOverride) {
          initializedPoolRef.current = poolKey;
          const preferredSide: "token0" | "token1" =
            nextData.pairFlip === 1 ? "token1" : "token0";
          if (preferredSide !== currentSide) {
            setSide(preferredSide);
            if (amount) {
              const r2 = await fetch("/api/liquidity-mint", {
                method: "POST",
                headers: authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({
                  ...body,
                  input_side: preferredSide,
                  input_amount: amount,
                }),
              });
              const j2 = await r2.json();
              if (j2.ok) nextData = j2.data;
            }
          }
        }

        setData(nextData);
        if (opts?.range || tickLower === "") {
          setTickLower(String(nextData.range.tickLower));
          setTickUpper(String(nextData.range.tickUpper));
        }
      } catch (e: any) {
        setMsg(`❌ ${e.message}`);
      } finally {
        setBusy(false);
      }
    },
    [chainId, pool, address, amount, side, tickLower, tickUpper]
  );

  /** 当外部探针返回 mintInit 数据时，直接注入（0 额外请求） */
  useEffect(() => {
    if (!externalData || !externalData.pool) return;
    const extChain = externalData.chain?.id ?? initialChainId;
    const extPool = (externalData.pool.address || initialPool || "").toLowerCase();
    setChainId(extChain);
    setPool(extPool);
    setData(externalData);
    setMsg("");
    if (externalData.range) {
      setTickLower(String(externalData.range.tickLower));
      setTickUpper(String(externalData.range.tickUpper));
    }
    const poolKey = `${extChain}:${extPool}:${externalData.pairFlip ?? 0}`;
    if (initializedPoolRef.current !== poolKey) {
      initializedPoolRef.current = poolKey;
      setSide(externalData.pairFlip === 1 ? "token1" : "token0");
    }
  }, [externalData, initialChainId, initialPool]);

  /** 仅当没有外部探针同步数据且非探针加载中时，才主动拉取 */
  useEffect(() => {
    if (!initialPool || !initialChainId) return;
    setChainId(initialChainId);
    setPool(initialPool);
    if (probeLoading) return;
    if (
      externalData?.pool?.address &&
      externalData.pool.address.toLowerCase() === initialPool.toLowerCase()
    ) {
      return;
    }
    setTickLower("");
    setTickUpper("");
    fetchPool({
      chainOverride: initialChainId,
      poolOverride: initialPool,
      withCompute: !!amount,
      withWallet: !!address,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialChainId, initialPool]);

  /** 金额/侧向变化时自动重算（防抖 400ms） */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!data || !amount) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPool({ withCompute: true, withWallet: !!address });
    }, 400);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side]);

  /** 钱包连接状态变化且当前缺少余额/授权信息时刷新一次 */
  const lastFetchedWalletRef = useRef<string>("");
  useEffect(() => {
    if (!data || !address) return;
    const key = `${chainId}:${pool.toLowerCase()}:${address.toLowerCase()}`;
    if (data.balances && lastFetchedWalletRef.current === "") {
      lastFetchedWalletRef.current = key;
      return;
    }
    if (lastFetchedWalletRef.current === key) return;
    lastFetchedWalletRef.current = key;
    fetchPool({ withCompute: !!amount, withWallet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  // 建仓模式切换："min" = ⚡ 最小区间（单格冲锋）；"zero_to_above" = 🛡️ 0 ~ 现价略高（重U少主币 · 防跌不越界）
  const [rangeMode, setRangeMode] = useState<"min" | "zero_to_above">("min");
  const [zeroAboveExtraTicks, setZeroAboveExtraTicks] = useState<number>(3);
  const [simCapitalUsd, setSimCapitalUsd] = useState<number>(1000);

  /** 计算「0 ~ 现价略高 (+extraTicks 格)」对应的 [tickLower, tickUpper] 及重仓稳定币侧 */
  const computeZeroToAboveRange = useCallback(
    (extraTicks: number, baseTickOverride?: number) => {
      if (!data?.pool) return null;
      const spacing = data.pool.tickSpacing || 60;
      const curTick = baseTickOverride ?? data.pool.currentTick;
      const flipped = data.pairFlip === 1;
      const baseWindowLower = Math.floor(curTick / spacing) * spacing;
      const baseWindowUpper = baseWindowLower + spacing;

      if (!flipped) {
        // 未翻转（如 W0G/USDC.e、WBTC/USDC.e）：token0 为主币，token1 为稳定币(USDC.e)
        // 主币价格 = 0 对应 MIN_TICK (-887220)，上界取当前最小窗口上界 + extraTicks * spacing
        const minAligned = Math.ceil(-887272 / spacing) * spacing;
        const upper = baseWindowUpper + extraTicks * spacing;
        return {
          tickLower: minAligned,
          tickUpper: upper,
          quoteSide: "token1" as const,
        };
      } else {
        // 已翻转（如 USDC.e/WETH、USDC.e/SOL）：token0 为稳定币(USDC.e)，token1 为主币
        // 主币价格 = 0 对应 MAX_TICK (+887220)，下界取当前最小窗口下界 - extraTicks * spacing
        const maxAligned = Math.floor(887272 / spacing) * spacing;
        const lower = baseWindowLower - extraTicks * spacing;
        return {
          tickLower: lower,
          tickUpper: maxAligned,
          quoteSide: "token0" as const,
        };
      }
    },
    [data]
  );

  /** 刷新 tick（LP 波动快时用，默认对齐最新最小窗口） */
  async function refreshTick(useMinWindow = false) {
    if (useMinWindow) {
      setRangeMode("min");
      setTickLower("");
      setTickUpper("");
      await fetchPool({
        range: undefined,
        withCompute: !!amount,
        withWallet: !!address,
      });
    } else {
      await fetchPool({
        range: { tick_lower: Number(tickLower), tick_upper: Number(tickUpper) },
        withCompute: !!amount,
        withWallet: !!address,
      });
    }
  }

  /** 模式 A：应用最小单格窗口（可选按链上当前 Tick 或按币安实时隐含 Tick 居中） */
  async function applyMinWindowMode(useBinanceImplied = false) {
    if (!data) return;
    setRangeMode("min");
    const spacing = data.pool.tickSpacing || 60;
    const refTick =
      useBinanceImplied && liveCex
        ? liveCex.impliedTick
        : data.pool.currentTick;
    const lower = Math.floor(refTick / spacing) * spacing;
    const upper = lower + spacing;
    setTickLower(String(lower));
    setTickUpper(String(upper));
    await fetchPool({
      range: { tick_lower: lower, tick_upper: upper },
      withCompute: !!amount,
      withWallet: !!address,
    });
  }

  /** 模式 B：应用「0 ~ 现价略高 (+extraTicks 格)」重 U 少主币模式 */
  async function applyZeroToAboveMode(extraTicks: number) {
    if (!data) return;
    setRangeMode("zero_to_above");
    setZeroAboveExtraTicks(extraTicks);
    const r = computeZeroToAboveRange(extraTicks);
    if (!r) return;
    setTickLower(String(r.tickLower));
    setTickUpper(String(r.tickUpper));
    setSide(r.quoteSide);
    await fetchPool({
      range: { tick_lower: r.tickLower, tick_upper: r.tickUpper },
      sideOverride: r.quoteSide,
      withCompute: !!amount,
      withWallet: !!address,
    });
  }

  /** 在建仓面板内翻转交易对，并把投入币种同步切到主币 */
  async function handleFlipInMint() {
    if (!data) return;
    setBusy(true);
    try {
      const nextFlip = data.pairFlip !== 1;
      const r = await fetch("/api/liquidity-probe/pair-flip", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          chain_id: chainId,
          token0: data.pool.token0,
          token1: data.pool.token1,
          flip: nextFlip,
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "翻转失败");
      const nextSide: "token0" | "token1" = nextFlip ? "token1" : "token0";
      setSide(nextSide);
      initializedPoolRef.current = `${chainId}:${pool.toLowerCase()}:${nextFlip ? 1 : 0}`;
      await fetchPool({
        sideOverride: nextSide,
        withCompute: !!amount,
        withWallet: !!address,
      });
      mutate("/api/positions");
      mutate("/api/liquidity-favorites");
      onFlipChanged?.();
    } catch (e: any) {
      setMsg(`❌ 翻转失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  /** 开启/关闭 Staker 的 setApprovalForAll（免每次建仓后的单 NFT 授权签名） */
  async function handleToggleApprovalForAll(approve: boolean) {
    if (!data?.dex || !data?.matchedStaking?.[0]) return;
    setTogglingAllApprove(true);
    setMsg("");
    try {
      let currentAddr = address;
      if (!currentAddr) {
        currentAddr = await connect();
        if (!currentAddr) throw new Error("请先连接钱包");
      }
      if (walletChainId !== data.chain.chain_id) {
        await switchChain(data.chain.chain_id);
      }
      const staker = data.matchedStaking[0].contract;
      const tx = buildSetApprovalForAllCalldata(data.dex.npm, staker, approve);
      await sendTx(tx);
      await new Promise((r) => setTimeout(r, 1500));
      await fetchPool({ withCompute: !!amount, withWallet: true });
      setMsg(
        approve
          ? "✅ 已开启 NFT 免签质押！后续建仓后将直接质押，无需再签 NFT 授权交易"
          : "✅ 已撤销 NFT 免签质押授权"
      );
    } catch (e: any) {
      setMsg(`❌ 授权操作失败：${e?.message ?? e}`);
    } finally {
      setTogglingAllApprove(false);
    }
  }

  /** 执行创建流程 */
  async function execute() {
    if (!address) {
      await connect();
      return;
    }
    if (!data?.compute) {
      setMsg("❌ 请先输入投入金额");
      return;
    }
    if (!data.dex) {
      setMsg("❌ 未能匹配到池子所属 DEX（请在配置页添加对应 DEX）");
      return;
    }

    setBusy(true);
    setMsg("");
    const npm = data.dex.npm;
    const staker = data.matchedStaking?.[0]?.contract ?? "";
    const need0 = BigInt(data.compute.amount0);
    const need1 = BigInt(data.compute.amount1);
    const appr = data.approvals;

    const skip0 = appr?.token0?.sufficient ?? false;
    const skip1 = appr?.token1?.sufficient ?? false;
    const nftApprovedAll = appr?.nftApprovedForAll ?? false;

    const flow: typeof steps = [
      {
        label: `授权 ${data.pool.token0Symbol || "token0"}`,
        status: skip0 ? "skipped" : "pending",
      },
      {
        label: `授权 ${data.pool.token1Symbol || "token1"}`,
        status: skip1 ? "skipped" : "pending",
      },
      { label: "创建仓位 (mint)", status: "pending" },
      ...(staker
        ? [
            {
              label: `质押到 ${
                data.matchedStaking[0].pair_label ||
                data.matchedStaking[0].platform
              }${nftApprovedAll ? "（已免签 NFT 授权）" : ""}`,
              status: "pending" as const,
            },
          ]
        : []),
    ];
    setSteps(flow);

    const setStep = (i: number, patch: Partial<(typeof steps)[0]>) =>
      setSteps((prev) =>
        prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s))
      );

    const sendWithRetry = async (
      tx: { to: string; data: string; gas?: bigint },
      label: string
    ): Promise<string> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await sendTx(tx);
        } catch (e: any) {
          if (attempt === 3 || e?.message?.includes("拒绝")) throw e;
          const shouldRetry = confirm(
            `${label} 失败：${e?.message ?? e}\n\n是否重试（第 ${attempt + 1}/3 次）？`
          );
          if (!shouldRetry) throw e;
        }
      }
      throw new Error("unreachable");
    };

    try {
      // 仅当当前链不一致时才调用 switchChain，省去一次钱包扩展 IPC 往返
      if (walletChainId !== data.chain.chain_id) {
        await switchChain(data.chain.chain_id);
      }

      // Step 1: approve token0（预设 gas 加速弹窗，并用快速回执轮询替代固定死等）
      if (!skip0) {
        setStep(0, { status: "loading" });
        const a0 = buildApproveCalldata(data.pool.token0, npm, MAX_UINT256);
        const h0 = await sendWithRetry(
          { ...a0, gas: 80000n },
          `授权 ${data.pool.token0Symbol}`
        );
        await waitForTxReceipt(h0, 15000);
        setStep(0, { status: "done", hash: h0 });
      }

      // Step 2: approve token1
      if (!skip1) {
        setStep(1, { status: "loading" });
        const a1 = buildApproveCalldata(data.pool.token1, npm, MAX_UINT256);
        const h1 = await sendWithRetry(
          { ...a1, gas: 80000n },
          `授权 ${data.pool.token1Symbol}`
        );
        await waitForTxReceipt(h1, 15000);
        setStep(1, { status: "done", hash: h1 });
      }

      // Step 3: mint（零前置 RPC 阻塞，点击后立即弹出钱包确认窗！）
      setStep(2, { status: "loading" });
      const mint = buildMintCalldata(npm, {
        token0: data.pool.token0,
        token1: data.pool.token1,
        fee: data.pool.fee,
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        amount0Desired: need0,
        amount1Desired: need1,
        recipient: address,
        slippagePct: 0.5,
      });
      const hm = await sendWithRetry(mint, "创建仓位");

      // 优先直接从 mint 交易回执日志解析新铸造的 tokenId（仅 1 次 receipt 读取）
      const receiptTokenId = await extractMintedTokenIdFromReceipt(
        hm,
        address,
        npm
      );
      const tokenIdBig =
        receiptTokenId ?? (await fetchLatestOwnedTokenId(npm, address));
      const tokenId = tokenIdBig ? tokenIdBig.toString() : null;
      setStep(2, { status: "done", hash: hm });

      // Step 4: 质押（自动匹配到才做）
      if (staker) {
        if (!tokenIdBig || !tokenId) {
          setStep(3, { status: "error" });
          setMsg(`✅ 仓位已创建（未能解析 tokenId，请手动质押）`);
        } else {
          setStep(3, { status: "loading" });
          try {
            // 仅当 tokenId 来自兜底查询（而非刚才这笔 mint 交易自身的 Receipt）时，才需额外链上校验币种
            if (!receiptTokenId) {
              const check = await verifyNftPoolMatch(
                npm,
                tokenIdBig,
                data.pool.token0,
                data.pool.token1,
                data.pool.fee
              );
              if (!check.valid) {
                throw new Error(
                  check.reason || `NFT #${tokenId} 与当前池币种不匹配，已拦截质押`
                );
              }
            }

            // 如果尚未开启 setApprovalForAll，才需要单次 approve(staker, tokenId)
            if (!nftApprovedAll) {
              const approveNft = buildNftApproveCalldata(npm, staker, tokenIdBig);
              const ha = await sendWithRetry(
                { ...approveNft, gas: 100000n },
                "授权 NFT 给质押合约"
              );
              await waitForTxReceipt(ha, 15000);
            }
            const dep = buildStakeDepositCalldata(staker, tokenIdBig);
            // 预设 gas limit，避免钱包节点尚未同步最新区块时 estimateGas 卡顿
            const hd = await sendWithRetry(
              { ...dep, gas: 350000n },
              "质押"
            );
            // 等待质押交易上链回执确认后再触发监控刷新，确保新仓位立即识别为质押中
            await waitForTxReceipt(hd, 15000);
            setStep(3, { status: "done", hash: hd });
            setMsg(`✅ 创建并质押成功！tokenId=#${tokenId}`);
          } catch (e: any) {
            setStep(3, { status: "error" });
            setMsg(
              `⚠️ 仓位已创建（tokenId=#${tokenId}），质押未完成：${e?.message ?? e}`
            );
          }
        }
      } else {
        setMsg(`✅ 仓位创建成功${tokenId ? `，tokenId=#${tokenId}` : ""}`);
      }
      // 触发后台极速扫描同步新仓位状态
      fetch("/api/monitor", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mode: "combined" }),
      }).catch(() => {});
      onCreated?.();
    } catch (e: any) {
      setSteps((prev) =>
        prev.map((s) => (s.status === "loading" ? { ...s, status: "error" } : s))
      );
      setMsg(`❌ ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 极速兜底：仅当交易 Receipt 未能解析出 Transfer 日志时，
   * 直接读取钱包在 NPM 上的最后一个索引 `tokenOfOwnerByIndex(owner, balanceOf - 1)`（仅 2 次 eth_call，无需遍历历史 NFT）。
   */
  async function fetchLatestOwnedTokenId(
    npm: string,
    owner: string
  ): Promise<bigint | null> {
    const p = (window as any).okxwallet || (window as any).ethereum;
    if (!p) return null;
    try {
      const ownerPad = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const balHex = (await p.request({
        method: "eth_call",
        params: [{ to: npm, data: `0x70a08231${ownerPad}` }, "latest"],
      })) as string;
      const bal = Number(BigInt(balHex));
      if (bal <= 0) return null;
      const lastIdxHex = BigInt(bal - 1).toString(16).padStart(64, "0");
      const idHex = (await p.request({
        method: "eth_call",
        params: [
          { to: npm, data: `0x2f745c59${ownerPad}${lastIdxHex}` },
          "latest",
        ],
      })) as string;
      return BigInt(idHex);
    } catch {
      return null;
    }
  }

  // 根据 pairFlip 处理主币/计价币展示顺序
  const isFlipped = data?.pairFlip === 1;
  const sym0 = data?.pool?.token0Symbol || "token0";
  const sym1 = data?.pool?.token1Symbol || "token1";
  const displayPair = data
    ? isFlipped
      ? `${sym1}/${sym0}`
      : `${sym0}/${sym1}`
    : "";
  const displayPrice = data?.pool?.priceCurrent
    ? fmtFull(
        isFlipped && Number(data.pool.priceCurrent) > 0
          ? 1 / Number(data.pool.priceCurrent)
          : Number(data.pool.priceCurrent)
      )
    : "";

  // 解析实时 token0 / token1 USD 价格，供建仓收益模拟器与对比表使用
  const tokenPricesUsd = useMemo(() => {
    if (!data?.pool) return { p0: 0, p1: 0, w0g: w0gPriceUsd ?? 0.147 };
    let p0 =
      binanceRt?.getTokenUsdPrice(chainId, data.pool.token0, sym0) ??
      liveCex?.token0PriceUsd ??
      poolRadar?.token0PriceUsd ??
      0;
    let p1 =
      binanceRt?.getTokenUsdPrice(chainId, data.pool.token1, sym1) ??
      liveCex?.token1PriceUsd ??
      poolRadar?.token1PriceUsd ??
      0;
    const dexPrice = Number(data.pool.priceCurrent);
    if (p0 <= 0 && p1 > 0 && dexPrice > 0) p0 = dexPrice * p1;
    if (p1 <= 0 && p0 > 0 && dexPrice > 0) p1 = p0 / dexPrice;
    const w0g =
      binanceRt?.getTokenUsdPrice(
        chainId,
        "0x1cd0690ff9a693f5ef2dd976660a8dafc81a109c",
        "W0G"
      ) ??
      w0gPriceUsd ??
      0.147;
    return { p0, p1, w0g };
  }, [data, chainId, sym0, sym1, binanceRt, liveCex, poolRadar, w0gPriceUsd]);

  // 针对任意给定区间 [tl, tu] 与投入本金 USD，实时模拟 Merkl 50/25/25 质押收益与双币配比
  const simulateStrategy = useCallback(
    (tl: number, tu: number, capitalUsd: number) => {
      if (!data?.pool || capitalUsd <= 0 || tl >= tu) return null;
      const { p0, p1, w0g } = tokenPricesUsd;
      if (p0 <= 0 || p1 <= 0) return null;

      const curTick = data.pool.currentTick;
      const dec0 = data.pool.token0Decimals ?? poolRadar?.decimals0 ?? 18;
      const dec1 = data.pool.token1Decimals ?? poolRadar?.decimals1 ?? 6;
      const sqrtCur = tickToSqrtPriceX96(curTick);
      const sqrtA = tickToSqrtPriceX96(tl);
      const sqrtB = tickToSqrtPriceX96(tu);

      const L_REF = 10n ** 18n;
      const refAmounts = getAmountsForLiquidity(
        sqrtCur,
        sqrtA,
        sqrtB,
        L_REF,
        dec0,
        dec1
      );
      const refAmt0 = Number(refAmounts.amount0) || 0;
      const refAmt1 = Number(refAmounts.amount1) || 0;
      const refUsd = refAmt0 * p0 + refAmt1 * p1;
      if (refUsd <= 0) return null;

      const scale = capitalUsd / refUsd;
      const amt0 = refAmt0 * scale;
      const amt1 = refAmt1 * scale;
      const usd0 = amt0 * p0;
      const usd1 = amt1 * p1;
      const pct0 = (usd0 / capitalUsd) * 100;
      const pct1 = (usd1 / capitalUsd) * 100;
      const liq = BigInt(Math.max(1, Math.floor(scale * 1e9))) * 10n ** 9n;
      const inRange = curTick >= tl && curTick < tu;

      let activeLShare = 0;
      let token0Share = 0;
      let token1Share = 0;
      let rewardShare = 0;
      let dailyW0g = 0;
      let dailyUsd = 0;
      let hourlyW0g = 0;
      let hourlyUsd = 0;
      let aprPct = 0;

      if (poolRadar) {
        const poolActiveL = poolRadar.totalActiveL
          ? BigInt(poolRadar.totalActiveL)
          : 0n;
        const totalLAfter = poolActiveL + (inRange ? liq : 0n);
        activeLShare =
          inRange && totalLAfter > 0n
            ? Number((liq * 1000000n) / totalLAfter) / 1_000_000
            : 0;
        const poolAmt0 = poolRadar.stakedToken0Human ?? 0;
        const poolAmt1 = poolRadar.stakedToken1Human ?? 0;
        token0Share = poolAmt0 + amt0 > 0 ? amt0 / (poolAmt0 + amt0) : 0;
        token1Share = poolAmt1 + amt1 > 0 ? amt1 / (poolAmt1 + amt1) : 0;
        rewardShare =
          0.6 * activeLShare + 0.2 * token0Share + 0.2 * token1Share;
        dailyW0g = poolRadar.dailyW0g * rewardShare;
        hourlyW0g = dailyW0g / 24;
        dailyUsd = dailyW0g * (w0g > 0 ? w0g : 0.147);
        hourlyUsd = dailyUsd / 24;
        aprPct = capitalUsd > 0 ? ((dailyUsd * 365) / capitalUsd) * 100 : 0;
      }

      return {
        tl,
        tu,
        capitalUsd,
        amt0,
        amt1,
        usd0,
        usd1,
        pct0,
        pct1,
        inRange,
        activeLShare,
        token0Share,
        token1Share,
        rewardShare,
        hourlyW0g,
        hourlyUsd,
        dailyW0g,
        dailyUsd,
        aprPct,
      };
    },
    [data, tokenPricesUsd, poolRadar]
  );

  // 当前用户输入金额对应的真实美元本金（若未输入则使用 simCapitalUsd）
  const effectiveSimUsd = useMemo(() => {
    if (data?.compute) {
      const a0 = Number(data.compute.amount0Human) || 0;
      const a1 = Number(data.compute.amount1Human) || 0;
      const u = a0 * tokenPricesUsd.p0 + a1 * tokenPricesUsd.p1;
      if (u > 1) return u;
    }
    return simCapitalUsd;
  }, [data, tokenPricesUsd, simCapitalUsd]);

  // 当前选中区间的实时收益模拟
  const currentRangeSim = useMemo(() => {
    const tl = Number(tickLower);
    const tu = Number(tickUpper);
    if (!Number.isFinite(tl) || !Number.isFinite(tu) || tl >= tu) return null;
    return simulateStrategy(tl, tu, effectiveSimUsd);
  }, [tickLower, tickUpper, effectiveSimUsd, simulateStrategy]);

  // 三种典型开仓策略对比表（模式A 最小单格 vs 模式B 0~现价+1格 vs 模式B 0~现价+3格）
  const strategyComparison = useMemo(() => {
    if (!data?.pool) return [];
    const spacing = data.pool.tickSpacing || 60;
    const curTick = data.pool.currentTick;
    const minLower = Math.floor(curTick / spacing) * spacing;
    const minUpper = minLower + spacing;

    const rZero1 = computeZeroToAboveRange(1);
    const rZero3 = computeZeroToAboveRange(3);

    const rows: {
      id: string;
      title: string;
      badge: string;
      mode: "min" | "zero_to_above";
      extraTicks?: number;
      sim: NonNullable<ReturnType<typeof simulateStrategy>>;
    }[] = [];

    const simMin = simulateStrategy(minLower, minUpper, effectiveSimUsd);
    if (simMin) {
      rows.push({
        id: "min",
        title: "⚡ 模式A：最小单格",
        badge: "冲刺60%活跃L桶",
        mode: "min",
        sim: simMin,
      });
    }
    if (rZero1) {
      const s1 = simulateStrategy(rZero1.tickLower, rZero1.tickUpper, effectiveSimUsd);
      if (s1) {
        rows.push({
          id: "zero1",
          title: "🛡️ 模式B：0 ~ 现价+1格",
          badge: "重U少主币 · 防跌",
          mode: "zero_to_above",
          extraTicks: 1,
          sim: s1,
        });
      }
    }
    if (rZero3) {
      const s3 = simulateStrategy(rZero3.tickLower, rZero3.tickUpper, effectiveSimUsd);
      if (s3) {
        rows.push({
          id: "zero3",
          title: "🛡️ 模式B：0 ~ 现价+3格",
          badge: "推荐 · 历史#21631同款",
          mode: "zero_to_above",
          extraTicks: 3,
          sim: s3,
        });
      }
    }
    return rows;
  }, [data, effectiveSimUsd, computeZeroToAboveRange, simulateStrategy]);

  return (
    <div className="panel-inset border-cyan-500/30 p-4 text-xs">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">
          ② ➕ 极速建仓 & 自动质押（双模式 + 实时收益模拟）
        </span>
        {onClose && (
          <button className="btn-ghost btn-xs" onClick={onClose}>
            收起
          </button>
        )}
      </div>

      {/* 未选池子时提示从上方收藏列表选择 */}
      {!data ? (
        <div className="space-y-2">
          {initialPool ? (
            <div className="text-ink-soft">
              已选择池子{" "}
              <span className="font-mono">{initialPool.slice(0, 12)}…</span>
              {busy && <span className="ml-2 text-cyan-300">读取链上池子状态中…</span>}
            </div>
          ) : (
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2.5 text-cyan-200">
              👆 请在上方「收藏」列表点击一个交易对，将自动完成探针检测并载入建仓面板
            </div>
          )}
          {msg && <p className="text-warn">{msg}</p>}
        </div>
      ) : (
        <div className="space-y-2.5">
          {/* 池子信息 + DEX 自动锁定 + 翻转同步 */}
          <div className="flex flex-wrap items-center gap-2 text-ink-soft">
            <span className="text-ink font-medium">
              {displayPair} · fee {(data.pool.fee / 10000).toFixed(2)}% · ts{" "}
              {data.pool.tickSpacing} · 当前 tick{" "}
              <strong className="font-mono text-cyan-300">
                {data.pool.currentTick}
              </strong>
              {displayPrice && (
                <span className="ml-1.5 font-mono text-ink-soft">
                  (1 {isFlipped ? sym1 : sym0} ≈ {displayPrice}{" "}
                  {isFlipped ? sym0 : sym1})
                </span>
              )}
            </span>
            <button
              className="btn-ghost btn-xs"
              disabled={busy}
              onClick={() => refreshTick(rangeMode === "min")}
              title="刷新最新链上 tick"
            >
              ↻ 刷新 tick
            </button>
            <button
              className={`btn-ghost btn-xs ${
                isFlipped ? "border-cyan-400/50 text-cyan-300" : ""
              }`}
              disabled={busy}
              onClick={handleFlipInMint}
              title="翻转主币/计价币方向（同步切换默认投入代币）"
            >
              {isFlipped ? "🔄 已翻转" : "🔄 翻转"}
            </button>
            {data.dex ? (
              <span className="tag-ok">{data.dex.name}</span>
            ) : (
              <span className="tag-warn">未匹配 DEX</span>
            )}
            {data.matchedStaking?.length > 0 ? (
              <>
                <span className="tag-info">
                  质押 →{" "}
                  {data.matchedStaking[0].pair_label ||
                    data.matchedStaking[0].platform}
                </span>
                {data.approvals?.nftApprovedForAll ? (
                  <span className="inline-flex items-center gap-1 rounded bg-emerald-500/15 px-2 py-0.5 text-[11px] text-emerald-200 border border-emerald-500/30">
                    ⚡ 已开启 NFT 免签质押
                    <button
                      type="button"
                      className="ml-1 underline text-ink-muted hover:text-rose-300"
                      disabled={togglingAllApprove}
                      onClick={() => handleToggleApprovalForAll(false)}
                    >
                      撤销
                    </button>
                  </span>
                ) : (
                  <button
                    type="button"
                    className="btn-secondary btn-xs"
                    disabled={togglingAllApprove}
                    onClick={() => handleToggleApprovalForAll(true)}
                    title="对当前质押合约开启一次 setApprovalForAll，以后每次建仓后直接质押，省去单独授权 NFT 的钱包签名"
                  >
                    {togglingAllApprove
                      ? "授权中…"
                      : "⚡ 开启 NFT 免签质押 (省一步签名)"}
                  </button>
                )}
              </>
            ) : (
              <span className="text-ink-muted">（该交易对无质押平台）</span>
            )}
          </div>

          {/* ==================== Module ⑧：双模式窗口选择器（模式A 最小单格 vs 模式B 0~现价略高） ==================== */}
          <div className="rounded-lg border border-white/[0.1] bg-surface-0/70 p-2.5 space-y-2">
            <div className="grid grid-cols-2 gap-1.5">
              <button
                type="button"
                disabled={busy}
                onClick={() => applyMinWindowMode(false)}
                className={`rounded-lg border px-2.5 py-1.5 text-left transition ${
                  rangeMode === "min"
                    ? "border-cyan-400 bg-cyan-500/20 text-white shadow-[0_0_10px_rgba(34,211,238,0.2)]"
                    : "border-white/[0.1] bg-surface-1/60 text-ink-soft hover:text-ink"
                }`}
              >
                <div className="font-semibold text-xs">
                  ⚡ 模式 A：最小区间 (单格冲锋)
                </div>
                <div className="text-[10px] opacity-80">
                  1 格 tickSpacing · 集中吃满 60% 活跃 L 奖池
                </div>
              </button>

              <button
                type="button"
                disabled={busy}
                onClick={() => applyZeroToAboveMode(zeroAboveExtraTicks)}
                className={`rounded-lg border px-2.5 py-1.5 text-left transition ${
                  rangeMode === "zero_to_above"
                    ? "border-amber-400 bg-amber-500/20 text-white shadow-[0_0_10px_rgba(245,158,11,0.2)]"
                    : "border-white/[0.1] bg-surface-1/60 text-ink-soft hover:text-ink"
                }`}
              >
                <div className="font-semibold text-xs">
                  🛡️ 模式 B：0 ~ 现价略高 (重U少主币)
                </div>
                <div className="text-[10px] opacity-80">
                  98%+ 稳定币 + 少量 {isFlipped ? sym1 : sym0} · 下跌永不越界
                </div>
              </button>
            </div>

            {/* 模式专属快捷按钮 */}
            {rangeMode === "min" ? (
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="text-ink-soft">单格对齐：</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => applyMinWindowMode(false)}
                  className="btn-ghost btn-xs border border-cyan-500/35 text-cyan-200"
                >
                  🎯 按链上现价单格
                </button>
                {liveCex && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => applyMinWindowMode(true)}
                    className="btn-ghost btn-xs border border-amber-400/40 text-amber-200"
                    title={`按币安实时隐含 Tick (${liveCex.impliedTick}) 对齐最小单格`}
                  >
                    ⚡ 按币安实时价单格 (Tick {liveCex.impliedTick})
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-1">
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-amber-200 font-medium">
                    上界高出现价：
                  </span>
                  {[
                    { k: 0, label: "当前格上界" },
                    { k: 1, label: "高 1 格 (+0.6%)" },
                    { k: 3, label: "高 3 格 (+1.8% · 推荐)" },
                    { k: 5, label: "高 5 格 (+3.0%)" },
                  ].map((opt) => (
                    <button
                      key={opt.k}
                      type="button"
                      disabled={busy}
                      onClick={() => applyZeroToAboveMode(opt.k)}
                      className={`rounded border px-2 py-0.5 font-mono text-[11px] transition ${
                        zeroAboveExtraTicks === opt.k
                          ? "border-amber-400 bg-amber-500/25 text-amber-100 font-semibold"
                          : "border-white/[0.12] bg-surface-1 text-ink-soft hover:text-ink"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
                <div className="text-[10.5px] text-amber-100/80">
                  💡 <strong>重U少0G原理</strong>：下界锁定价格 0（Tick{" "}
                  {!isFlipped ? "-887220" : "+887220"}），上界比现价高{" "}
                  {zeroAboveExtraTicks} 格。只需投入大量{" "}
                  <span className="font-mono font-semibold text-white">
                    {!isFlipped ? sym1 : sym0}
                  </span>{" "}
                  + 极少量{" "}
                  <span className="font-mono font-semibold text-white">
                    {!isFlipped ? sym0 : sym1}
                  </span>
                  ，既在区间内吃补贴，且主币下跌时永远不会向下越界！
                </div>
              </div>
            )}

            {/* 精确 Tick 输入行 */}
            <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
              <span className="text-ink-soft shrink-0">Tick 区间</span>
              <input
                className="input !w-[98px] px-2 py-1 font-mono"
                value={tickLower}
                onChange={(e) => setTickLower(e.target.value)}
                placeholder="tickLower"
              />
              <span>~</span>
              <input
                className="input !w-[98px] px-2 py-1 font-mono"
                value={tickUpper}
                onChange={(e) => setTickUpper(e.target.value)}
                placeholder="tickUpper"
              />
              <button
                className="btn-ghost btn-xs"
                disabled={busy}
                onClick={() =>
                  fetchPool({ withCompute: !!amount, withWallet: !!address })
                }
              >
                应用区间
              </button>
            </div>
          </div>

          {/* 金额输入（自动计算另一侧；若已翻转则主币排第一） */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft shrink-0">投入</span>
            <select
              className="input !w-auto min-w-[82px] max-w-[125px] py-1 pl-2 pr-5 font-semibold"
              value={side}
              onChange={(e) => setSide(e.target.value as "token0" | "token1")}
            >
              {isFlipped ? (
                <>
                  <option value="token1">{sym1} (主币)</option>
                  <option value="token0">{sym0} (U)</option>
                </>
              ) : (
                <>
                  <option value="token0">{sym0}</option>
                  <option value="token1">{sym1}</option>
                </>
              )}
            </select>
            <input
              className="input !w-[140px] px-2 py-1 font-mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="输入数量"
            />
            {data.balances && (
              <span className="text-ink-soft font-mono text-[11px]">
                余额:{" "}
                {isFlipped ? (
                  <>
                    {sym1} {fmtTokenAmount(Number(data.balances.token1Human))} ·{" "}
                    {sym0} {fmtTokenAmount(Number(data.balances.token0Human))}
                  </>
                ) : (
                  <>
                    {sym0} {fmtTokenAmount(Number(data.balances.token0Human))} ·{" "}
                    {sym1} {fmtTokenAmount(Number(data.balances.token1Human))}
                  </>
                )}
              </span>
            )}
            {busy && <span className="text-cyan-300">计算中…</span>}
          </div>

          {/* 计算结果 + 授权状态（按翻转顺序展示主币在前） */}
          {data.compute && (
            <div className="rounded-lg border border-white/[0.1] bg-surface-card p-3 space-y-1">
              {isFlipped ? (
                <>
                  <div>
                    需要 {sym1}:{" "}
                    <strong className="font-mono text-ink">
                      {fmtTokenAmount(Number(data.compute.amount1Human))}
                    </strong>
                    {tokenPricesUsd.p1 > 0 && (
                      <span className="ml-1 font-mono text-ink-soft">
                        (≈ $
                        {(
                          Number(data.compute.amount1Human) * tokenPricesUsd.p1
                        ).toFixed(1)}
                        )
                      </span>
                    )}
                    {data.approvals?.token1?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                  <div>
                    需要 {sym0}:{" "}
                    <strong className="font-mono text-ink">
                      {fmtTokenAmount(Number(data.compute.amount0Human))}
                    </strong>
                    {tokenPricesUsd.p0 > 0 && (
                      <span className="ml-1 font-mono text-ink-soft">
                        (≈ $
                        {(
                          Number(data.compute.amount0Human) * tokenPricesUsd.p0
                        ).toFixed(1)}
                        )
                      </span>
                    )}
                    {data.approvals?.token0?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                </>
              ) : (
                <>
                  <div>
                    需要 {sym0}:{" "}
                    <strong className="font-mono text-ink">
                      {fmtTokenAmount(Number(data.compute.amount0Human))}
                    </strong>
                    {tokenPricesUsd.p0 > 0 && (
                      <span className="ml-1 font-mono text-ink-soft">
                        (≈ $
                        {(
                          Number(data.compute.amount0Human) * tokenPricesUsd.p0
                        ).toFixed(1)}
                        )
                      </span>
                    )}
                    {data.approvals?.token0?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                  <div>
                    需要 {sym1}:{" "}
                    <strong className="font-mono text-ink">
                      {fmtTokenAmount(Number(data.compute.amount1Human))}
                    </strong>
                    {tokenPricesUsd.p1 > 0 && (
                      <span className="ml-1 font-mono text-ink-soft">
                        (≈ $
                        {(
                          Number(data.compute.amount1Human) * tokenPricesUsd.p1
                        ).toFixed(1)}
                        )
                      </span>
                    )}
                    {data.approvals?.token1?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                </>
              )}

              {(data.compute.stakedShareAfter !== undefined ||
                data.compute.shareInPool !== undefined ||
                data.compute.shareAfter !== undefined) && (
                <div className="mt-1.5 border-t border-white/[0.08] pt-1.5 space-y-1">
                  {data.compute.stakedShareAfter !== undefined && (
                    <div>
                      质押仓位活跃L占比：
                      <strong className="text-cyan-300 font-mono">
                        {(data.compute.stakedShareAfter * 100).toFixed(2)}%
                      </strong>
                      <span className="ml-1 text-ink-soft">
                        （当前窗口质押{" "}
                        {abbrevLiquidity(data.compute.stakedLiquidity)}
                        {data.compute.stakedPositionCount !== undefined
                          ? ` · ${data.compute.stakedPositionCount} 仓`
                          : ""}
                        ，你的 {abbrevLiquidity(data.compute.liquidity)}）
                      </span>
                    </div>
                  )}
                  {data.compute.shareInPool !== undefined && (
                    <div>
                      窗口总流动性占比
                      {data.compute.stakedShareAfter !== undefined
                        ? "（含未质押）"
                        : ""}
                      ：
                      <strong className="text-ok font-mono">
                        {(data.compute.shareInPool * 100).toFixed(2)}%
                      </strong>
                      <span className="ml-1 text-ink-soft">
                        （全池窗口{" "}
                        {abbrevLiquidity(data.compute.poolLiquidity)}，你的{" "}
                        {abbrevLiquidity(data.compute.liquidity)}）
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* ==================== Module ⑧：开仓实时质押收益模拟器 & 双模式对比表 ==================== */}
          {poolRadar && currentRangeSim && (
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-2.5 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-1">
                <span className="font-semibold text-ink">
                  🧮 建仓预计质押收益模拟（按本金 ≈ $
                  {effectiveSimUsd.toFixed(0)}）
                </span>
                {!data.compute && (
                  <div className="inline-flex items-center gap-1 font-mono text-[10px]">
                    <span className="text-ink-soft">模拟本金:</span>
                    {[500, 1000, 2000, 5000].map((u) => (
                      <button
                        key={u}
                        type="button"
                        onClick={() => setSimCapitalUsd(u)}
                        className={`rounded px-1.5 py-0.5 ${
                          simCapitalUsd === u
                            ? "bg-emerald-500/30 text-emerald-100 font-bold border border-emerald-400/40"
                            : "bg-white/[0.08] text-ink-soft hover:text-ink"
                        }`}
                      >
                        ${u}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* 当前选中区间的预计产出 */}
              <div className="grid grid-cols-3 gap-1.5 font-mono text-[11px]">
                <div className="rounded bg-surface-0/70 px-2 py-1">
                  <div className="font-sans text-[10px] text-ink-soft">
                    ⏱ 预计每小时
                  </div>
                  <div className="font-semibold text-emerald-300">
                    ${currentRangeSim.hourlyUsd.toFixed(2)}/h
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    {currentRangeSim.hourlyW0g.toFixed(2)} W0G
                  </div>
                </div>
                <div className="rounded bg-surface-0/70 px-2 py-1">
                  <div className="font-sans text-[10px] text-ink-soft">
                    📅 预计每天
                  </div>
                  <div className="font-semibold text-emerald-300">
                    ${currentRangeSim.dailyUsd.toFixed(2)}/d
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    {currentRangeSim.dailyW0g.toFixed(1)} W0G
                  </div>
                </div>
                <div className="rounded bg-surface-0/70 px-2 py-1">
                  <div className="font-sans text-[10px] text-ink-soft">
                    🔥 预计综合 APR
                  </div>
                  <div className="font-bold text-amber-300">
                    {currentRangeSim.aprPct.toFixed(0)}%
                  </div>
                  <div className="text-[10px] text-ink-soft">
                    综合分 {(currentRangeSim.rewardShare * 100).toFixed(2)}%
                  </div>
                </div>
              </div>

              {/* 模式A vs 模式B 策略对比表（点击任意行即可一键切换区间） */}
              {strategyComparison.length > 0 && (
                <div className="overflow-x-auto rounded border border-white/[0.08] bg-surface-0/70">
                  <table className="w-full text-left text-[10.5px] font-mono">
                    <thead className="border-b border-white/[0.08] bg-white/[0.04] font-sans text-ink-soft">
                      <tr>
                        <th className="px-2 py-1">策略模式 (点击直接套用)</th>
                        <th className="px-2 py-1">代币配比</th>
                        <th className="px-2 py-1">日产 USD</th>
                        <th className="px-2 py-1">预计 APR</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.06]">
                      {strategyComparison.map((row) => {
                        const isRowActive =
                          Number(tickLower) === row.sim.tl &&
                          Number(tickUpper) === row.sim.tu;
                        return (
                          <tr
                            key={row.id}
                            onClick={() => {
                              if (row.mode === "min") {
                                applyMinWindowMode(false);
                              } else {
                                applyZeroToAboveMode(row.extraTicks ?? 3);
                              }
                            }}
                            className={`cursor-pointer transition ${
                              isRowActive
                                ? "bg-cyan-500/20 text-white"
                                : "hover:bg-white/[0.05] text-ink"
                            }`}
                          >
                            <td className="px-2 py-1 font-sans">
                              <div className="font-semibold">{row.title}</div>
                              <div className="text-[9.5px] text-ink-soft">
                                [{row.sim.tl}, {row.sim.tu}] · {row.badge}
                              </div>
                            </td>
                            <td className="px-2 py-1">
                              <div>
                                {sym0}: {fmtTokenAmount(row.sim.amt0)} (
                                {row.sim.pct0.toFixed(0)}%)
                              </div>
                              <div className="text-cyan-200">
                                {sym1}: {fmtTokenAmount(row.sim.amt1)} (
                                {row.sim.pct1.toFixed(0)}%)
                              </div>
                            </td>
                            <td className="px-2 py-1 text-emerald-300 font-semibold">
                              ${row.sim.dailyUsd.toFixed(2)}/d
                              <div className="text-[9.5px] font-normal text-ink-soft">
                                {row.sim.dailyW0g.toFixed(1)} W0G
                              </div>
                            </td>
                            <td className="px-2 py-1 font-bold text-amber-300">
                              {row.sim.aprPct.toFixed(0)}%
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          <button
            className="btn-primary text-xs w-full py-2 font-semibold"
            disabled={busy || !data.compute || !data.dex}
            onClick={execute}
          >
            {address
              ? busy
                ? "执行中…"
                : data.matchedStaking?.length > 0
                  ? `🚀 创建仓位并自动质押 (${rangeMode === "min" ? "最小单格" : "0~现价略高"})`
                  : "🚀 创建仓位"
              : "连接钱包"}
          </button>

          {steps.length > 0 && (
            <div className="space-y-1 pt-1">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span>
                    {s.status === "done"
                      ? "✅"
                      : s.status === "skipped"
                        ? "⏭️"
                        : s.status === "loading"
                          ? "⏳"
                          : s.status === "error"
                            ? "❌"
                            : "○"}
                  </span>
                  <span
                    className={
                      s.status === "skipped"
                        ? "text-ink-muted line-through"
                        : "text-ink"
                    }
                  >
                    {s.label}
                  </span>
                  {s.hash && (
                    <span className="font-mono text-ink-soft">
                      {s.hash.slice(0, 10)}…
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {msg && <p className="mt-2 text-ink">{msg}</p>}
    </div>
  );
}

/** 把大整数 liquidity 缩写成可读形式 */
function abbrevLiquidity(v?: string): string {
  if (!v) return "0";
  try {
    const n = BigInt(v);
    if (n === 0n) return "0";
    const s = n.toString();
    const units: [number, string][] = [
      [18, "Q"],
      [15, "P"],
      [12, "T"],
      [9, "B"],
      [6, "M"],
      [3, "K"],
    ];
    for (const [exp, suffix] of units) {
      if (s.length > exp) {
        const intPart = s.slice(0, s.length - exp);
        const frac = s
          .slice(s.length - exp, s.length - exp + 2)
          .replace(/0+$/, "");
        return `${intPart}${frac ? "." + frac : ""}${suffix}`;
      }
    }
    return s;
  } catch {
    return v;
  }
}
