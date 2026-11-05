"use client";
import { useState, useMemo } from "react";
import useSWR from "swr";
import { fetcher, short, timeAgo } from "@/components/util";

interface Alert {
  id: number;
  type: string;
  tick_at: number;
  message: string;
  channels: string;
  sent_at: string;
  dex_name: string;
  token_id: string;
  token0: string;
  token1: string;
  wallet_label: string;
  wallet_address: string;
  chain_name: string;
}

type AlertFilter = "all" | "out_of_range" | "cex_price" | "tick_move" | "back_in_range";

export default function AlertsPage() {
  const { data, mutate } = useSWR<Alert[]>("/api/alerts?limit=200", fetcher, {
    refreshInterval: 30_000,
  });
  const [filter, setFilter] = useState<AlertFilter>("all");
  const [q, setQ] = useState("");

  const list = data ?? [];

  const filtered = useMemo(() => {
    return list.filter((a) => {
      if (filter !== "all" && a.type !== filter) return false;
      if (q.trim()) {
        const kw = q.trim().toLowerCase();
        return (
          (a.message || "").toLowerCase().includes(kw) ||
          (a.token_id || "").toLowerCase().includes(kw) ||
          (a.dex_name || "").toLowerCase().includes(kw) ||
          (a.chain_name || "").toLowerCase().includes(kw)
        );
      }
      return true;
    });
  }, [list, filter, q]);

  return (
    <div className="space-y-4">
      <div className="card p-3.5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <h1 className="text-base font-bold text-ink mr-2">
            告警历史记录 ({filtered.length})
          </h1>
          {(
            [
              { key: "all" as AlertFilter, label: "全部" },
              { key: "out_of_range" as AlertFilter, label: "🚨 越界告警" },
              { key: "cex_price" as AlertFilter, label: "📊 CEX 价差" },
              { key: "tick_move" as AlertFilter, label: "📈 Tick 波动" },
              { key: "back_in_range" as AlertFilter, label: "✅ 回到区间" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setFilter(t.key)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                filter === t.key
                  ? "bg-brand/20 text-brand-light border border-brand/40"
                  : "text-ink-soft hover:text-ink hover:bg-white/[0.04] border border-transparent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <input
            className="input h-7 w-44 px-2.5 py-0 text-xs"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜 #ID / 币种 / 消息…"
          />
          <button
            type="button"
            className="btn-ghost btn-xs"
            onClick={() => mutate()}
          >
            ↻ 刷新
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="card p-8 text-center text-sm text-ink-soft">
          暂无匹配的告警记录。当仓位越界、回到区间、Tick 波动或 CEX 差价超限时会实时记录。
        </div>
      ) : (
        <div className="card divide-y divide-white/[0.06]">
          {filtered.map((a) => {
            const isOut = a.type === "out_of_range";
            const isCex = a.type === "cex_price";
            const isTickMove = a.type === "tick_move";
            const chs: string[] = (() => {
              try {
                return JSON.parse(a.channels);
              } catch {
                return [];
              }
            })();
            const tagLabel = isOut
              ? "🚨 越界"
              : isCex
              ? "📊 CEX 价差"
              : isTickMove
              ? "📈 区间波动"
              : "✅ 回到区间";
            const dotClass = isOut
              ? "bg-danger shadow-[0_0_8px_#f43f5e]"
              : isCex
              ? "bg-warn shadow-[0_0_8px_#f59e0b]"
              : "bg-ok shadow-[0_0_8px_#10b981]";
            const tagClass = isOut
              ? "tag-danger"
              : isCex
              ? "tag-warn"
              : isTickMove
              ? "tag-info"
              : "tag-ok";

            return (
              <div
                key={a.id}
                className="flex items-start gap-3 p-3.5 hover:bg-white/[0.02] transition"
              >
                <div
                  className={`mt-1.5 h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`}
                />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className={tagClass}>{tagLabel}</span>
                      <span className="font-semibold text-ink">
                        {a.chain_name} · {a.dex_name}
                      </span>
                      {a.token_id && (
                        <span className="font-mono text-ink-soft">
                          #{a.token_id}
                        </span>
                      )}
                      {a.token0 && a.token1 && (
                        <span className="font-mono text-ink-muted">
                          {short(a.token0)}/{short(a.token1)}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-muted font-mono">
                      {a.wallet_label || short(a.wallet_address)} ·{" "}
                      {timeAgo(a.sent_at)}
                      {chs.length > 0 && (
                        <span className="ml-1.5 text-ok">
                          [已推: {chs.join("/")}]
                        </span>
                      )}
                    </div>
                  </div>
                  <pre className="whitespace-pre-wrap break-all font-sans text-xs text-ink-soft leading-relaxed">
                    {a.message}
                  </pre>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
