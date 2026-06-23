"use client";
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

export default function AlertsPage() {
  const { data } = useSWR<Alert[]>("/api/alerts?limit=200", fetcher, { refreshInterval: 60_000 });
  const list = data ?? [];

  return (
    <div className="space-y-4">
      <h1 className="text-lg font-semibold">告警时间线（最近 {list.length} 条）</h1>
      {list.length === 0 ? (
        <div className="card p-8 text-center text-ink-soft">暂无告警记录。当仓位越界或回到区间时，会自动记录在这里。</div>
      ) : (
        <div className="card divide-y divide-slate-100">
          {list.map((a) => {
            const isOut = a.type === "out_of_range";
            const isCex = a.type === "cex_price";
            const isTickMove = a.type === "tick_move";
            const chs: string[] = (() => { try { return JSON.parse(a.channels); } catch { return []; } })();
            const tagLabel = isOut ? "越界" : isCex ? "CEX 价差" : isTickMove ? "波动" : "回到区间";
            const dotClass = isOut ? "bg-warn" : "bg-ok";
            const tagClass = isOut ? "tag-warn" : isCex || isTickMove ? "tag-info" : "tag-ok";
            return (
              <div key={a.id} className="flex items-start gap-3 p-4">
                <div className={`mt-1 h-2 w-2 flex-shrink-0 rounded-full ${dotClass}`} />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className={`tag ${tagClass}`}>{tagLabel}</span>
                    <span className="font-medium">{a.chain_name} / {a.dex_name}</span>
                    <span className="text-ink-soft">#{a.token_id}</span>
                    <span className="text-ink-soft">{short(a.token0)}/{short(a.token1)}</span>
                  </div>
                  <pre className="mt-1 whitespace-pre-wrap break-all font-sans text-xs text-ink-soft">{a.message}</pre>
                  <div className="mt-1 text-xs text-ink-soft">
                    {a.wallet_label || short(a.wallet_address)} · {timeAgo(a.sent_at)}
                    {chs.length > 0 && <> · 已推送 {chs.join(" / ")}</>}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
