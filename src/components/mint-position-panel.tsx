"use client";
/**
 * 直接创建 LP 仓位面板（最小 tickSpacing 窗口）+ 自动质押。
 *
 * 1. 读取池子的翻转状态（pairFlip）：若已翻转（如 ETH/USDC.e 中 token1=ETH 为主币），
 *    自动将默认投入币种切为 token1（ETH），下拉框与计算结果均按主币优先展示。
 * 2. 支持 ZIA DEX 一键开启 NFT 全局免签质押（setApprovalForAll）+ 质押前链上校验 verifyNftPoolMatch，
 *    让原本 2~4 步签名压缩到 1~2 步。
 */
import { useState, useEffect, useCallback, useRef } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, fmtFull } from "./util";
import {
  useWallet,
  verifyNftPoolMatch,
  extractMintedTokenIdFromReceipt,
} from "@/lib/wallet/use-wallet";
import {
  buildApproveCalldata,
  buildMintCalldata,
  buildNftApproveCalldata,
  buildSetApprovalForAllCalldata,
  buildStakeDepositCalldata,
  MAX_UINT256,
} from "@/lib/wallet/build-mint";

interface Props {
  chainId: number;
  pool: string;
  externalData?: any;
  probeLoading?: boolean;
  onClose?: () => void;
  onCreated?: () => void;
  onFlipChanged?: () => void;
}

export function MintPositionPanel({
  chainId: initialChainId,
  pool: initialPool,
  externalData,
  probeLoading,
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

  /** 刷新 tick（LP 波动快时用，默认对齐最新最小窗口） */
  async function refreshTick(useMinWindow = false) {
    if (useMinWindow) {
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

  /** 快捷预设：以当前 tick 为中心的对称区间 */
  async function applyPreset(pct: number) {
    if (!data) return;
    const spacing = data.pool.tickSpacing;
    const current = data.pool.currentTick;
    if (pct === 0) {
      // 最小窗口
      const lower = Math.floor(current / spacing) * spacing;
      const upper = lower + spacing;
      await fetchPool({
        range: { tick_lower: lower, tick_upper: upper },
        withCompute: !!amount,
        withWallet: !!address,
      });
      return;
    }
    const delta = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
    const lower = Math.floor((current - delta) / spacing) * spacing;
    const upper = Math.ceil((current + delta) / spacing) * spacing;
    await fetchPool({
      range: { tick_lower: lower, tick_upper: upper },
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
      tx: { to: string; data: string },
      label: string
    ): Promise<string> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await sendTx(tx);
        } catch (e: any) {
          if (attempt === 3) throw e;
          const shouldRetry = confirm(
            `${label} 失败：${e?.message ?? e}\n\n是否重试（第 ${attempt + 1}/3 次）？`
          );
          if (!shouldRetry) throw e;
        }
      }
      throw new Error("unreachable");
    };

    try {
      await switchChain(data.chain.chain_id);

      const beforeIds = await listOwnedTokenIds(npm, address);

      // Step 1: approve token0
      if (!skip0) {
        setStep(0, { status: "loading" });
        const a0 = buildApproveCalldata(data.pool.token0, npm, MAX_UINT256);
        const h0 = await sendWithRetry(a0, `授权 ${data.pool.token0Symbol}`);
        setStep(0, { status: "done", hash: h0 });
        await new Promise((r) => setTimeout(r, 1200));
      }

      // Step 2: approve token1
      if (!skip1) {
        setStep(1, { status: "loading" });
        const a1 = buildApproveCalldata(data.pool.token1, npm, MAX_UINT256);
        const h1 = await sendWithRetry(a1, `授权 ${data.pool.token1Symbol}`);
        setStep(1, { status: "done", hash: h1 });
        await new Promise((r) => setTimeout(r, 1200));
      }

      // Step 3: mint
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
      const tokenIdBig =
        (await extractMintedTokenIdFromReceipt(hm, address, npm)) ??
        (await diffNewTokenId(npm, address, beforeIds));
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
            // 安全护栏：质押前链上读取 positions(tokenId)，确认 token0/token1/fee 与当前池一致
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

            // 如果尚未开启 setApprovalForAll，才需要单次 approve(staker, tokenId)
            if (!nftApprovedAll) {
              const approveNft = buildNftApproveCalldata(npm, staker, tokenIdBig);
              await sendWithRetry(approveNft, "授权 NFT 给质押合约");
              await new Promise((r) => setTimeout(r, 1500));
            }
            const dep = buildStakeDepositCalldata(staker, tokenIdBig);
            const hd = await sendWithRetry(dep, "质押");
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

  /** 列举钱包当前在 NPM 上持有的全部 tokenId */
  async function listOwnedTokenIds(
    npm: string,
    owner: string
  ): Promise<Set<string>> {
    const out = new Set<string>();
    const p = (window as any).okxwallet || (window as any).ethereum;
    if (!p) return out;
    try {
      const ownerPad = owner.toLowerCase().replace(/^0x/, "").padStart(64, "0");
      const balHex = (await p.request({
        method: "eth_call",
        params: [{ to: npm, data: `0x70a08231${ownerPad}` }, "latest"],
      })) as string;
      const bal = Number(BigInt(balHex));
      const limit = Math.min(bal, 50);
      for (let i = 0; i < limit; i++) {
        const idxHex = BigInt(i).toString(16).padStart(64, "0");
        const idHex = (await p.request({
          method: "eth_call",
          params: [
            { to: npm, data: `0x2f745c59${ownerPad}${idxHex}` },
            "latest",
          ],
        })) as string;
        out.add(BigInt(idHex).toString());
      }
    } catch {
      /* ignore */
    }
    return out;
  }

  /** 兜底：对比 mint 前后的 tokenId 集合找出新增项 */
  async function diffNewTokenId(
    npm: string,
    owner: string,
    before: Set<string>
  ): Promise<bigint | null> {
    for (let i = 0; i < 5; i++) {
      const now = await listOwnedTokenIds(npm, owner);
      for (const id of now) {
        if (!before.has(id)) return BigInt(id);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
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

  return (
    <div className="panel-inset border-cyan-500/30 p-4 text-xs">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-semibold text-ink">
          ② ➕ 极速建仓 & 自动质押（最小区间）
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
              onClick={() => refreshTick(true)}
              title="刷新最新 tick 并将区间对齐到当前最小窗口"
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

          {/* 区间 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-ink-soft shrink-0">区间</span>
            <input
              className="input !w-[92px] px-2 py-1 font-mono"
              value={tickLower}
              onChange={(e) => setTickLower(e.target.value)}
              placeholder="tickLower"
            />
            <span>~</span>
            <input
              className="input !w-[92px] px-2 py-1 font-mono"
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
              应用
            </button>
            <span className="text-ink-soft ml-1">快捷</span>
            <button
              className="btn-ghost btn-xs"
              disabled={busy}
              onClick={() => applyPreset(0)}
            >
              最小窗口
            </button>
            <button
              className="btn-ghost btn-xs"
              disabled={busy}
              onClick={() => applyPreset(1)}
            >
              ±1%
            </button>
            <button
              className="btn-ghost btn-xs"
              disabled={busy}
              onClick={() => applyPreset(5)}
            >
              ±5%
            </button>
            <button
              className="btn-ghost btn-xs"
              disabled={busy}
              onClick={() => applyPreset(10)}
            >
              ±10%
            </button>
          </div>

          {/* 金额输入（自动计算另一侧；若已翻转则主币排第一） */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft shrink-0">投入</span>
            <select
              className="input !w-auto min-w-[82px] max-w-[115px] py-1 pl-2 pr-5 font-semibold"
              value={side}
              onChange={(e) => setSide(e.target.value as "token0" | "token1")}
            >
              {isFlipped ? (
                <>
                  <option value="token1">{sym1} (主币)</option>
                  <option value="token0">{sym0}</option>
                </>
              ) : (
                <>
                  <option value="token0">{sym0}</option>
                  <option value="token1">{sym1}</option>
                </>
              )}
            </select>
            <input
              className="input !w-[150px] px-2 py-1 font-mono"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="输入数量"
            />
            {data.balances && (
              <span className="text-ink-soft font-mono">
                余额:{" "}
                {isFlipped ? (
                  <>
                    {sym1} {Number(data.balances.token1Human).toFixed(4)} ·{" "}
                    {sym0} {Number(data.balances.token0Human).toFixed(4)}
                  </>
                ) : (
                  <>
                    {sym0} {Number(data.balances.token0Human).toFixed(4)} ·{" "}
                    {sym1} {Number(data.balances.token1Human).toFixed(4)}
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
                      {data.compute.amount1Human}
                    </strong>
                    {data.approvals?.token1?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                  <div>
                    需要 {sym0}:{" "}
                    <strong className="font-mono text-ink">
                      {data.compute.amount0Human}
                    </strong>
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
                      {data.compute.amount0Human}
                    </strong>
                    {data.approvals?.token0?.sufficient && (
                      <span className="ml-1.5 text-ok">
                        （已授权，跳过 approve）
                      </span>
                    )}
                  </div>
                  <div>
                    需要 {sym1}:{" "}
                    <strong className="font-mono text-ink">
                      {data.compute.amount1Human}
                    </strong>
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
                      质押仓位占比：
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
                      窗口流动性占比
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

          <button
            className="btn-primary text-xs"
            disabled={busy || !data.compute || !data.dex}
            onClick={execute}
          >
            {address
              ? busy
                ? "执行中…"
                : data.matchedStaking?.length > 0
                  ? "创建仓位并质押"
                  : "创建仓位"
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
