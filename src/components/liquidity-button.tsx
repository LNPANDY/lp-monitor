"use client";
import { useState } from "react";

/**
 * 仓位流动性分析结果（场景A 直持 / 场景B 质押），与后端 LiquidityResult 对齐。
 */
interface LiquidityResult {
  total: { amount0: string; amount1: string };
  mine: { amount0: string; amount1: string };
  share: number;
  priceLow: string;
  priceHigh: string;
  priceLabel: string;
  currentTick: number;
  tickLower: number;
  tickUpper: number;
  token0Symbol: string;
  token1Symbol: string;
  positionCount: number;
  sampledAt: string;
  cached?: boolean;
}

interface Props {
  positionId: number;
  /** 该仓位参与统计的 LP 数量（来自 last_liquidity 是否存在），仅用于按钮文案提示 */
  staking?: boolean;
}

/**
 * 嵌入仓位卡片的「流动性分析」按钮。
 *
 * 点击后调用 POST /api/positions/[id]/liquidity（命中 10 分钟快照缓存则秒回），
 * 展开显示该 tick 区间内的总流动性、你自己的占比、价格范围。
 */
export function LiquidityButton({ positionId, staking }: Props) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<LiquidityResult | null>(null);
  const [error, setError] = useState("");

  async function toggle() {
    if (open) {
      setOpen(false);
      return;
    }
    setOpen(true);
    if (result) return; // 已有数据，仅展开
    await load(false);
  }

  async function load(force: boolean) {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(`/api/positions/${positionId}/liquidity${force ? "?force=1" : ""}`, {
        method: "POST",
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "分析失败");
      setResult(j.data as LiquidityResult);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mt-2 border-t border-slate-200 pt-2">
      <div className="flex items-center gap-2">
        <button className="btn-ghost text-xs" onClick={toggle} disabled={loading}>
          {open ? "▾ 收起流动性" : "▸ 流动性分析"}
        </button>
        {result?.cached && <span className="text-[10px] text-ink-soft">缓存</span>}
      </div>

      {open && (
        <div className="mt-2 text-xs">
          {loading && <div className="text-ink-soft">分析中（读取链上数据，可能需数秒）…</div>}
          {error && <div className="text-warn">{error} <button className="underline" onClick={() => load(true)}>重试</button></div>}
          {result && !loading && !error && (
            <div className="space-y-1">
              <LiRow label={`区间总流动性 (${result.priceLabel})`}>
                <span className="font-medium">{result.total.amount0} {result.token0Symbol}</span>
                <span className="text-ink-soft"> + </span>
                <span className="font-medium">{result.total.amount1} {result.token1Symbol}</span>
              </LiRow>
              <LiRow label="我的流动性">
                <span>{result.mine.amount0} {result.token0Symbol} + {result.mine.amount1} {result.token1Symbol}</span>
              </LiRow>
              <LiRow label="我的占比">
                <span className={result.share > 0 ? "font-semibold text-ok" : "text-ink-soft"}>
                  {(result.share * 100).toFixed(4)}%
                </span>
              </LiRow>
              <LiRow label="区间内 LP 数">
                <span>{result.positionCount}</span>
              </LiRow>
              <LiRow label="价格区间">
                <span>{result.priceLow} ~ {result.priceHigh} {result.token1Symbol}/{result.token0Symbol}</span>
              </LiRow>
              <div className="flex items-center justify-between pt-1 text-ink-soft">
                <span>采样 {new Date(result.sampledAt).toLocaleString()}</span>
                <button className="underline hover:text-ink" onClick={() => load(true)}>强制刷新</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all">{children}</span>
    </div>
  );
}
