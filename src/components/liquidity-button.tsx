"use client";
import { useState } from "react";
import { authHeaders, fmtFull } from "./util";

/**
 * 仓位流动性分析结果（场景A 直持 / 场景B 质押），与后端 LiquidityResult 对齐。
 * 完全遵循 pairFlip（翻转）状态展示主币/计价币顺序与区间价格。
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
  pairFlip?: number;
}

interface Props {
  positionId: number;
  staking?: boolean;
  pairFlip?: number;
}

export function LiquidityButton({ positionId, pairFlip = 0 }: Props) {
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
    if (result) return;
    await load(false);
  }

  async function load(force: boolean) {
    setLoading(true);
    setError("");
    try {
      const r = await fetch(
        `/api/positions/${positionId}/liquidity${force ? "?force=1" : ""}`,
        {
          method: "POST",
          headers: authHeaders(),
        }
      );
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "分析失败");
      setResult(j.data as LiquidityResult);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  const isFlipped = (result?.pairFlip ?? pairFlip) === 1;
  const primarySym = result
    ? isFlipped
      ? result.token1Symbol
      : result.token0Symbol
    : "";
  const secondarySym = result
    ? isFlipped
      ? result.token0Symbol
      : result.token1Symbol
    : "";
  const displayPair = result ? `${primarySym}/${secondarySym}` : "";
  const totalPrimary = result?.total
    ? isFlipped
      ? result.total.amount1
      : result.total.amount0
    : "0";
  const totalSecondary = result?.total
    ? isFlipped
      ? result.total.amount0
      : result.total.amount1
    : "0";
  const myPrimary = result?.mine
    ? isFlipped
      ? result.mine.amount1
      : result.mine.amount0
    : "0";
  const mySecondary = result?.mine
    ? isFlipped
      ? result.mine.amount0
      : result.mine.amount1
    : "0";
  const displayPriceLow = result?.priceLow
    ? fmtFull(
        isFlipped && Number(result.priceHigh) > 0
          ? 1 / Number(result.priceHigh)
          : Number(result.priceLow)
      )
    : "";
  const displayPriceHigh = result?.priceHigh
    ? fmtFull(
        isFlipped && Number(result.priceLow) > 0
          ? 1 / Number(result.priceLow)
          : Number(result.priceHigh)
      )
    : "";

  return (
    <div className="mt-2.5 border-t border-white/[0.08] pt-2.5">
      <div className="flex items-center gap-2">
        <button
          className="btn-ghost text-xs"
          onClick={toggle}
          disabled={loading}
        >
          {open ? "▾ 收起流动性" : "▸ 流动性分析"}
        </button>
        {result?.cached && (
          <span className="text-[11px] text-ink-muted">缓存</span>
        )}
      </div>

      {open && (
        <div className="mt-2 rounded-lg border border-white/[0.08] bg-surface-raised p-2.5 text-xs">
          {loading && (
            <div className="text-ink-soft">
              分析中（读取链上数据，可能需数秒）…
            </div>
          )}
          {error && (
            <div className="text-warn">
              {error}{" "}
              <button className="underline" onClick={() => load(true)}>
                重试
              </button>
            </div>
          )}
          {result && !loading && !error && (
            <div className="space-y-1">
              <LiRow label={`区间总流动性 (${displayPair})`}>
                <span className="font-mono font-medium">
                  {totalPrimary} {primarySym}
                </span>
                <span className="text-ink-soft"> + </span>
                <span className="font-mono font-medium">
                  {totalSecondary} {secondarySym}
                </span>
              </LiRow>
              <LiRow label="我的流动性">
                <span className="font-mono">
                  {myPrimary} {primarySym} + {mySecondary} {secondarySym}
                </span>
              </LiRow>
              <LiRow label="我的占比">
                <span
                  className={
                    result.share > 0
                      ? "font-mono font-semibold text-ok"
                      : "font-mono text-ink-soft"
                  }
                >
                  {(result.share * 100).toFixed(4)}%
                </span>
              </LiRow>
              <LiRow label="区间内 LP 数">
                <span className="font-mono">{result.positionCount}</span>
              </LiRow>
              <LiRow label="价格区间">
                <span className="font-mono">
                  {displayPriceLow} ~ {displayPriceHigh} {secondarySym}/
                  {primarySym}
                </span>
              </LiRow>
              <div className="flex items-center justify-between pt-1 text-ink-muted border-t border-white/[0.06]">
                <span>采样 {new Date(result.sampledAt).toLocaleString()}</span>
                <button
                  className="underline text-cyan-300 hover:text-white"
                  onClick={() => load(true)}
                >
                  强制刷新
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function LiRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all text-ink">{children}</span>
    </div>
  );
}
