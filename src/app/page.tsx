"use client";
import { useState, useEffect, useRef } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, timeAgo, fmtFull } from "@/components/util";
import { SwapQuoteSection } from "@/components/swap-quote-section";
import { useWallet } from "@/lib/wallet/use-wallet";
import { LiquidityButton } from "@/components/liquidity-button";
import { LiquidityProbe } from "@/components/liquidity-probe";
import { RemovePositionButton } from "@/components/remove-position-button";
import { Field } from "@/components/form";

/** 推送冷却可选值（分钟） */
const COOLDOWN_OPTIONS = [0, 2, 5, 10, 20, 30, 60];

/** 将常见的 cron 表达式转为人类可读标签 */
function cronToLabel(cron: string): string {
  const m = cron.trim();
  const sixStarSlash = m.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*\s+\*$/);
  if (sixStarSlash) {
    const n = Number(sixStarSlash[1]);
    if (n < 60) return `${n} 秒`;
    if (n % 60 === 0)
      return n % 3600 === 0 ? `${n / 3600} 小时` : `${n / 60} 分钟`;
    return `${n} 秒`;
  }
  const starSlash = m.match(/^\*\/(\d+)\s+\*\s+\*\s+\*\s+\*$/);
  if (starSlash) {
    const n = Number(starSlash[1]);
    if (n >= 60) return `${Math.round(n / 60)} 小时`;
    return `${n} 分钟`;
  }
  if (m === "0 * * * *") return "1 小时";
  return m;
}

interface Position {
  id: number;
  dex_name: string;
  dex_display_name?: string;
  dex_id?: number;
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
  chain_id_ref: number;
  chain_name: string;
  chain_key: string;
  chain_id: number;
  explorer_url: string;
  wallet_label: string;
  wallet_address: string;
  last_alert_type?: string;
  last_cex_price?: string;
  pair_flip?: number;
  cex_alert_muted?: number;
}

interface MonitorState {
  combinedRunning: boolean;
  fullRunning: boolean;
  combinedCron: string;
  fullCron: string;
  lastCombined: any;
  lastFull: any;
}

export default function DashboardPage() {
  const { data: positions, mutate: reloadPos } = useSWR<Position[]>(
    "/api/positions",
    fetcher,
    { refreshInterval: 60_000 }
  );
  const { data: closedPositions } = useSWR<Position[]>(
    "/api/positions?all=1",
    fetcher,
    { refreshInterval: 60_000 }
  );
  const { data: mon, mutate: reloadMon } = useSWR<MonitorState>(
    "/api/monitor",
    fetcher,
    { refreshInterval: 10_000 }
  );

  const list = positions ?? [];
  const outOfRange = list.filter((p) => p.last_in_range === 0);
  const closed = (closedPositions ?? []).filter(
    (p) => p.notify_state === "closed"
  );
  const [showClosed, setShowClosed] = useState(false);
  const [showScanSettings, setShowScanSettings] = useState(false);
  const [showPortfolio, setShowPortfolio] = useState(false);

  // 从仓位卡片触发「撤池并重开」时，同步传给右侧三段式工作台并滚动过去
  const [externalPool, setExternalPool] = useState<{
    chainId: number;
    pool: string;
    ts: number;
  } | null>(null);
  const probeRef = useRef<HTMLDivElement | null>(null);

  function handleReopenPool(chainId: number, pool: string) {
    setExternalPool({ chainId, pool, ts: Date.now() });
    probeRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function triggerUnifiedScan() {
    const r = await fetch("/api/monitor", {
      method: "POST",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ mode: "combined" }),
    });
    const j = await r.json();
    if (!j.ok) alert(j.error);
    reloadPos();
    reloadMon();
    setTimeout(() => {
      reloadPos();
      reloadMon();
    }, 3_000);
    setTimeout(() => {
      reloadPos();
      reloadMon();
    }, 8_000);
  }

  const isScanning = !!(mon?.combinedRunning || mon?.fullRunning);
  const lastScanDuration = mon?.lastCombined?.durationMs
    ? ` (${(mon.lastCombined.durationMs / 1000).toFixed(1)}s)`
    : "";

  return (
    <div className="space-y-4">
      {/* 顶部极速状态控制条（单一极速扫描模式） */}
      <div className="card flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex flex-wrap items-center gap-5">
          <Stat label="监控仓位" value={list.length} />
          <Stat
            label="越界"
            value={outOfRange.length}
            danger={outOfRange.length > 0}
          />
          <div className="text-xs sm:text-sm text-ink-soft">
            <span>极速扫描：</span>
            <span className="text-ink font-medium">
              {mon?.combinedCron ? cronToLabel(mon.combinedCron) : "—"}
            </span>
            {isScanning ? (
              <span className="ml-2 text-cyan-300 font-medium">⚡ 扫描中…</span>
            ) : (
              <span className="ml-1">
                · 上次 {timeAgo(mon?.lastCombined?.startedAt)}
                <span className="font-mono text-ink-muted">
                  {lastScanDuration}
                </span>
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={() => setShowScanSettings((v) => !v)}
          >
            ⚙️ {showScanSettings ? "收起设置 ▲" : "频率与告警设置"}
          </button>
          <button
            type="button"
            className="btn-primary text-xs px-4"
            disabled={isScanning}
            onClick={triggerUnifiedScan}
            title="增量区块游标 + 质押合约活跃枚举 + 8 路并发读取，单次 2~4 秒完成全量同步"
          >
            {isScanning ? "⚡ 扫描中…" : "⚡ 立即扫描"}
          </button>
        </div>
      </div>

      {/* 扫描频率和告警阈值设置（按需展开，保持首屏紧凑） */}
      {showScanSettings && (
        <ScanIntervalAndAlerts
          combinedCron={mon?.combinedCron ?? ""}
          onChanged={() => reloadMon()}
        />
      )}

      {/* 双栏终端主布局：左侧 7 列实时仓位监控，右侧 5 列三段式操作工作台 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12 items-start">
        {/* ==================== 左栏（7/12）：LP 仓位监控 ==================== */}
        <div className="lg:col-span-7 space-y-5">
          {/* 越界告警区（如有） */}
          {outOfRange.length > 0 && (
            <section>
              <h2 className="mb-2.5 flex items-center gap-2 text-base font-semibold text-warn">
                ⚠️ 越界仓位（{outOfRange.length}）
              </h2>
              <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
                {outOfRange.map((p) => (
                  <PositionCard
                    key={p.id}
                    p={p}
                    highlight
                    onFlipped={reloadPos}
                    onReopenPool={handleReopenPool}
                  />
                ))}
              </div>
            </section>
          )}

          {/* 全部仓位 */}
          <section>
            <h2 className="mb-2.5 text-base font-semibold text-ink">
              全部监控仓位（{list.length}）
            </h2>
            {list.length === 0 ? (
              <EmptyHint />
            ) : (
              <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2">
                {list.map((p) => (
                  <PositionCard
                    key={p.id}
                    p={p}
                    onFlipped={reloadPos}
                    onReopenPool={handleReopenPool}
                  />
                ))}
              </div>
            )}
          </section>

          {/* 已平仓仓位（折叠） */}
          {closed.length > 0 && (
            <section>
              <button
                type="button"
                className="mb-2 flex items-center gap-2 text-sm font-medium text-ink-soft hover:text-ink"
                onClick={() => setShowClosed(!showClosed)}
              >
                <span
                  className={`transition-transform ${
                    showClosed ? "rotate-90" : ""
                  }`}
                >
                  ▶
                </span>
                已平仓归档仓位（{closed.length}）
              </button>
              {showClosed && (
                <div className="grid grid-cols-1 gap-3.5 xl:grid-cols-2 opacity-75">
                  {closed.map((p) => (
                    <PositionCard
                      key={p.id}
                      p={p}
                      closed
                      onFlipped={reloadPos}
                    />
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        {/* ==================== 右栏（5/12）：三段式联动工作台（探针 -> 建仓 -> Swap） ==================== */}
        <div className="lg:col-span-5 space-y-4 lg:sticky lg:top-4">
          <div ref={probeRef}>
            <LiquidityProbe externalPool={externalPool} />
          </div>

          {/* 链上资产统计（可折叠抽屉） */}
          <div className="card p-4">
            <div className="flex items-center justify-between">
              <span className="text-sm font-semibold text-ink">
                📊 链上钱包资产统计
              </span>
              <button
                type="button"
                className="btn-ghost btn-xs"
                onClick={() => setShowPortfolio((v) => !v)}
              >
                {showPortfolio ? "收起 ▲" : "展开查询 ▼"}
              </button>
            </div>
            {showPortfolio && (
              <div className="mt-3">
                <PortfolioSection />
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 底部版本号 */}
      <div className="text-center text-xs text-ink-muted">
        LP Monitor v{process.env.NEXT_PUBLIC_VERSION || "0.19.0"}
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  danger,
}: {
  label: string;
  value: number;
  danger?: boolean;
}) {
  return (
    <div>
      <div
        className={`text-2xl font-bold font-mono ${
          danger ? "text-warn" : "text-ink"
        }`}
      >
        {value}
      </div>
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
  const { address: walletAddr } = useWallet();
  const [chainId, setChainId] = useState<number | "">("");
  const [addr, setAddr] = useState("");
  useEffect(() => {
    if (walletAddr && !addr) setAddr(walletAddr);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletAddr]);
  const [query, setQuery] = useState<{
    chainId: number;
    addr: string;
    seq: number;
  } | null>(null);
  const [history, setHistory] = useState<
    { chainId: number; chainName: string; address: string; ts: number }[]
  >([]);
  const [erc20Open, setErc20Open] = useState(true);
  const { data, error, isLoading } = useSWR<PortfolioResult>(
    query
      ? `/api/portfolio?chain_id=${query.chainId}&address=${encodeURIComponent(
          query.addr
        )}&_=${query.seq}`
      : null,
    fetcher
  );

  useEffect(() => {
    try {
      const raw = localStorage.getItem("lp_monitor_portfolio_history");
      if (raw) setHistory(JSON.parse(raw));
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (!data || !query) return;
    const chainName =
      (chains ?? []).find((c: any) => c.id === query.chainId)?.name ??
      `chain#${query.chainId}`;
    setHistory((prev) => {
      const next = [
        { chainId: query.chainId, chainName, address: query.addr, ts: Date.now() },
        ...prev.filter(
          (h) =>
            !(
              h.chainId === query.chainId &&
              (h.address || "").toLowerCase() ===
                (query.addr || "").toLowerCase()
            )
        ),
      ].slice(0, 10);
      try {
        localStorage.setItem(
          "lp_monitor_portfolio_history",
          JSON.stringify(next)
        );
      } catch {
        /* ignore */
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  function removeHistory(ts: number) {
    setHistory((prev) => {
      const next = prev.filter((h) => h.ts !== ts);
      try {
        localStorage.setItem(
          "lp_monitor_portfolio_history",
          JSON.stringify(next)
        );
      } catch {
        /* ignore */
      }
      return next;
    });
  }

  function clearHistory() {
    setHistory([]);
    try {
      localStorage.removeItem("lp_monitor_portfolio_history");
    } catch {
      /* ignore */
    }
  }

  function doQuery() {
    if (!chainId || !/^0x[a-fA-F0-9]{40}$/.test(addr.trim())) return;
    setQuery((prev) => ({
      chainId: Number(chainId),
      addr: addr.trim(),
      seq: (prev?.seq ?? 0) + 1,
    }));
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">链上资产统计</h2>
      <p className="mb-3 text-xs text-ink-soft">
        选择链并输入钱包地址，实时统计该钱包的 GAS 余额、ERC20 代币余额 + LP 仓位价值（含直接持有与质押，按 CEX 报价折算）。
      </p>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-[1fr_2fr_auto]">
        <Field label="链">
          <select
            className="input"
            value={chainId}
            onChange={(e) =>
              setChainId(e.target.value ? Number(e.target.value) : "")
            }
          >
            <option value="">选择链</option>
            {(chains ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="钱包地址">
          <input
            className="input font-mono"
            value={addr}
            onChange={(e) => setAddr(e.target.value)}
            placeholder="0x…"
          />
        </Field>
        <div className="flex items-end">
          <button
            className="btn-primary w-full h-[32px]"
            onClick={doQuery}
            disabled={!chainId || !addr}
          >
            统计
          </button>
        </div>
      </div>

      {/* 最近查询记录 */}
      {history.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-soft">最近查询：</span>
          {history.map((h) => (
            <span
              key={h.ts}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/[0.12] bg-surface-raised px-2.5 py-1 text-xs"
            >
              <button
                className="text-ink hover:text-cyan-300 transition-colors"
                title={`${h.chainName} · ${h.address}`}
                onClick={() => {
                  setChainId(h.chainId);
                  setAddr(h.address);
                  setQuery({
                    chainId: h.chainId,
                    addr: h.address,
                    seq: Date.now(),
                  });
                }}
              >
                {h.chainName} · {short(h.address)}
              </button>
              <button
                className="text-ink-muted hover:text-rose-400"
                onClick={() => removeHistory(h.ts)}
              >
                ×
              </button>
            </span>
          ))}
          <button
            className="text-xs text-ink-soft hover:text-warn"
            onClick={clearHistory}
          >
            清空
          </button>
        </div>
      )}

      {isLoading && (
        <p className="text-sm text-ink-soft">
          统计中…（需读取链上余额与池子状态）
        </p>
      )}
      {error && (
        <p className="text-sm text-warn">❌ {(error as any)?.message ?? error}</p>
      )}
      {data && !isLoading && (
        <>
          {data.items.length === 0 ? (
            <p className="text-sm text-ink-soft">
              未发现资产（该钱包未登记或无仓位）。
            </p>
          ) : (
            (() => {
              const nativeItems = data.items.filter(
                (it) => it.kind === "native"
              );
              const erc20Items = data.items.filter((it) => it.kind === "erc20");
              const lpItems = data.items.filter((it) => it.kind === "lp");
              return (
                <div className="overflow-hidden rounded-lg border border-white/[0.1] bg-surface-raised/60">
                  {/* GAS 原生代币 */}
                  {nativeItems.map((it, i) => (
                    <div
                      key={`native-${i}`}
                      className="flex items-center justify-between bg-surface-raised px-3.5 py-2 text-sm"
                    >
                      <span className="font-medium text-ink">
                        {it.symbol}
                        <span className="ml-1 font-mono text-ink-soft">
                          : {it.amount}
                        </span>
                      </span>
                      <span
                        className={`font-mono ${
                          it.valueUsd === null ? "text-ink-soft" : "text-ink"
                        }`}
                      >
                        {it.valueUsd === null
                          ? "—"
                          : `${it.valueUsd.toFixed(1)}U`}
                      </span>
                    </div>
                  ))}
                  {/* ERC20 代币折叠区域 */}
                  {erc20Items.length > 0 && (
                    <>
                      <div className="flex items-center justify-between border-t border-white/[0.08] px-3.5 py-1.5 text-xs">
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
                      {erc20Open &&
                        erc20Items.map((it, i) => (
                          <div
                            key={`erc20-${i}`}
                            className="flex items-center justify-between px-3.5 py-2 text-sm border-t border-white/[0.04]"
                          >
                            <span className="font-medium text-ink">
                              {it.symbol}
                              <span className="ml-1 font-mono text-ink-soft">
                                : {it.amount}
                              </span>
                            </span>
                            <span
                              className={`font-mono ${
                                it.valueUsd === null
                                  ? "text-ink-soft"
                                  : "text-ink"
                              }`}
                            >
                              {it.valueUsd === null
                                ? "—"
                                : `${it.valueUsd.toFixed(1)}U`}
                            </span>
                          </div>
                        ))}
                    </>
                  )}
                  {/* LP 仓位 */}
                  {lpItems.map((it, i) => (
                    <div key={`lp-${i}`}>
                      <div className="flex items-center justify-between border-t border-white/[0.08] px-3.5 py-2 text-sm">
                        <span className="font-medium text-ink">{it.symbol}</span>
                        <span
                          className={`font-mono font-semibold ${
                            it.valueUsd === null
                              ? "text-ink-soft"
                              : "text-cyan-300"
                          }`}
                        >
                          {it.valueUsd === null
                            ? "—"
                            : `${it.valueUsd.toFixed(1)}U`}
                        </span>
                      </div>
                      {it.subItems?.map((s, j) => (
                        <div
                          key={j}
                          className="flex items-center justify-between px-3.5 py-1.5 pl-6 text-xs text-ink-soft font-mono"
                        >
                          <span>
                            {s.symbol}: {s.amount}
                          </span>
                          <span>
                            {s.valueUsd === null
                              ? "—"
                              : `${s.valueUsd.toFixed(1)}U`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                  {/* 总价值 */}
                  <div className="flex items-center justify-between border-t border-white/[0.1] bg-surface-raised px-3.5 py-2.5 text-sm font-bold">
                    <span className="text-ink">总价值</span>
                    <span className="font-mono text-ok text-base">
                      {data.totalUsd.toFixed(1)}U
                    </span>
                  </div>
                </div>
              );
            })()
          )}
          {data.warnings.length > 0 && (
            <div className="mt-2 space-y-0.5">
              {data.warnings.map((w, i) => (
                <p key={i} className="text-xs text-warn">
                  ⚠ {w}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ScanIntervalAndAlerts({
  combinedCron,
  onChanged,
}: {
  combinedCron: string;
  onChanged: () => void;
}) {
  const [preset, setPreset] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const { data: alertData, mutate: mutateAlerts } = useSWR<any>(
    "/api/alert-settings",
    fetcher
  );
  const [tickThreshold, setTickThreshold] = useState("");

  async function applyScanInterval(intervalSec: number) {
    setBusy(true);
    setMsg("");
    try {
      const body: any =
        intervalSec >= 60
          ? { intervalMin: Math.floor(intervalSec / 60) }
          : { cron: `*/${intervalSec} * * * * *` };
      const r = await fetch("/api/monitor", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 扫描频率已更新`);
      setPreset("");
      onChanged();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleTick() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          tick_move_enabled: alertData?.tick_move_enabled ? "0" : "1",
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function toggleCex() {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          cex_price_enabled: alertData?.cex_price_enabled ? "0" : "1",
        }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyThreshold(threshold?: number) {
    setBusy(true);
    setMsg("");
    try {
      const body: any = {};
      if (threshold !== undefined) body.tick_move_threshold = threshold;
      else if (tickThreshold !== "")
        body.tick_move_threshold = Number(tickThreshold);
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(body),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 阈值已更新");
      setTickThreshold("");
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  async function applyCooldown(
    field: "cooldown_cex" | "cooldown_range_state" | "cooldown_tick_move",
    minutes: number
  ) {
    setBusy(true);
    setMsg("");
    try {
      const r = await fetch("/api/alert-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ [field]: minutes }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg(`✅ 冷却时间已更新为 ${minutes} 分钟`);
      mutateAlerts();
    } catch (e: any) {
      setMsg(`❌ ${e.message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card p-4">
      <div className="flex flex-wrap items-center gap-4">
        {/* 扫描频率 */}
        <div className="flex items-center gap-2 border-r border-white/[0.1] pr-4">
          <span className="text-sm font-medium">扫描频率：</span>
          <span className="text-sm text-cyan-300 font-medium">
            {combinedCron ? cronToLabel(combinedCron) : "—"}
          </span>
          <select
            className="input max-w-[120px] text-xs"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
          >
            <option value="">设置频率…</option>
            <option value="30">30 秒</option>
            <option value="60">1 分钟</option>
            <option value="120">2 分钟</option>
            <option value="180">3 分钟</option>
            <option value="240">4 分钟</option>
            <option value="300">5 分钟</option>
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">告警阈值：</span>

          <button
            className={
              alertData?.tick_move_enabled
                ? "btn-primary text-xs"
                : "btn-ghost text-xs"
            }
            disabled={busy}
            onClick={toggleTick}
          >
            {alertData?.tick_move_enabled ? "波动预警：开" : "波动预警：关"}
          </button>

          <span className="text-xs text-ink-soft">阈值</span>
          <select
            className="input max-w-[80px] text-xs"
            value={tickThreshold || (alertData?.tick_move_threshold ?? 5)}
            disabled={busy}
            onChange={(e) => {
              setTickThreshold(e.target.value);
              applyThreshold(Number(e.target.value));
            }}
          >
            {[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => (
              <option key={n} value={n}>
                {n}%
              </option>
            ))}
          </select>

          <button
            className={
              alertData?.cex_price_enabled
                ? "btn-primary text-xs"
                : "btn-ghost text-xs"
            }
            disabled={busy}
            onClick={toggleCex}
          >
            {alertData?.cex_price_enabled ? "CEX 推送：开" : "CEX 推送：关"}
          </button>
          <span className="text-xs text-ink-soft">超过费率 2 倍时提醒</span>
        </div>

        {/* 推送冷却时间 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-medium">推送冷却：</span>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">CEX价差</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_cex ?? 2}
              onChange={(e) =>
                applyCooldown("cooldown_cex", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">区间状态</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_range_state ?? 30}
              onChange={(e) =>
                applyCooldown("cooldown_range_state", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1.5 text-xs">
            <span className="text-ink-soft">区间波动</span>
            <select
              className="input max-w-[92px] text-xs"
              value={alertData?.cooldown_tick_move ?? 0}
              onChange={(e) =>
                applyCooldown("cooldown_tick_move", Number(e.target.value))
              }
              disabled={busy}
            >
              {COOLDOWN_OPTIONS.map((m) => (
                <option key={m} value={m}>
                  {m === 0 ? "无冷却" : `${m}分钟`}
                </option>
              ))}
            </select>
          </label>
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
      <ol className="mx-auto inline-block list-decimal text-left text-sm space-y-1">
        <li>
          在{" "}
          <a className="underline text-cyan-300" href="/config">
            配置页
          </a>{" "}
          添加监控钱包
        </li>
        <li>确认链上有对应 DEX（默认 Ethereum / Uniswap V3）</li>
        <li>点击「立即扫描」或等待定时任务</li>
      </ol>
    </div>
  );
}

function FlipButton({
  positionId,
  currentFlip,
  onFlipped,
}: {
  positionId: number;
  currentFlip: boolean;
  onFlipped?: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleFlip = async () => {
    setLoading(true);
    try {
      const response = await fetch(`/api/positions/${positionId}/pair-flip`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ flip: !currentFlip }),
      });
      const result = await response.json();

      if (result.ok) {
        mutate("/api/liquidity-favorites");
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
      className={
        currentFlip ? "btn-secondary text-xs" : "btn-ghost text-xs"
      }
    >
      {loading ? "..." : currentFlip ? "还原" : "翻转"}
    </button>
  );
}

function CexAlertMuteButton({
  positionId,
  currentMuted,
  onToggled,
}: {
  positionId: number;
  currentMuted: boolean;
  onToggled?: () => void;
}) {
  const [loading, setLoading] = useState(false);

  const handleToggle = async () => {
    setLoading(true);
    try {
      const response = await fetch(
        `/api/positions/${positionId}/cex-alert-mute`,
        {
          method: "PUT",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ mute: !currentMuted }),
        }
      );
      const result = await response.json();

      if (result.ok) {
        onToggled?.();
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
      onClick={handleToggle}
      disabled={loading}
      title={
        currentMuted
          ? "点击恢复该交易对的 CEX 差价预警"
          : "点击静音该交易对的 CEX 差价预警"
      }
      className={`text-xs px-2.5 py-1 rounded-lg border transition-colors ${
        currentMuted
          ? "border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25"
          : "border-emerald-500/35 bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
      }`}
    >
      {loading ? "..." : currentMuted ? "预警:关" : "预警:开"}
    </button>
  );
}

function PositionCard({
  p,
  highlight,
  closed,
  onFlipped,
  onReopenPool,
}: {
  p: Position;
  highlight?: boolean;
  closed?: boolean;
  onFlipped?: () => void;
  onReopenPool?: (chainId: number, pool: string) => void;
}) {
  const { address: connectedWallet } = useWallet();
  const inRange = p.last_in_range === 1;
  const explorer = p.explorer_url?.replace(/\/$/, "");
  const dexLabel = p.dex_display_name || p.dex_name;
  const marginLower =
    ((p.last_current_tick - p.tick_lower) /
      Math.max(p.tick_upper - p.tick_lower, 1)) *
    100;
  const marginUpper =
    ((p.tick_upper - p.last_current_tick) /
      Math.max(p.tick_upper - p.tick_lower, 1)) *
    100;
  const sym0 = p.token0_symbol || short(p.token0);
  const sym1 = p.token1_symbol || short(p.token1);
  const pair = p.pair_flip ? `${sym1}/${sym0}` : `${sym0}/${sym1}`;
  const cexInfo = parseCexPrice(p.last_cex_price);
  const cexWarnThresh = 0.01;

  const walletDisplay = p.wallet_label
    ? `${p.wallet_label} (${short(p.wallet_address)})`
    : short(p.wallet_address);
  const isWalletMatched =
    !!connectedWallet &&
    !!p.wallet_address &&
    connectedWallet.toLowerCase() === p.wallet_address.toLowerCase();
  const isWalletMismatched =
    !!connectedWallet &&
    !!p.wallet_address &&
    connectedWallet.toLowerCase() !== p.wallet_address.toLowerCase();

  const flip = p.pair_flip === 1;
  const displaySym0 = flip ? sym1 : sym0;
  const displaySym1 = flip ? sym0 : sym1;
  const displayPrice0 = p.last_price0
    ? fmtFull(flip ? 1 / Number(p.last_price0) : Number(p.last_price0))
    : p.last_price0;
  const displayCexRate = cexInfo
    ? flip
      ? 1 / cexInfo.cexRate
      : cexInfo.cexRate
    : 0;
  const displayToken0Cex = cexInfo
    ? flip
      ? cexInfo.token1CexSymbol
      : cexInfo.token0CexSymbol
    : "";
  const displayToken1Cex = cexInfo
    ? flip
      ? cexInfo.token0CexSymbol
      : cexInfo.token1CexSymbol
    : "";

  return (
    <div
      className={`card p-4 ${
        closed
          ? "border-dashed border-white/[0.15] bg-surface-raised/50"
          : highlight
            ? "border-rose-500/60 shadow-[0_0_20px_-5px_rgba(244,63,94,0.3)]"
            : ""
      }`}
    >
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div className="flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="font-semibold text-base text-ink">{pair}</span>
            {p.pair_flip === 1 && (
              <span className="tag-info" title="交易对已翻转">
                翻转
              </span>
            )}
            {closed ? (
              <span className="tag-muted">已平仓</span>
            ) : inRange ? (
              <span className="tag-ok">在区间内</span>
            ) : (
              <span className="tag-danger">已越界</span>
            )}
            {!closed && p.last_alert_type === "tick_move" && (
              <span className="tag-info">波动</span>
            )}
            {!closed && p.last_alert_type === "cex_price" && (
              <span className="tag-warn">CEX 价差</span>
            )}
            {!closed && p.source === "staking" && (
              <span className="tag-muted">质押中</span>
            )}
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
          <span
            className={`font-mono ${
              inRange ? "text-ink" : "text-warn font-semibold"
            }`}
          >
            {p.last_current_tick}
          </span>
        </Row>
        <Row label="区间">
          <span className="font-mono">
            [{p.tick_lower}, {p.tick_upper}]
          </span>
        </Row>
        <Row label="价格">
          <span className="font-mono">
            1 {displaySym0} ≈ {displayPrice0} {displaySym1}
          </span>
        </Row>
        {cexInfo && displayToken0Cex && displayToken1Cex && (
          <Row label={`CEX 汇率 (${displayToken0Cex}÷${displayToken1Cex})`}>
            <span className="font-mono">
              1 {displaySym0} = {fmtFull(displayCexRate)} {displaySym1}
            </span>
          </Row>
        )}
        {cexInfo && (
          <Row label="CEX差价">
            <span
              className={`font-mono ${
                cexInfo.absDiff >= cexWarnThresh
                  ? "text-warn font-semibold"
                  : "text-ok"
              }`}
            >
              差 {pctSigned(cexInfo.diff)}
            </span>
            <span className="ml-1 font-mono text-ink-soft">
              {fmtFull(displayCexRate)}
            </span>
          </Row>
        )}

        {/* 区间位置可视化 */}
        <div className="pt-1.5 pb-0.5">
          <div className="relative h-2 w-full rounded bg-white/[0.1]">
            <div
              className="absolute inset-y-0 left-0 rounded bg-emerald-500/35"
              style={{
                width: `${
                  inRange
                    ? Math.min(Math.max(marginLower, 2), 98)
                    : marginLower < 0
                      ? 0
                      : 100
                }%`,
              }}
            />
            <div
              className="absolute top-1/2 h-3.5 w-1.5 -translate-y-1/2 rounded"
              style={{
                left: `${Math.min(
                  Math.max(
                    ((p.last_current_tick - p.tick_lower) /
                      Math.max(p.tick_upper - p.tick_lower, 1)) *
                      100,
                    0
                  ),
                  100
                )}%`,
                background: inRange ? "#10b981" : "#f43f5e",
              }}
            />
          </div>
          <div className="mt-1 flex justify-between text-[11px] font-mono text-ink-soft">
            <span>距下界 {marginLower.toFixed(1)}%</span>
            <span>距上界 {marginUpper.toFixed(1)}%</span>
          </div>
        </div>

        <Row label={p.source === "staking" ? "质押钱包" : "持仓钱包"}>
          <span
            className="inline-flex flex-wrap items-center justify-end gap-1.5 font-mono text-xs"
            title={p.wallet_address}
          >
            <span>{walletDisplay}</span>
            {!closed && isWalletMatched && (
              <span className="rounded bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-sans font-medium text-emerald-300 border border-emerald-500/35">
                ✓ 当前钱包
              </span>
            )}
            {!closed && isWalletMismatched && (
              <span
                className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-sans font-medium text-amber-200 border border-amber-500/40"
                title={`当前连接钱包为 ${short(connectedWallet!)}，与该仓位${p.source === "staking" ? "质押" : "持仓"}钱包不一致，无法直接解押`}
              >
                ⚠️ 非当前钱包
              </span>
            )}
          </span>
        </Row>
        <Row label="检查时间">{timeAgo(p.last_checked_at)}</Row>
        {p.source === "staking" && (
          <Row label="质押合约">
            <a
              className="underline font-mono text-cyan-300"
              href={`${explorer}/address/${p.staker_contract}`}
              target="_blank"
              rel="noreferrer"
            >
              {short(p.staker_contract)}
            </a>
          </Row>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-2 text-xs">
        {explorer && (
          <a
            className="btn-ghost text-xs"
            href={`${explorer}/address/${p.pool}`}
            target="_blank"
            rel="noreferrer"
          >
            查看 Pool
          </a>
        )}
        <FlipButton
          positionId={p.id}
          currentFlip={!!p.pair_flip}
          onFlipped={onFlipped}
        />
        <CexAlertMuteButton
          positionId={p.id}
          currentMuted={!!p.cex_alert_muted}
          onToggled={onFlipped}
        />
      </div>

      {!closed && (
        <LiquidityButton
          positionId={p.id}
          staking={p.source === "staking"}
          pairFlip={p.pair_flip}
        />
      )}

      {!closed && (
        <RemovePositionButton
          position={p}
          onRemoved={onFlipped}
          onReopenPool={
            onReopenPool
              ? (chainId, poolAddr) => onReopenPool(chainId, poolAddr)
              : undefined
          }
        />
      )}
    </div>
  );
}

function Row({
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

interface CexPricePayload {
  pairLabel: string;
  token0CexSymbol: string;
  token1CexSymbol: string;
  quote: string;
  dexRate: number;
  cexRate: number;
  diff: number;
  absDiff: number;
}

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

function pctSigned(x: number): string {
  return `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
}
