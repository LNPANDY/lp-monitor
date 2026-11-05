"use client";
import { useState } from "react";
import { authHeaders, fmtFull } from "./util";

/**
 * 仓位卡片上的「区间深度分析」折叠面板：
 * 完全遵循 pairFlip（翻转）状态展示主币/计价币顺序与区间价格。
 */
export function LiquidityButton({
  positionId,
  pairFlip = 0,
}: {
  positionId: number;
  pairFlip?: number;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<any | null>(null);

  async function query(refresh = false) {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch(
        `/api/positions/${positionId}/liquidity${refresh ? "?force=1" : ""}`,
        {
          method: "POST",
          headers: authHeaders(),
        }
      );
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "查询失败");
      setResult(j.data);
      setOpen(true);
    } catch (e: any) {
      setErr(e.message);
      setOpen(true);
    } finally {
      setLoading(false);
    }
  }

  function fmtAmt(s: string) {
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    if (n === 0) return "0";
    if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
    if (n >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 4 });
    return n.toPrecision(4);
  }

  const isFlipped = (result?.pairFlip ?? pairFlip) === 1;

  // 按翻转状态决定先展示哪个代币，以及区间价格如何翻转
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
  const rangePrimaryAmt = result?.total
    ? isFlipped
      ? result.total.amount1
      : result.total.amount0
    : "0";
  const rangeSecondaryAmt = result?.total
    ? isFlipped
      ? result.total.amount0
      : result.total.amount1
    : "0";
  const myPrimaryAmt = result?.mine
    ? isFlipped
      ? result.mine.amount1
      : result.mine.amount0
    : "0";
  const mySecondaryAmt = result?.mine
    ? isFlipped
      ? result.mine.amount0
      : result.mine.amount1
    : "0";

  const rawPriceLow = Number(result?.priceLow ?? 0);
  const rawPriceHigh = Number(result?.priceHigh ?? 0);
  const displayPriceLow =
    isFlipped && rawPriceHigh > 0 ? 1 / rawPriceHigh : rawPriceLow;
  const displayPriceHigh =
    isFlipped && rawPriceLow > 0 ? 1 / rawPriceLow : rawPriceHigh;

  const sharePctNum = Number(result?.share ?? 0) * 100;

  return (
    <div className="inline-block">
      <button
        type="button"
        className={`btn-ghost btn-xs ${
          open ? "border-brand/40 text-brand-light bg-brand/10" : ""
        }`}
        disabled={loading}
        onClick={() => {
          if (open && result) {
            setOpen(false);
          } else {
            query(false);
          }
        }}
      >
        {loading ? "读取中…" : open ? "收起深度" : "📊 区间深度"}
      </button>

      {open && (
        <div className="mt-2 rounded-lg border border-white/[0.08] bg-surface-raised/90 p-2.5 text-xs space-y-2">
          {err ? (
            <div className="text-danger">{err}</div>
          ) : result ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-ink-soft">我的区间占比</span>
                  <span className="font-mono text-sm font-bold text-brand-light">
                    {sharePctNum.toFixed(2)}%
                  </span>
                </div>
                <div className="flex items-center gap-2 text-[11px] text-ink-muted">
                  <span>
                    {result.mode === "staking"
                      ? `质押池共 ${result.positionCount ?? 0} 个同窗口仓位`
                      : "全池活跃流动性"}
                    {result.cached ? " · 缓存" : " · 实时"}
                  </span>
                  <button
                    type="button"
                    className="text-brand-light underline hover:text-brand"
                    disabled={loading}
                    onClick={() => query(true)}
                  >
                    刷新
                  </button>
                </div>
              </div>

              {/* 占比进度条 */}
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-brand to-ok transition-all"
                  style={{ width: `${Math.min(100, Math.max(2, sharePctNum))}%` }}
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                <div className="rounded border border-white/[0.05] bg-surface/60 px-2.5 py-1.5">
                  <div className="text-[11px] text-ink-muted">我的持仓数量</div>
                  <div className="mt-0.5 font-mono text-ink font-medium">
                    {fmtAmt(myPrimaryAmt)} {primarySym}{" "}
                    <span className="text-ink-muted">+</span>{" "}
                    {fmtAmt(mySecondaryAmt)} {secondarySym}
                  </div>
                </div>
                <div className="rounded border border-white/[0.05] bg-surface/60 px-2.5 py-1.5">
                  <div className="text-[11px] text-ink-muted">同区间总深度</div>
                  <div className="mt-0.5 font-mono text-ink-soft">
                    {fmtAmt(rangePrimaryAmt)} {primarySym}{" "}
                    <span className="text-ink-muted">+</span>{" "}
                    {fmtAmt(rangeSecondaryAmt)} {secondarySym}
                  </div>
                </div>
              </div>

              <div className="text-[11px] text-ink-muted font-mono pt-0.5">
                区间价格: {fmtFull(displayPriceLow)} ~ {fmtFull(displayPriceHigh)}{" "}
                {secondarySym}/{primarySym}
              </div>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}
