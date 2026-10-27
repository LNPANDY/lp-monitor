"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import useSWR from "swr";
import { useWallet } from "@/lib/wallet/use-wallet";
import { authHeaders, fetcher } from "./util";
import {
  buildMintCalldata,
  buildApproveCalldata,
  buildStakeDepositCalldata,
  buildNftApproveCalldata,
  MAX_UINT256,
} from "@/lib/wallet/build-mint";

/**
 * 创建流动性（mint）面板。
 *
 * 设计要点：
 *   - 独立入口：只需池子地址即可创建，不依赖探针检测结果
 *   - 自动计算：输入一侧金额后自动（防抖 600ms）算出另一侧，无需点按钮
 *   - 自动锁定：DEX 按池子 factory 精确匹配，质押合约按 token 对匹配，均不可手选
 *   - 智能授权：先查 allowance，额度足够则跳过 approve 步骤
 */
export function MintPositionPanel({
  chainId: initialChainId,
  pool: initialPool,
  onClose,
}: {
  chainId: number;
  pool?: string;
  onClose?: () => void;
}) {
  const { address, sendTx, switchChain, connect } = useWallet();
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState(initialChainId || 0);
  const [pool, setPool] = useState(initialPool ?? "");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [data, setData] = useState<any>(null);
  const [tickLower, setTickLower] = useState("");
  const [tickUpper, setTickUpper] = useState("");
  const [side, setSide] = useState<"token0" | "token1">("token0");
  const [amount, setAmount] = useState("");
  const [steps, setSteps] = useState<{ label: string; status: "pending" | "loading" | "done" | "skipped" | "error"; hash?: string }[]>([]);

  /** 拉取池子状态（可带区间/金额/钱包，后端自动算另一侧 + 查授权） */
  const fetchPool = useCallback(async (opts?: {
    range?: { tick_lower?: number; tick_upper?: number };
    withCompute?: boolean;
    withWallet?: boolean;
  }) => {
    if (!pool || !/^0x[a-fA-F0-9]{40}$/.test(pool)) {
      setMsg("请输入有效的池子地址");
      return;
    }
    setBusy(true); setMsg("");
    try {
      const body: any = { chain_id: chainId, pool };
      if (opts?.withWallet && address) body.wallet = address;
      if (opts?.withCompute && amount) {
        body.input_side = side;
        body.input_amount = amount;
      }
      // 区间：优先用传入的，其次用当前输入框的值
      const rl = opts?.range?.tick_lower ?? (tickLower ? Number(tickLower) : undefined);
      const ru = opts?.range?.tick_upper ?? (tickUpper ? Number(tickUpper) : undefined);
      if (rl !== undefined && ru !== undefined) {
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
      setData(j.data);
      // 首次加载时同步 tick 输入框
      if (opts?.range || !tickLower) {
        setTickLower(String(j.data.range.tickLower));
        setTickUpper(String(j.data.range.tickUpper));
      }
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }, [chainId, pool, address, amount, side, tickLower, tickUpper]);

  /** 初始加载：池子已给定则自动拉取 */
  useEffect(() => {
    if (initialPool) fetchPool();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 金额/侧向变化时自动重算（防抖 600ms），无需点按钮 */
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!data || !amount) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      fetchPool({ withCompute: true, withWallet: !!address });
    }, 600);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [amount, side]);

  /** 钱包连接状态变化时刷新一次，拿到最新的授权额度 */
  useEffect(() => {
    if (!data || !address) return;
    fetchPool({ withCompute: !!amount, withWallet: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  /** 刷新 tick（LP 波动快时用） */
  async function refreshTick() {
    await fetchPool({
      range: { tick_lower: Number(tickLower), tick_upper: Number(tickUpper) },
      withCompute: !!amount,
      withWallet: !!address,
    });
  }

  /** 快捷预设：以当前 tick 为中心的对称区间 */
  async function applyPreset(pct: number) {
    if (!data) return;
    const spacing = data.pool.tickSpacing;
    const current = data.pool.currentTick;
    const delta = Math.round(Math.log(1 + pct / 100) / Math.log(1.0001));
    const lower = Math.floor((current - delta) / spacing) * spacing;
    const upper = Math.ceil((current + delta) / spacing) * spacing;
    await fetchPool({ range: { tick_lower: lower, tick_upper: upper }, withCompute: !!amount, withWallet: !!address });
  }

  /** 执行创建流程 */
  async function execute() {
    if (!address) { await connect(); return; }
    if (!data?.compute) { setMsg("❌ 请先输入金额"); return; }
    if (!data.dex) { setMsg("❌ 未能匹配到池子所属 DEX（请在配置页添加对应 DEX）"); return; }

    setBusy(true); setMsg("");
    const npm = data.dex.npm;
    const staker = data.matchedStaking?.[0]?.contract ?? "";
    const need0 = BigInt(data.compute.amount0);
    const need1 = BigInt(data.compute.amount1);
    const appr = data.approvals;

    // 根据授权状态决定是否需要 approve（额度足够则跳过）
    const skip0 = appr?.token0?.sufficient ?? false;
    const skip1 = appr?.token1?.sufficient ?? false;

    const flow: typeof steps = [
      { label: `授权 ${data.pool.token0Symbol || "token0"}`, status: skip0 ? "skipped" : "pending" },
      { label: `授权 ${data.pool.token1Symbol || "token1"}`, status: skip1 ? "skipped" : "pending" },
      { label: "创建仓位 (mint)", status: "pending" },
      ...(staker ? [{ label: `质押到 ${data.matchedStaking[0].pair_label || data.matchedStaking[0].platform}`, status: "pending" as const }] : []),
    ];
    setSteps(flow);

    const setStep = (i: number, patch: Partial<(typeof steps)[0]>) =>
      setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

    /** 带重试的发送：用户取消或失败时询问是否重试（最多 3 次） */
    const sendWithRetry = async (tx: { to: string; data: string }, label: string): Promise<string> => {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          return await sendTx(tx);
        } catch (e: any) {
          if (attempt === 3) throw e;
          const shouldRetry = confirm(`${label} 失败：${e?.message ?? e}\n\n是否重试（第 ${attempt + 1}/3 次）？`);
          if (!shouldRetry) throw e;
        }
      }
      throw new Error("unreachable");
    };

    try {
      await switchChain(data.chain.chain_id);

      // mint 前记录钱包已有的 tokenId 集合（余额对比法的基准）
      const beforeIds = await listOwnedTokenIds(npm, address);

      // Step 1: approve token0（额度够则跳过）
      if (!skip0) {
        setStep(0, { status: "loading" });
        const a0 = buildApproveCalldata(data.pool.token0, npm, MAX_UINT256);
        const h0 = await sendWithRetry(a0, `授权 ${data.pool.token0Symbol}`);
        setStep(0, { status: "done", hash: h0 });
        await new Promise((r) => setTimeout(r, 1200));
      }

      // Step 2: approve token1（额度够则跳过）
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
      // tokenId 三级解析：回执事件 → 余额对比 diff → 失败提示手动
      const tokenId = (await waitForMintTokenId(npm, address, hm))
        ?? (await diffNewTokenId(npm, address, beforeIds));
      setStep(2, { status: "done", hash: hm });

      // Step 4: 质押（自动匹配到才做）
      if (staker) {
        if (!tokenId) {
          setStep(3, { status: "error" });
          setMsg(`✅ 仓位已创建（未能解析 tokenId，请手动质押）`);
        } else {
          setStep(3, { status: "loading" });
          try {
            // 质押 = approve NFT + deposit，每步带重试；用户在重试弹窗拒绝则整体抛出
            const approveNft = buildNftApproveCalldata(npm, staker, tokenId);
            await sendWithRetry(approveNft, "授权 NFT 给质押合约");
            await new Promise((r) => setTimeout(r, 1500));
            const dep = buildStakeDepositCalldata(staker, tokenId);
            const hd = await sendWithRetry(dep, "质押");
            setStep(3, { status: "done", hash: hd });
            setMsg(`✅ 创建并质押成功！tokenId=${tokenId}`);
          } catch (e: any) {
            setStep(3, { status: "error" });
            setMsg(`⚠️ 仓位已创建（tokenId=${tokenId}），质押未完成：${e?.message ?? e}\n可刷新面板后到仓位卡片单独质押`);
          }
        }
      } else {
        setMsg(`✅ 仓位创建成功${tokenId ? `，tokenId=${tokenId}` : ""}`);
      }
    } catch (e: any) {
      setSteps((prev) => prev.map((s) => (s.status === "loading" ? { ...s, status: "error" } : s)));
      setMsg(`❌ ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  /** 查询钱包在 NPM 上最新的 tokenId（mint 后用于质押） */
  /**
   * 等 mint 交易回执，从 Transfer(from=0x0, to=钱包) 事件解析 tokenId。
   *
   * ERC721 mint 必然发出 Transfer(address(0) → recipient, tokenId) 事件，
   * 这是获取"本次 mint 的 tokenId"唯一可靠的方式。
   *
   * 轮询 eth_getTransactionReceipt 直到 status=0x1 且含目标事件，超时 60 秒。
   * 失败回退：尝试 tokenOfOwnerByIndex（最后一次 mint 的兜底，可能不准）。
   */

  /**
   * 枚举钱包在 NPM 上持有的全部 tokenId（ERC721 Enumerable，上限 50 个防 RPC 爆炸）。
   * 失败返回 null（余额对比法不可用时由调用方处理）。
   */
  async function listOwnedTokenIds(npm: string, owner: string): Promise<Set<string> | null> {
    try {
      const provider = (window as any).okxwallet || (window as any).ethereum;
      if (!provider) return null;
      const call = (data: string) => provider.request({ method: "eth_call", params: [{ to: npm, data }, "latest"] });
      const pad = (v: string) => v.toLowerCase().replace("0x", "").padStart(64, "0");
      const balData = "0x70a08231" + pad(owner);
      const bal = BigInt(await call(balData));
      if (bal === 0n) return new Set();
      const ids = new Set<string>();
      // 扫描策略：新 mint 的 tokenId 位于最大 index（Enumerable 追加在尾部），
      // 先扫尾部 20 个（够 diff 出新 id），不足再补头部
      const tailScan = bal > 20n ? 20n : bal;
      for (let i = bal - 1n; i >= bal - tailScan; i--) {
        try {
          const idData = "0x2f745c59" + pad(owner) + i.toString(16).padStart(64, "0");
          ids.add(BigInt(await call(idData)).toString());
        } catch { break; }
      }
      return ids;
    } catch {
      return null;
    }
  }

  /**
   * 余额对比法：mint 后轮询钱包 tokenId 集合，diff 出新出现的那个。
   * 适用于 OKX 等 eth_getTransactionReceipt 拿不到回执的钱包。
   * 轮询 30 秒。
   */
  async function diffNewTokenId(npm: string, owner: string, before: Set<string> | null): Promise<bigint | null> {
    if (!before) return null;
    const start = Date.now();
    while (Date.now() - start < 30_000) {
      const now = await listOwnedTokenIds(npm, owner);
      if (now) {
        for (const id of now) {
          if (!before.has(id)) return BigInt(id);
        }
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  }

  async function waitForMintTokenId(npm: string, owner: string, txHash: string): Promise<bigint | null> {
    const provider = (window as any).okxwallet || (window as any).ethereum;
    if (!provider) return null;
    const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    const fromZeroTopic = "0x" + "0".repeat(64);
    const toTopic = "0x" + owner.toLowerCase().replace("0x", "").padStart(64, "0");
    const start = Date.now();

    while (Date.now() - start < 60_000) {
      try {
        const receipt = await provider.request({ method: "eth_getTransactionReceipt", params: [txHash] });
        if (receipt && (receipt as any).status === "0x1") {
          const logs = (receipt as any).logs ?? [];
          for (const log of logs) {
            if ((log.address ?? "").toLowerCase() !== npm.toLowerCase()) continue;
            const topics: string[] = log.topics ?? [];
            if (topics[0] !== TRANSFER_TOPIC) continue;
            if (topics[1] !== fromZeroTopic) continue;
            if (topics[2] !== toTopic) continue;
            // 标准 ERC721 Transfer：from/to/tokenId 全部 indexed，
            // tokenId 在 topics[3]（data 为空）
            if (topics.length > 3) {
              const tokenId = BigInt(topics[3]);
              if (tokenId > 0n) return tokenId;
            }
          }
          // 回执成功但没找到事件（不应该发生），跳出轮询
          return null;
        }
      } catch {
        // 轮询失败继续等
      }
      await new Promise((r) => setTimeout(r, 1200));
    }
    return null;
  }

  return (
    <div className="rounded border border-primary/30 bg-primary/5 p-3 text-xs">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">创建流动性</span>
        {onClose && <button className="text-xs text-ink-soft hover:text-ink" onClick={onClose}>关闭</button>}
      </div>

      {/* 未选池子时提示从收藏列表选择 */}
      {!data ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-ink-soft">链</span>
            <select
              className="input max-w-[150px]"
              value={chainId || ""}
              onChange={(e) => setChainId(Number(e.target.value))}
            >
              <option value="">选择链</option>
              {(chains ?? []).filter((c: any) => c.enabled).map((c: any) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
          {initialPool ? (
            <div className="text-ink-soft">
              已选择池子 <span className="font-mono">{initialPool.slice(0, 12)}…</span>
              {busy && <span className="ml-2">读取中…</span>}
            </div>
          ) : (
            <div className="rounded bg-brand-violet/10 p-2 text-brand-violet">
              👇 请在下方「收藏」列表点击一个交易对开始创建
            </div>
          )}
          {msg && <p>{msg}</p>}
        </div>
      ) : (
        <div className="space-y-2">
          {/* 池子信息 + DEX 自动锁定 */}
          <div className="flex flex-wrap items-center gap-2 text-ink-soft">
            <span>
              {data.pool.token0Symbol}/{data.pool.token1Symbol} · fee {(data.pool.fee / 10000).toFixed(2)}%
              · ts {data.pool.tickSpacing} · 当前 tick <strong className="text-ink">{data.pool.currentTick}</strong>
            </span>
            <button className="rounded bg-slate-200 px-1.5 py-0.5 hover:bg-slate-300" disabled={busy} onClick={refreshTick}>
              刷新 tick
            </button>
            {data.dex ? (
              <span className="rounded bg-ok/15 px-1.5 py-0.5 text-ok">
                {data.dex.name}
              </span>
            ) : (
              <span className="rounded bg-warn/20 px-1.5 py-0.5 text-warn">未匹配 DEX</span>
            )}
            {data.matchedStaking?.length > 0 ? (
              <span className="rounded bg-brand-violet/15 px-1.5 py-0.5 text-brand-violet">
                质押 → {data.matchedStaking[0].pair_label || data.matchedStaking[0].platform}
              </span>
            ) : (
              <span className="text-ink-soft">（该交易对无质押平台）</span>
            )}
          </div>

          {/* 区间 */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">区间</span>
            <input className="input max-w-[110px]" value={tickLower} onChange={(e) => setTickLower(e.target.value)} placeholder="tickLower" />
            <span>~</span>
            <input className="input max-w-[110px]" value={tickUpper} onChange={(e) => setTickUpper(e.target.value)} placeholder="tickUpper" />
            <button
              className="rounded bg-slate-200 px-1.5 py-0.5 hover:bg-slate-300"
              disabled={busy}
              onClick={() => fetchPool({ withCompute: !!amount, withWallet: !!address })}
            >
              应用
            </button>
            <span className="text-ink-soft">快捷</span>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(1)}>±1%</button>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(5)}>±5%</button>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(10)}>±10%</button>
          </div>

          {/* 金额输入（自动计算另一侧） */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">投入</span>
            <select className="input max-w-[110px]" value={side} onChange={(e) => setSide(e.target.value as any)}>
              <option value="token0">{data.pool.token0Symbol || "token0"}</option>
              <option value="token1">{data.pool.token1Symbol || "token1"}</option>
            </select>
            <input
              className="input max-w-[140px]"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="数量（自动算另一侧）"
            />
            {busy && <span className="text-ink-soft">计算中…</span>}
          </div>

          {/* 计算结果 + 授权状态 */}
          {data.compute && (
            <div className="rounded bg-white/60 p-2">
              <div>需要 {data.pool.token0Symbol}: <strong>{data.compute.amount0Human}</strong>
                {data.approvals?.token0?.sufficient && <span className="ml-1 text-emerald-600">（已授权，跳过 approve）</span>}
              </div>
              <div>需要 {data.pool.token1Symbol}: <strong>{data.compute.amount1Human}</strong>
                {data.approvals?.token1?.sufficient && <span className="ml-1 text-emerald-600">（已授权，跳过 approve）</span>}
              </div>
              {data.compute.shareAfter !== undefined && data.compute.shareAfter > 0 && (
                <div className="mt-1 border-t border-slate-200 pt-1">
                  <div>
                    添加后占比：<strong className="text-primary">{(data.compute.shareAfter * 100).toFixed(2)}%</strong>
                    <span className="ml-1 text-ink-soft">
                      （
                      {data.compute.stakedLiquidity && data.compute.stakedLiquidity !== "0"
                        ? `质押池窗口 ${abbrevLiquidity(data.compute.stakedLiquidity)}`
                        : `池子 ${abbrevLiquidity(data.compute.poolLiquidity)}`}
                      ，你的 {abbrevLiquidity(data.compute.liquidity)}）
                    </span>
                  </div>
                  {data.compute.shareInPool !== undefined && data.compute.shareInPool > 0 && data.compute.stakedLiquidity !== "0" && (
                    <div className="mt-0.5 text-ink-soft">
                      占整个池子活跃流动性 {abbrevLiquidity(data.compute.poolLiquidity)} 的{" "}
                      <strong className="text-emerald-700">{(data.compute.shareInPool * 100).toFixed(2)}%</strong>
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
            {address ? (busy ? "执行中…" : "创建仓位") : "连接钱包"}
          </button>

          {steps.length > 0 && (
            <div className="space-y-0.5">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span>{s.status === "done" ? "✅" : s.status === "skipped" ? "⏭️" : s.status === "loading" ? "⏳" : s.status === "error" ? "❌" : "○"}</span>
                  <span className={s.status === "skipped" ? "text-ink-soft line-through" : ""}>{s.label}</span>
                  {s.hash && <span className="font-mono text-ink-soft">{s.hash.slice(0, 10)}…</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {msg && <p className="mt-2">{msg}</p>}
    </div>
  );
}

/** 把大整数 liquidity 缩写成可读形式（1.23e18 → 1.23Q / 1.23T / 1.23B / 1.23M / 1.23K） */
function abbrevLiquidity(v?: string): string {
  if (!v) return "0";
  try {
    const n = BigInt(v);
    if (n === 0n) return "0";
    const s = n.toString();
    const units: [number, string][] = [
      [18, "Q"], [15, "P"], [12, "T"], [9, "B"], [6, "M"], [3, "K"],
    ];
    for (const [exp, suffix] of units) {
      if (s.length > exp) {
        const intPart = s.slice(0, s.length - exp);
        const frac = s.slice(s.length - exp, s.length - exp + 2).replace(/0+$/, "");
        return `${intPart}${frac ? "." + frac : ""}${suffix}`;
      }
    }
    return s;
  } catch {
    return v;
  }
}
