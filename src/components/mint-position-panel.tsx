"use client";
import { useState } from "react";
import { useWallet } from "@/lib/wallet/use-wallet";
import { authHeaders } from "./util";
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
 * 从探针/收藏池进入，带入 pool 地址。流程：
 *   1. 拉取池子状态（当前 tick、tickSpacing、默认最小窗口区间）
 *   2. 用户输入单侧金额 + 可选调整区间
 *   3. 自动反算另一侧金额和 liquidity
 *   4. 依次发：approve token0 → approve token1 → mint →（可选）质押 deposit
 */
export function MintPositionPanel({
  chainId,
  pool,
  onClose,
}: {
  chainId: number;
  pool: string;
  onClose?: () => void;
}) {
  const { address, sendTx, switchChain, connect } = useWallet();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [data, setData] = useState<any>(null);
  const [tickLower, setTickLower] = useState("");
  const [tickUpper, setTickUpper] = useState("");
  const [side, setSide] = useState<"token0" | "token1">("token0");
  const [amount, setAmount] = useState("");
  const [selectedNpm, setSelectedNpm] = useState("");
  const [selectedStaker, setSelectedStaker] = useState("");
  const [steps, setSteps] = useState<{ label: string; status: "pending" | "loading" | "done" | "error"; hash?: string }[]>([]);

  /** 拉取池子状态 + 反算 */
  async function refresh(overrideRange?: { tick_lower?: number; tick_upper?: number }) {
    setBusy(true); setMsg("");
    try {
      const body: any = {
        chain_id: chainId,
        pool,
        input_side: side,
        input_amount: amount,
      };
      if (overrideRange?.tick_lower !== undefined) body.tick_lower = overrideRange.tick_lower;
      if (overrideRange?.tick_upper !== undefined) body.tick_upper = overrideRange.tick_upper;
      // 若用户手动填了区间，用用户的
      if (tickLower && tickUpper && !overrideRange) {
        body.tick_lower = Number(tickLower);
        body.tick_upper = Number(tickUpper);
      }
      const r = await fetch("/api/liquidity-mint", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setData(j.data);
      setTickLower(String(j.data.range.tickLower));
      setTickUpper(String(j.data.range.tickUpper));
      if (!selectedNpm && j.data.dexes?.length) setSelectedNpm(j.data.dexes[0].npm);
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  /** 快速刷新当前 tick（LP 波动快时用） */
  async function refreshTick() {
    await refresh({ tick_lower: Number(tickLower), tick_upper: Number(tickUpper) });
  }

  /** 应用快捷预设：以当前 tick 为中心的对称区间 */
  async function applyPreset(pct: number) {
    if (!data) return;
    const spacing = data.pool.tickSpacing;
    const current = data.pool.currentTick;
    // ±pct% 价格 → tick 偏移（1 tick ≈ 0.01% 价格）
    const delta = Math.round((Math.log(1 + pct / 100) / Math.log(1.0001)));
    const lower = Math.floor((current - delta) / spacing) * spacing;
    const upper = Math.ceil((current + delta) / spacing) * spacing;
    await refresh({ tick_lower: lower, tick_upper: upper });
  }

  /** 执行完整创建流程 */
  async function execute() {
    if (!address) { await connect(); return; }
    if (!data?.compute) { setMsg("❌ 请先输入金额并计算"); return; }
    if (!selectedNpm) { setMsg("❌ 请选择 DEX"); return; }

    setBusy(true); setMsg("");
    const flow: typeof steps = [
      { label: `授权 ${data.pool.token0Symbol || "token0"}`, status: "pending" },
      { label: `授权 ${data.pool.token1Symbol || "token1"}`, status: "pending" },
      { label: "创建仓位 (mint)", status: "pending" },
      ...(selectedStaker ? [{ label: "质押", status: "pending" as const }] : []),
    ];
    setSteps(flow);

    const setStep = (i: number, patch: Partial<(typeof steps)[0]>) =>
      setSteps((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...patch } : s)));

    try {
      await switchChain(data.chain.chain_id);

      const amount0 = BigInt(data.compute.amount0);
      const amount1 = BigInt(data.compute.amount1);

      // Step 1: approve token0
      setStep(0, { status: "loading" });
      const a0 = buildApproveCalldata(data.pool.token0, selectedNpm, MAX_UINT256);
      const h0 = await sendTx(a0);
      setStep(0, { status: "done", hash: h0 });

      // Step 2: approve token1
      setStep(1, { status: "loading" });
      const a1 = buildApproveCalldata(data.pool.token1, selectedNpm, MAX_UINT256);
      const h1 = await sendTx(a1);
      setStep(1, { status: "done", hash: h1 });

      // Step 3: mint
      setStep(2, { status: "loading" });
      const mint = buildMintCalldata(selectedNpm, {
        token0: data.pool.token0,
        token1: data.pool.token1,
        fee: data.pool.fee,
        tickLower: Number(tickLower),
        tickUpper: Number(tickUpper),
        amount0Desired: amount0,
        amount1Desired: amount1,
        recipient: address,
        slippagePct: 0.5,
      });
      const hm = await sendTx(mint);
      setStep(2, { status: "done", hash: hm });

      // Step 4: 可选质押
      if (selectedStaker) {
        // mint 后需要拿到 tokenId：从 mint 回执的 Transfer 事件或查询最新的 tokenOfOwnerByIndex
        // 这里简化：等 1.5 秒后查钱包在该 NPM 的最后一个 NFT
        setStep(3, { status: "loading" });
        await new Promise((r) => setTimeout(r, 1500));
        const tokenId = await findLatestTokenId(selectedNpm, address);
        if (!tokenId) throw new Error("未能获取新仓位的 tokenId，请手动质押");
        // 先 approve NFT 给质押合约（ERC721 approve，不是 ERC20）
        const approveNft = buildNftApproveCalldata(selectedNpm, selectedStaker, tokenId);
        const ha = await sendTx(approveNft);
        await new Promise((r) => setTimeout(r, 1200));
        const dep = buildStakeDepositCalldata(selectedStaker, tokenId);
        const hd = await sendTx(dep);
        setStep(3, { status: "done", hash: hd });
        setMsg(`✅ 创建并质押成功！tokenId=${tokenId}`);
      } else {
        setMsg("✅ 仓位创建成功");
      }
    } catch (e: any) {
      setSteps((prev) => prev.map((s) => (s.status === "loading" ? { ...s, status: "error" } : s)));
      setMsg(`❌ ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  }

  /** 查询钱包在 NPM 上最新的 tokenId（mint 后用于质押） */
  async function findLatestTokenId(npm: string, owner: string): Promise<bigint | null> {
    try {
      const provider = (window as any).okxwallet || (window as any).ethereum;
      if (!provider) return null;
      // balanceOf(owner)
      const balData = "0x70a08231" + owner.toLowerCase().replace("0x", "").padStart(64, "0");
      const balHex = await provider.request({ method: "eth_call", params: [{ to: npm, data: balData }, "latest"] });
      const bal = BigInt(balHex);
      if (bal === 0n) return null;
      // tokenOfOwnerByIndex(owner, bal-1)
      const idxData = "0x2f745c59" + owner.toLowerCase().replace("0x", "").padStart(64, "0") + (bal - 1n).toString(16).padStart(64, "0");
      const idHex = await provider.request({ method: "eth_call", params: [{ to: npm, data: idxData }, "latest"] });
      return BigInt(idHex);
    } catch {
      return null;
    }
  }

  return (
    <div className="mt-3 rounded border border-primary/30 bg-primary/5 p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-sm font-medium">创建流动性</span>
        {onClose && <button className="text-xs text-ink-soft hover:text-ink" onClick={onClose}>关闭</button>}
      </div>

      {!data ? (
        <button className="btn-primary text-xs" disabled={busy} onClick={() => refresh()}>
          {busy ? "读取池子…" : "读取池子状态"}
        </button>
      ) : (
        <div className="space-y-2 text-xs">
          <div className="text-ink-soft">
            {data.pool.token0Symbol}/{data.pool.token1Symbol} · fee {(data.pool.fee / 10000).toFixed(2)}%
            · tickSpacing {data.pool.tickSpacing} · 当前 tick <strong>{data.pool.currentTick}</strong>
            <button className="ml-2 rounded bg-slate-200 px-1.5 py-0.5 hover:bg-slate-300" disabled={busy} onClick={refreshTick}>
              刷新 tick
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">区间</span>
            <input className="input max-w-[110px]" value={tickLower} onChange={(e) => setTickLower(e.target.value)} placeholder="tickLower" />
            <span>~</span>
            <input className="input max-w-[110px]" value={tickUpper} onChange={(e) => setTickUpper(e.target.value)} placeholder="tickUpper" />
            <button className="rounded bg-slate-200 px-1.5 py-0.5 hover:bg-slate-300" disabled={busy} onClick={() => refresh()}>应用</button>
            <span className="text-ink-soft">快捷</span>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => refresh({})}>最小窗口</button>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(1)}>±1%</button>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(5)}>±5%</button>
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy} onClick={() => applyPreset(10)}>±10%</button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">投入</span>
            <select className="input max-w-[110px]" value={side} onChange={(e) => setSide(e.target.value as any)}>
              <option value="token0">{data.pool.token0Symbol || "token0"}</option>
              <option value="token1">{data.pool.token1Symbol || "token1"}</option>
            </select>
            <input className="input max-w-[140px]" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="数量" />
            <button className="rounded bg-slate-200 px-1.5 py-0.5" disabled={busy || !amount} onClick={() => refresh()}>计算</button>
          </div>

          {data.compute && (
            <div className="rounded bg-white/60 p-2">
              <div>需要 {data.pool.token0Symbol}: <strong>{data.compute.amount0Human}</strong></div>
              <div>需要 {data.pool.token1Symbol}: <strong>{data.compute.amount1Human}</strong></div>
              <div className="text-ink-soft">liquidity: {data.compute.liquidity}</div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-ink-soft">DEX</span>
            <select className="input max-w-[140px]" value={selectedNpm} onChange={(e) => setSelectedNpm(e.target.value)}>
              {(data.dexes ?? []).map((d: any) => <option key={d.id} value={d.npm}>{d.name}</option>)}
            </select>
            <span className="text-ink-soft">质押</span>
            <select className="input max-w-[170px]" value={selectedStaker} onChange={(e) => setSelectedStaker(e.target.value)}>
              <option value="">不质押</option>
              {(data.staking ?? []).map((s: any) => (
                <option key={s.id} value={s.contract}>{s.pair_label || s.platform}</option>
              ))}
            </select>
          </div>

          <button
            className="btn-primary text-xs"
            disabled={busy || !data.compute || !selectedNpm}
            onClick={execute}
          >
            {address ? (busy ? "执行中…" : "创建仓位") : "连接钱包"}
          </button>

          {steps.length > 0 && (
            <div className="space-y-0.5">
              {steps.map((s, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <span>{s.status === "done" ? "✅" : s.status === "loading" ? "⏳" : s.status === "error" ? "❌" : "○"}</span>
                  <span>{s.label}</span>
                  {s.hash && <span className="font-mono text-ink-soft">{s.hash.slice(0, 10)}…</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {msg && <p className="mt-2 text-xs">{msg}</p>}
    </div>
  );
}
