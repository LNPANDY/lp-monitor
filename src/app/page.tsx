"use client";
import { useState } from "react";
import useSWR from "swr";
import { fetcher, short, timeAgo, fmtFull } from "@/components/util";

/** 将常见的 cron 表达式转为人类可读标签 */
function cronToLabel(cron: string): string {
  const m = cron.trim();
  // */N * * * * → N 分钟
  const starSlash = m.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (starSlash) {
    const n = Number(starSlash[1]);
    if (n >= 60) return `${Math.round(n / 60)} 小时`;
    return `${n} 分钟`;
  }
  // 0 * * * * → 1 小时
  if (m === "0 * * * *") return "1 小时";
  return m;
}
import { LiquidityButton } from "@/components/liquidity-button";
import { LiquidityProbe } from "@/components/liquidity-probe";
import { Field } from "@/components/form";

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
  pair_flip?: number; // 0=原始 token0/token1，1=用户翻转为 token1/token0
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
            <div>调度：{mon?.cron ? cronToLabel(mon.cron) : "—"}</div>
            <div>状态：{mon?.running ? "扫描中…" : `上次 ${timeAgo(mon?.last?.at)}`}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-primary" onClick={triggerScan}>立即扫描</button>
        </div>
      </div>

      {/* 扫描频率和告警阈值设置 */}
      <ScanIntervalAndAlerts currentCron={mon?.cron ?? ""} onChanged={() => reloadMon()} />

      {/* 链上资产统计 */}
      <PortfolioSection />

      {/* 流动性探针（场景C + 收藏） */}
      <LiquidityProbe />

      {/* 越界告警区（如有） */}
      {outOfRange.length > 0 && (
        <section>
          <h2 className="mb-2 flex items-center gap-2 text-base font-semibold text-warn">
            ⚠️ 越界仓位（{outOfRange.length}）
          </h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
            {outOfRange.map((p) => <PositionCard key={p.id} p={p} highlight onFlipped={reloadPos} />)}
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
            {list.map((p) => <PositionCard key={p.id} p={p} onFlipped={reloadPos} />)}
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
              {closed.map((p) => <PositionCard key={p.id} p={p} closed onFlipped={reloadPos} />)}
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

/* ============ 链上资产统计 ============ */
interface AssetItem {
  kind: "native" | "erc20" | "lp";
  symbol: string;
  amount: string;
  valueUsd: number | null;
  subItems?: { symbol: string; amount: string; valueUsd: number | null }[];
}
interface PortfolioResult {
  items: AssetItem[];
  totalUsd: number;
  nativeSymbol: string;
  warnings: string[];
}

function PortfolioSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const [addr, setAddr] = useState("");
  // 手动触发：点「统计」后才请求，避免无输入时自动拉链上数据
  const [query, setQuery] = useState<{ chainId: number; addr: string } | null>(null);
  // ERC20 代币列表折叠状态（默认展开）
  const [erc20Open, setErc20Open] = useState(true);
  const { data, error, isLoading } = useSWR<PortfolioResult>(
    query ? `/api/portfolio?chain_id=${query.chainId}&address=${encodeURIComponent(query.addr)}` : null,
    fetcher
  );

  function doQuery() {
    if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(addr.trim())) return;
    setQuery({ chainId, addr: addr.trim() });
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">链上资产统计</h2>
      <p className="mb-3 text-xs text-ink-soft">
        选择链并输入钱包地址，实时统计该钱包的 GAS 余额、ERC20 代币余额 + LP 仓位价值（含直接持有与质押，按 CEX 报价折算）。
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr_auto]">
        <Field label="链">
          <select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}>
            <option value="">选择链</option>
            {(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        </Field>
        <Field label="钱包地址">
          <input className="input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" />
        </Field>
        <div className="flex items-end">
          <button className="btn-primary w-full" onClick={doQuery} disabled={!chainId || !addr}>统计</button>
        </div>
      </div>

      {isLoading && <p className="text-sm text-ink-soft">统计中…（需读取链上余额与池子状态）</p>}
      {error && <p className="text-sm text-warn">❌ {(error as any)?.message ?? error}</p>}
      {data && !isLoading && (
        <>
          {data.items.length === 0 ? (
            <p className="text-sm text-ink-soft">未发现资产（该钱包未登记或无仓位）。</p>
          ) : (() => {
            const nativeItems = data.items.filter((it) => it.kind === "native");
            const erc20Items = data.items.filter((it) => it.kind === "erc20");
            const lpItems = data.items.filter((it) => it.kind === "lp");
            return (
              <div className="overflow-hidden rounded-md border border-slate-200">
                {/* GAS 原生代币 */}
                {nativeItems.map((it, i) => (
                  <div key={`native-${i}`} className={`flex items-center justify-between px-3 py-2 text-sm ${it.kind === "native" ? "bg-slate-50" : ""}`}>
                    <span className="font-medium">
                      {it.symbol}
                      {it.kind === "native" && <span className="ml-1 text-ink-soft">:{it.amount}</span>}
                    </span>
                    <span className={it.valueUsd === null ? "text-ink-soft" : "text-ink"}>
                      {it.valueUsd === null ? "—" : `${it.valueUsd.toFixed(1)}U`}
                    </span>
                  </div>
                ))}
                {/* ERC20 代币折叠区域 */}
                {erc20Items.length > 0 && (
                  <>
                    <div className="flex items-center justify-between border-t border-slate-200 px-3 py-1.5 text-xs">
                      <span className="font-medium text-ink-soft">
                        ERC20 代币（{erc20Items.length} 种）
                      </span>
                      <button
                        className="text-ink-soft hover:text-ink transition-colors"
                        onClick={() => setErc20Open((v) => !v)}
                      >
                        {erc20Open ? "收起 ▲" : "展开 ▼"}
                      </button>
                    </div>
                    {erc20Open && erc20Items.map((it, i) => (
                      <div key={`erc20-${i}`} className="flex items-center justify-between px-3 py-2 text-sm">
                        <span className="font-medium">
                          {it.symbol}<span className="ml-1 text-ink-soft">:{it.amount}</span>
                        </span>
                        <span className={it.valueUsd === null ? "text-ink-soft" : "text-ink"}>
                          {it.valueUsd === null ? "—" : `${it.valueUsd.toFixed(1)}U`}
                        </span>
                      </div>
                    ))}
                  </>
                )}
                {/* LP 仓位 */}
                {lpItems.map((it, i) => (
                  <div key={`lp-${i}`}>
                    <div className="flex items-center justify-between border-t border-slate-200 px-3 py-2 text-sm">
                      <span className="font-medium">{it.symbol}</span>
                      <span className={it.valueUsd === null ? "text-ink-soft" : "text-ink"}>
                        {it.valueUsd === null ? "—" : `${it.valueUsd.toFixed(1)}U`}
                      </span>
                    </div>
                    {it.subItems?.map((s, j) => (
                      <div key={j} className="flex items-center justify-between px-3 py-1.5 pl-6 text-xs text-ink-soft">
                        <span>{s.symbol}:{s.amount}</span>
                        <span>{s.valueUsd === null ? "—" : `${s.valueUsd.toFixed(1)}U`}</span>
                      </div>
                    ))}
                  </div>
                ))}
                {/* 总价值 */}
                <div className="flex items-center justify-between border-t border-slate-200 bg-slate-50 px-3 py-2.5 text-sm font-bold">
                  <span>总价值</span>
                  <span>{data.totalUsd.toFixed(1)}U</span>
                </div>
              </div>
            );
          })()}
          {data.warnings.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {data.warnings.map((w, i) => (
                <p key={i} className="text-xs text-warn">⚠ {w}</p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ScanIntervalAndAlerts({ currentCron, onChanged }: { currentCron: string; onChanged: () => void }) {
  const [preset, setPreset] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: alertData, mutate: mutateAlerts } = useSWR<any>("/api/alert-settings", fetcher);
  const [tickThreshold, setTickThreshold] = useState("");

  // 从 cron 反推分钟数用于默认显示
  const m = currentCron.match(/^\*\/(\d+) \* \* \* \*$/);
  const curMin = m ? Number(m[1]) : 0;

  async function applyScanInterval(intervalMin: number) {
    setBusy(true); setMsg("");
    try {
      const body = { intervalMin };
      const r = await fetch("/api/monitor", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 已更新扫描频率`);
      setPreset("");
      onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  async function toggleTick() {
    setBusy(true); setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tick_move_enabled: alertData?.tick_move_enabled ? "0" : "1" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
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
        body: JSON.stringify({ cex_price_enabled: alertData?.cex_price_enabled ? "0" : "1" }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  async function applyThreshold() {
    setBusy(true); setMsg("");
    try {
      const body: any = {};
      if (tickThreshold !== "") body.tick_move_threshold = Number(tickThreshold);
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 阈值已更新");
      setTickThreshold("");
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally { setBusy(false); }
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* 扫描频率 */}
        <div className="flex items-center gap-2 border-r border-slate-200 pr-4">
          <span className="text-sm font-medium">扫描频率：</span>
          <span className="text-sm text-ink-soft">
            {currentCron ? cronToLabel(currentCron) : "—"}
          </span>
          <select
            className="input max-w-[120px] text-xs"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            <option value="">设置频率…</option>
            <option value="1">每 1 分钟</option>
            <option value="2">每 2 分钟</option>
            <option value="3">每 3 分钟</option>
            <option value="5">每 5 分钟</option>
            <option value="10">每 10 分钟</option>
            <option value="15">每 15 分钟</option>
            <option value="30">每 30 分钟</option>
            <option value="60">每 1 小时</option>
          </select>
          <button
            className="btn-ghost text-xs"
            disabled={!preset || busy}
            onClick={() => applyScanInterval(Number(preset))}
          >
            应用
          </button>
        </div>

        {/* 告警阈值 */}
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">告警阈值：</span>

          {/* tick 波动开关 */}
          <button
            className={alertData?.tick_move_enabled ? "btn-primary text-xs" : "btn-ghost text-xs"}
            disabled={busy}
            onClick={toggleTick}
          >
            {alertData?.tick_move_enabled ? "波动预警：开" : "波动预警：关"}
          </button>
          <span className="text-xs text-ink-soft">阈值 {alertData?.tick_move_threshold ?? 10}%</span>

          {/* CEX 对比开关 */}
          <button
            className={alertData?.cex_price_enabled ? "btn-primary text-xs" : "btn-ghost text-xs"}
            disabled={busy}
            onClick={toggleCex}
          >
            {alertData?.cex_price_enabled ? "CEX 价差：开" : "CEX 价差：关"}
          </button>
          <span className="text-xs text-ink-soft">超过费率 2 倍时提醒</span>

          {/* 阈值设置 */}
          <input
            className="input max-w-[100px] text-xs"
            type="number"
            min={0}
            max={100}
            value={tickThreshold}
            onChange={(e) => setTickThreshold(e.target.value)}
            placeholder="波动阈值 %"
          />
          <button
            className="btn-ghost text-xs"
            disabled={busy || tickThreshold === ""}
            onClick={applyThreshold}
          >
            应用阈值
          </button>
        </div>
      </div>

      {msg && <div className="mt-2 text-xs">{msg}</div>}
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

function FlipButton({ positionId, currentFlip, onFlipped }: { positionId: number; currentFlip: boolean; onFlipped?: () => void }) {
  const [loading, setLoading] = useState(false);
  const [flip, setFlip] = useState(currentFlip);

  const handleFlip = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/positions/${positionId}/pair-flip`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flip: !flip })
      });
      const result = await response.json();
      
      if (result.ok) {
        setFlip(!flip);
        // 通知父组件刷新，让卡片其它依赖 pair_flip 的展示同步更新
        onFlipped?.();
      } else {
        alert(result.error || "操作失败");
      }
    } catch (error) {
      alert("操作失败：" + error);
    } finally {
      setLoading(false);
    }
  };

  return (
    <button
      onClick={handleFlip}
      disabled={loading}
      className={`text-xs px-2 py-1 rounded ${
        flip 
          ? "bg-blue-100 text-blue-700 hover:bg-blue-200" 
          : "bg-slate-100 text-slate-600 hover:bg-slate-200"
      } transition-colors`}
    >
      {loading ? "..." : (flip ? "还原" : "翻转")}
    </button>
  );
}

function PositionCard({ p, highlight, closed, onFlipped }: { p: Position; highlight?: boolean; closed?: boolean; onFlipped?: () => void }) {
  const inRange = p.last_in_range === 1;
  const explorer = p.explorer_url?.replace(/\/$/, "");
  const dexLabel = p.dex_display_name || p.dex_name;
  const marginLower = ((p.last_current_tick - p.tick_lower) / Math.max(p.tick_upper - p.tick_lower, 1)) * 100;
  const marginUpper = ((p.tick_upper - p.last_current_tick) / Math.max(p.tick_upper - p.tick_lower, 1)) * 100;
  const sym0 = p.token0_symbol || short(p.token0);
  const sym1 = p.token1_symbol || short(p.token1);
  const pair = p.pair_flip ? `${sym1}/${sym0}` : `${sym0}/${sym1}`;
  // CEX 对比信息：last_cex_price 是 JSON(CexPricePayload)，解析失败/缺失则不展示该行
  const cexInfo = parseCexPrice(p.last_cex_price);
  // 价差超过该值就在卡片里标红（前端固定 1% 做视觉提示；真正告警阈值为该仓位 fee 的 2 倍，由后端按 fee 动态计算）
  const cexWarnThresh = 0.01;

  // 翻转后展示口径变为「1 token1 = ? token0」：汇率取倒数，符号/标签交换
  const flip = p.pair_flip === 1;
  const displaySym0 = flip ? sym1 : sym0;
  const displaySym1 = flip ? sym0 : sym1;
  // last_price0 原始口径与 dexRate 一致（1 token0 = ? token1），翻转后取倒数；用 fmtFull 展开避免科学计数法
  const displayPrice0 = p.last_price0
    ? fmtFull(flip ? 1 / Number(p.last_price0) : Number(p.last_price0))
    : p.last_price0;
  // cexRate 原始口径是「1 token0 = ? token1」，翻转后取倒数
  const displayCexRate = cexInfo ? (flip ? 1 / cexInfo.cexRate : cexInfo.cexRate) : 0;
  const displayToken0Cex = cexInfo ? (flip ? cexInfo.token1CexSymbol : cexInfo.token0CexSymbol) : "";
  const displayToken1Cex = cexInfo ? (flip ? cexInfo.token0CexSymbol : cexInfo.token1CexSymbol) : "";

  return (
    <div className={`card p-4 ${closed ? "border-dashed border-slate-300 bg-slate-50" : highlight ? "border-warn" : ""}`}>
        <div className="mb-2 flex items-start justify-between gap-2">
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{pair}</span>
              {p.pair_flip === 1 && (
                <span className="text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded" title="交易对已翻转">
                  翻转
                </span>
              )}
              {closed ? <span className="tag-muted">已平仓</span> : inRange ? <span className="tag-ok">在区间内</span> : <span className="tag-warn">已越界</span>}
              {!closed && p.last_alert_type === "tick_move" && <span className="tag-info">波动</span>}
              {!closed && p.last_alert_type === "cex_price" && <span className="tag-info">CEX 价差</span>}
              {!closed && p.source === "staking" && <span className="tag-muted">质押中</span>}
            </div>
            <div className="mt-0.5 text-xs text-ink-soft">
              {p.chain_name} · {dexLabel} · #{p.token_id}
            </div>
          </div>
        </div>

      <div className="space-y-1 text-sm">
        <Row label="交易对">
          <span title={`${p.token0} / ${p.token1}`}>
            {pair} · fee {(p.fee / 10000).toFixed(2)}%
          </span>
        </Row>
        <Row label="当前 tick">
          <span className={inRange ? "" : "text-warn font-semibold"}>{p.last_current_tick}</span>
        </Row>
        <Row label="区间">[{p.tick_lower}, {p.tick_upper}]</Row>
        <Row label="价格">1 {displaySym0} ≈ {displayPrice0} {displaySym1}</Row>
        {cexInfo && displayToken0Cex && displayToken1Cex && (
          <Row label={`CEX 汇率 (${displayToken0Cex}÷${displayToken1Cex})`}>
            <span>1 {displaySym0} = {fmtFull(displayCexRate)} {displaySym1}</span>
          </Row>
        )}
        {cexInfo && (
          <Row label="CEX差价">
            <span className={cexInfo.absDiff >= cexWarnThresh ? "text-warn font-semibold" : ""}>
              差 {pctSigned(cexInfo.diff)}
            </span>
            <span className="ml-1 text-ink-soft">{fmtFull(displayCexRate)}</span>
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
        <FlipButton positionId={p.id} currentFlip={!!p.pair_flip} onFlipped={onFlipped} />
      </div>

      {!closed && <LiquidityButton positionId={p.id} staking={p.source === "staking"} />}
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
