"use client";
import { useState } from "react";
import useSWR from "swr";
import { fetcher, short, timeAgo, fmtFull } from "@/components/util";

interface Position {
  id: number;
  dex_name: string;
  dex_display_name?: string;
  token_id: string;
  token0: string;
  token1: string;
  token0_symbol?: string;
  token1_symbol?: string;
  fee: number;
  pool: string;
  tick_lower: number;
  tick_upper: number;
  last_current_tick: number;
  last_in_range: number;
  last_price0: string;
  last_checked_at: string;
  notify_state: string;
  source: string;
  staker_contract: string;
  chain_name: string;
  chain_key: string;
  explorer_url: string;
  wallet_label: string;
  wallet_address: string;
  last_alert_type?: string;
  last_cex_price?: string; // JSON: CexPricePayload，开启 CEX 对比且有报价时写入
}

interface MonitorState {
  running: boolean;
  cron: string;
  cooldownMs: number;
  last: any;
}

export default function DashboardPage() {
  const { data: positions, mutate: reloadPos } = useSWR<Position[]>("/api/positions", fetcher, { refreshInterval: 60_000 });
  const { data: closedPositions } = useSWR<Position[]>("/api/positions?all=1", fetcher, { refreshInterval: 60_000 });
  const { data: mon, mutate: reloadMon } = useSWR<MonitorState>("/api/monitor", fetcher, { refreshInterval: 10_000 });

  const list = positions ?? [];
  const outOfRange = list.filter((p) => p.last_in_range === 0);
  const closed = (closedPositions ?? []).filter((p) => p.notify_state === "closed");
  const [showClosed, setShowClosed] = useState(false);

  async function triggerScan() {
    const r = await fetch("/api/monitor", { method: "POST" });
    const j = await r.json();
    if (!j.ok) alert(j.error);
    // 扫描是异步的(可能耗时 1~2 分钟),先立即刷一次拿最新提交状态,
    // 再在几秒后补刷一次,确保扫描完成后的结果能尽快呈现。
    reloadPos();
    setTimeout(() => reloadPos(), 8_000);
    setTimeout(() => reloadPos(), 30_000);
    setTimeout(() => reloadPos(), 90_000);
  }

  return (
    <div className="space-y-6">
      {/* 顶部状态条 */}
      <div className="card flex flex-wrap items-center justify-between gap-3 p-4">
        <div className="flex items-center gap-4">
          <Stat label="监控仓位" value={list.length} />
          <Stat label="越界" value={outOfRange.length} danger={outOfRange.length > 0} />
          <div className="text-sm text-ink-soft">
            <div>调度：{mon?.cron ?? "—"}</div>
            <div>状态：{mon?.running ? "扫描中…" : `上次 ${timeAgo(mon?.last?.at)}`}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={triggerScan}>立即扫描</button>
        </div>
      </div>

      {/* 扫描频率设置 */}
      <ScanInterval currentCron={mon?.cron ?? ""} onChanged={() => reloadMon()} />

      {/* 告警阈值设置 */}
      <AlertThreshold />

      {/* 越界告警区（如有） */}
      {outOfRange.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-warn">
            ⚠️ 越界仓位（{outOfRange.length}）
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {outOfRange.map((p) => <PositionCard key={p.id} p={p} highlight />)}
          </div>
        </section>
      )}

      {/* 全部仓位 */}
      <section>
        <h2 className="mb-2 text-base font-semibold">全部仓位</h2>
        {list.length === 0 ? (
          <EmptyHint />
        ) : (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {list.map((p) => <PositionCard key={p.id} p={p} />)}
          </div>
        )}
      </section>

      {/* 已平仓仓位（折叠） */}
      {closed.length > 0 && (
        <section>
          <button
            className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-ink"
            onClick={() => setShowClosed(!showClosed)}
          >
            <span className={`transition-transform ${showClosed ? "rotate-90" : ""}`}>▶</span>
            已平仓仓位（{closed.length}）
          </button>
          {showClosed && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3 opacity-60">
              {closed.map((p) => <PositionCard key={p.id} p={p} closed />)}
            </div>
          )}
        </section>
      )}

      {/* 底部版本号 */}
      <div className="text-center text-xs text-ink-soft">
        LP Monitor v{process.env.NEXT_PUBLIC_VERSION}
      </div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <div className={`text-2xl font-bold ${danger ? "text-warn" : ""}`}>{value}</div>
      <div className="text-xs text-ink-soft">{label}</div>
    </div>
  );
}

function ScanInterval({ currentCron, onChanged }: { currentCron: string; onChanged: () => void }) {
  const [preset, setPreset] = useState("");
  const [custom, setCustom] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  // 从 cron 反推分钟数用于默认显示
  const m = currentCron.match(/^\*\/(\d+) \* \* \* \*$/);
  const curMin = m ? Number(m[1]) : 0;

  async function apply(intervalMin?: number, cron?: string) {
    setBusy(true); setMsg("");
    try {
      const body = cron ? { cron } : { intervalMin };
      const r = await fetch("/api/monitor", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 已更新扫描频率：${j.data.cron}`);
      setPreset(""); setCustom("");
      onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="card flex flex-wrap items-center gap-3 p-4">
      <div className="text-sm font-medium">扫描频率：</div>
      <div className="text-sm text-ink-soft">当前 {currentCron || "—"} {curMin > 0 && <span className="tag-muted ml-1">约每 {curMin} 分钟</span>}</div>
      <div className="ml-auto flex flex-wrap items-center gap-2">
        <select
          className="input max-w-[140px]"
          value={preset}
          onChange={(e) => setPreset(e.target.value)}
        >
          <option value="">常用预设…</option>
          <option value="1">每 1 分钟</option>
          <option value="2">每 2 分钟</option>
          <option value="3">每 3 分钟</option>
          <option value="5">每 5 分钟</option>
          <option value="10">每 10 分钟</option>
          <option value="15">每 15 分钟</option>
          <option value="30">每 30 分钟</option>
          <option value="60">每 1 小时</option>
        </select>
        <button className="btn-ghost text-xs" disabled={!preset || busy} onClick={() => apply(Number(preset))}>应用预设</button>

        <span className="mx-1 text-ink-soft">|</span>

        <input
          className="input max-w-[200px]"
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="自定义 cron，如 */7 * * * *"
        />
        <button className="btn-ghost text-xs" disabled={!custom || busy} onClick={() => apply(undefined, custom)}>应用自定义</button>
      </div>
      {busy && <span className="text-xs text-ink-soft">处理中…</span>}
      {msg && <span className="text-xs">{msg}</span>}
    </div>
  );
}

function AlertThreshold() {
  const { data, mutate } = useSWR<any>("/api/alert-settings", fetcher);
  const [tickThreshold, setTickThreshold] = useState("");
  const [cexThreshold, setCexThreshold] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function toggleTick() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tick_move_enabled: data?.tick_move_enabled ? "0" : "1" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutate();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  async function toggleCex() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cex_price_enabled: data?.cex_price_enabled ? "0" : "1" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutate();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
    }

  async function applyThreshold() {
    setBusy(true); setMsg("");
    try {
      const body: any = {};
      if (tickThreshold !== "") body.tick_move_threshold = Number(tickThreshold);
      if (cexThreshold !== "") body.cex_price_threshold = Number(cexThreshold);
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 阈值已更新");
      setTickThreshold(""); setCexThreshold("");
      mutate();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-4">
      <div className="mb-2 text-sm font-medium">告警阈值</div>
      <div className="flex flex-wrap items-center gap-4 text-sm">
        {/* tick 波动开关 */}
        <div className="flex items-center gap-2">
          <button
            className={data?.tick_move_enabled ? "btn-primary text-xs" : "btn-ghost text-xs"}
            disabled={busy}
            onClick={toggleTick}
          >
            {data?.tick_move_enabled ? "波动预警：开" : "波动预警：关"}
          </button>
          <span className="text-ink-soft">当前阈值 {data?.tick_move_threshold ?? 10}%</span>
        </div>

        {/* CEX 对比开关 */}
        <div className="flex items-center gap-2">
          <button
            className={data?.cex_price_enabled ? "btn-primary text-xs" : "btn-ghost text-xs"}
            disabled={busy}
            onClick={toggleCex}
          >
            {data?.cex_price_enabled ? "CEX 价差：开" : "CEX 价差：关"}
          </button>
          <span className="text-ink-soft">当前阈值 {data?.cex_price_threshold ?? 3}%</span>
        </div>

        <span className="mx-1 text-ink-soft">|</span>

        <input
          className="input max-w-[120px]"
          type="number"
          min={0}
          max={100}
          value={tickThreshold}
          onChange={(e) => setTickThreshold(e.target.value)}
          placeholder="波动阈值 %"
        />
        <input
          className="input max-w-[120px]"
          type="number"
          min={0}
          max={100}
          value={cexThreshold}
          onChange={(e) => setCexThreshold(e.target.value)}
          placeholder="CEX 价差 %"
        />
        <button className="btn-ghost text-xs" disabled={busy || (tickThreshold === "" && cexThreshold === "")} onClick={applyThreshold}>
          应用阈值
        </button>
      </div>
      {msg && <div className="mt-1 text-xs">{msg}</div>}
      <div className="mt-1 text-xs text-ink-soft">
        波动阈值：两次扫描间，仓位在区间内的相对位置变化超过该百分比就告警（如 75%→65% = 变动 10%）
      </div>
    </div>
  );
}

function EmptyHint() {
  return (
    <div className="card p-8 text-center text-ink-soft">
      <p className="mb-3">还没有任何仓位被监控。</p>
      <ol className="mx-auto inline-block list-decimal text-left text-sm">
        <li>在 <a className="underline" href="/config">配置页</a> 添加监控钱包</li>
        <li>确认链上有对应 DEX（默认 Ethereum / Uniswap V3）</li>
        <li>点击「立即扫描」或等待定时任务</li>
      </ol>
    </div>
  );
}

function PositionCard({ p, highlight, closed }: { p: Position; highlight?: boolean; closed?: boolean }) {
  const inRange = p.last_in_range === 1;
  const explorer = p.explorer_url?.replace(/\/$/, "");
  const dexLabel = p.dex_display_name || p.dex_name;
  const marginLower = ((p.last_current_tick - p.tick_lower) / Math.max(p.tick_upper - p.tick_lower, 1)) * 100;
  const marginUpper = ((p.tick_upper - p.last_current_tick) / Math.max(p.tick_upper - p.tick_lower, 1)) * 100;
  const sym0 = p.token0_symbol || short(p.token0);
  const sym1 = p.token1_symbol || short(p.token1);
  const pair = `${sym0}/${sym1}`;
  // CEX 对比信息：last_cex_price 是 JSON(CexPricePayload)，解析失败/缺失则不展示该行
  const cexInfo = parseCexPrice(p.last_cex_price);
  // 价差超过该值就在卡片里标红（与后端 cex_price_threshold 解耦，前端固定 1% 做视觉提示，真正告警阈值在设置页）
  const cexWarnThresh = 0.01;

  return (
    <div className={`card p-4 ${closed ? "border-dashed border-slate-300 bg-slate-50" : highlight ? "border-warn" : ""}`}>
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-semibold">{pair}</span>
            <span className="text-xs text-ink-soft">{dexLabel}</span>
            {closed ? <span className="tag-muted">已平仓</span> : inRange ? <span className="tag-ok">在区间内</span> : <span className="tag-warn">已越界</span>}
            {!closed && p.last_alert_type === "tick_move" && <span className="tag-info">波动</span>}
            {!closed && p.last_alert_type === "cex_price" && <span className="tag-info">CEX 价差</span>}
            {!closed && p.source === "staking" && <span className="tag-muted">质押中</span>}
          </div>
          <div className="mt-0.5 text-xs text-ink-soft">
            {p.chain_name} · #{p.token_id}
          </div>
        </div>
      </div>

      <div className="space-y-1 text-sm">
        <Row label="交易对">
          <span title={`${p.token0} / ${p.token1}`}>
            {pair} · fee {p.fee / 10000}%
          </span>
        </Row>
        <Row label="当前 tick">
          <span className={inRange ? "" : "text-warn font-semibold"}>{p.last_current_tick}</span>
        </Row>
        <Row label="区间">[{p.tick_lower}, {p.tick_upper}]</Row>
        <Row label="价格">1 {sym0} ≈ {p.last_price0} {sym1}</Row>
        {cexInfo && (
          <Row label={`CEX 汇率 (${cexInfo.token0CexSymbol}÷${cexInfo.token1CexSymbol})`}>
            <span>1 {sym0} = {fmtFull(cexInfo.cexRate)} {sym1}</span>
          </Row>
        )}
        {cexInfo && (
          <Row label="DEX vs CEX">
            <span className={cexInfo.absDiff >= cexWarnThresh ? "text-warn font-semibold" : ""}>
              差 {pctSigned(cexInfo.diff)}
            </span>
            <span className="ml-1 text-ink-soft">（DEX {fmtFull(cexInfo.dexRate)} / CEX {fmtFull(cexInfo.cexRate)}）</span>
          </Row>
        )}

        {/* 区间位置可视化 */}
        <div className="pt-1">
          <div className="relative h-2 w-full rounded bg-slate-200">
            <div className="absolute inset-y-0 left-0 rounded bg-ok/40" style={{ width: `${inRange ? Math.min(Math.max(marginLower, 2), 98) : marginLower < 0 ? 0 : 100}%` }} />
            <div
              className="absolute top-1/2 h-3 w-1 -translate-y-1/2 rounded"
              style={{
                left: `${Math.min(Math.max((p.last_current_tick - p.tick_lower) / Math.max(p.tick_upper - p.tick_lower, 1) * 100, 0), 100)}%`,
                background: inRange ? "#16a34a" : "#dc2626",
              }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[10px] text-ink-soft">
            <span>距下界 {marginLower.toFixed(1)}%</span>
            <span>距上界 {marginUpper.toFixed(1)}%</span>
          </div>
        </div>

        <Row label="钱包">{p.wallet_label || short(p.wallet_address)}</Row>
        <Row label="检查时间">{timeAgo(p.last_checked_at)}</Row>
        {p.source === "staking" && (
          <Row label="质押合约">
            <a className="underline" href={`${explorer}/address/${p.staker_contract}`} target="_blank" rel="noreferrer">{short(p.staker_contract)}</a>
          </Row>
        )}
      </div>

      <div className="mt-3 flex gap-2 text-xs">
        {explorer && (
          <a className="btn-ghost" href={`${explorer}/address/${p.pool}`} target="_blank" rel="noreferrer">查看 Pool</a>
        )}
        {explorer && p.token_id && (
          <a className="btn-ghost" href={`${explorer}/token/${p.dex_display_name ? "" : ""}`} target="_blank" rel="noreferrer" aria-disabled style={{ display: "none" }}>NFT</a>
        )}
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-ink-soft">{label}</span>
      <span className="text-right break-all">{children}</span>
    </div>
  );
}

/** positions.last_cex_price 的前端结构（与 scanner 写入的 CexPricePayload 对齐）。 */
interface CexPricePayload {
  pairLabel: string; // 如 'W0G/WETH'
  token0CexSymbol: string; // 如 '0GUSDT'
  token1CexSymbol: string; // 如 'ETHUSDT'
  quote: string; // 共同计价币种，如 'USDT'
  dexRate: number; // DEX: 1 token0 = ? token1
  cexRate: number; // CEX: 1 token0 = ? token1
  diff: number;
  absDiff: number;
}

/** 解析 last_cex_price JSON。非法/缺失返回 null。 */
function parseCexPrice(raw?: string): CexPricePayload | null {
  if (!raw) return null;
  try {
    const o = JSON.parse(raw);
    if (
      typeof o.dexRate === "number" &&
      typeof o.cexRate === "number" &&
      typeof o.diff === "number"
    ) {
      return o as CexPricePayload;
    }
    return null;
  } catch {
    return null;
  }
}

/** 带符号百分比，如 +2.30% / -1.50%。 */
function pctSigned(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}
