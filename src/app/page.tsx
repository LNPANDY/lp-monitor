"use client";
import { useState, useEffect, useMemo } from "react";
import useSWR, { mutate as globalMutate } from "swr";
import { fetcher, authHeaders, short, timeAgo, fmtFull } from "@/components/util";
import { LiquidityButton } from "@/components/liquidity-button";
import { LiquidityProbe } from "@/components/liquidity-probe";
import { SwapQuoteSection } from "@/components/swap-quote-section";
import { RemovePositionButton } from "@/components/remove-position-button";
import { toast } from "@/components/toast";

interface Position {
  id: number;
  chain_id_ref: number;
  chain_id: number;
  chain_name: string;
  explorer_url: string;
  dex_id: number | null;
  dex_name: string;
  dex_display_name?: string;
  wallet_address: string;
  wallet_label: string;
  pool: string;
  token_id: string;
  token0: string;
  token1: string;
  token0_symbol: string;
  token1_symbol: string;
  pair_flip: number;
  cex_alert_muted: number;
  fee: number;
  tick_lower: number;
  tick_upper: number;
  last_tick: number;
  last_liquidity: string;
  last_in_range: number;
  source: string;
  staker_contract: string;
  notify_state: string;
  last_checked_at: string;
  price_lower?: string;
  price_upper?: string;
  price_current?: string;
  cex_price?: string;
  dex_price?: string;
  cex_diff_ratio?: number;
  cex_quote?: string;
}

interface AlertSettings {
  tick_move_enabled: boolean;
  tick_move_threshold: number;
  cex_price_enabled: boolean;
  push_cooldown_minutes: number;
  cooldown_cex: number;
  cooldown_range_state: number;
  cooldown_tick_move: number;
}

type WorkbenchTab = "mint" | "swap" | "portfolio" | "all";
type PosFilter = "active" | "out" | "in" | "staked" | "closed";

export default function DashboardPage() {
  const { data: positions, mutate } = useSWR<Position[]>(
    "/api/positions?all=1",
    fetcher,
    { refreshInterval: 30_000 }
  );
  const { data: status, mutate: mStatus } = useSWR<any>(
    "/api/monitor",
    fetcher,
    { refreshInterval: 15_000 }
  );
  const { data: alertSettings, mutate: mAlertSettings } = useSWR<AlertSettings>(
    "/api/alert-settings",
    fetcher,
    { refreshInterval: 30_000 }
  );
  const [scanning, setScanning] = useState(false);

  // 左侧仓位矩阵筛选状态
  const [posFilter, setPosFilter] = useState<PosFilter>("active");
  const [chainFilter, setChainFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");

  // 右侧工作台标签状态（支持单面板切换或「全部同屏展开」）
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTab>("mint");
  // 当从左侧点击「撤池重开」或「载入建仓台」时传给右侧 LiquidityProbe & MintPositionPanel
  const [externalPool, setExternalPool] = useState<{
    chainId: number;
    pool: string;
    ts: number;
  } | null>(null);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(
        "lp_workbench_tab"
      ) as WorkbenchTab | null;
      if (saved && ["mint", "swap", "portfolio", "all"].includes(saved)) {
        setWorkbenchTab(saved);
      }
    } catch {}
  }, []);

  function switchWorkbenchTab(t: WorkbenchTab) {
    setWorkbenchTab(t);
    try {
      localStorage.setItem("lp_workbench_tab", t);
    } catch {}
  }

  function handleLoadPoolToWorkbench(chainIdRef: number, poolAddr: string) {
    setExternalPool({ chainId: chainIdRef, pool: poolAddr, ts: Date.now() });
    if (workbenchTab !== "mint" && workbenchTab !== "all") {
      switchWorkbenchTab("mint");
    }
    toast.info(`已将池 ${short(poolAddr)} 载入右侧建仓工作台`);
  }

  async function triggerScan(mode: "combined" | "deep" = "combined") {
    setScanning(true);
    try {
      const r = await fetch("/api/monitor", {
        method: "POST",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mode }),
      });
      const j = await r.json();
      await Promise.all([mutate(), mStatus()]);
      if (j.ok) {
        toast.success(mode === "deep" ? "深度全量发现完成" : "快速扫描完成");
      } else {
        toast.warn(j.error || "扫描任务进行中");
      }
    } catch (e: any) {
      toast.error(e.message || "扫描失败");
    } finally {
      setScanning(false);
    }
  }

  async function updateScanCron(cron: string) {
    await fetch("/api/monitor", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify({ cron }),
    });
    await mStatus();
    toast.info(`自动扫描周期已更新`);
  }

  async function updateAlertSettings(patch: Record<string, any>) {
    await fetch("/api/alert-settings", {
      method: "PUT",
      headers: authHeaders({ "Content-Type": "application/json" }),
      body: JSON.stringify(patch),
    });
    await mAlertSettings();
  }

  const allList = positions ?? [];
  const active = useMemo(
    () =>
      allList.filter(
        (p) =>
          p.notify_state !== "closed" &&
          p.last_liquidity !== "0" &&
          p.last_liquidity !== ""
      ),
    [allList]
  );
  const closed = useMemo(
    () =>
      allList.filter(
        (p) =>
          p.notify_state === "closed" ||
          p.last_liquidity === "0" ||
          p.last_liquidity === ""
      ),
    [allList]
  );
  const outOfRange = useMemo(
    () => active.filter((p) => p.last_in_range === 0),
    [active]
  );
  const inRange = useMemo(
    () => active.filter((p) => p.last_in_range === 1),
    [active]
  );
  const stakedPositions = useMemo(
    () => active.filter((p) => p.source === "staking" || !!p.staker_contract),
    [active]
  );

  const uniqueChains = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of allList) {
      if (p.chain_name) map.set(p.chain_name, p.chain_name);
    }
    return Array.from(map.keys());
  }, [allList]);

  // 过滤与排序后的展示列表（越界告警永远优先置顶）
  const filteredPositions = useMemo(() => {
    let base: Position[] = [];
    if (posFilter === "active") {
      base = [...outOfRange, ...inRange];
    } else if (posFilter === "out") {
      base = outOfRange;
    } else if (posFilter === "in") {
      base = inRange;
    } else if (posFilter === "staked") {
      base = stakedPositions;
    } else {
      base = closed;
    }

    if (chainFilter !== "all") {
      base = base.filter((p) => p.chain_name === chainFilter);
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter(
        (p) =>
          p.token_id.toLowerCase().includes(q) ||
          (p.token0_symbol || "").toLowerCase().includes(q) ||
          (p.token1_symbol || "").toLowerCase().includes(q) ||
          (p.pool || "").toLowerCase().includes(q) ||
          (p.dex_name || "").toLowerCase().includes(q) ||
          (p.wallet_label || "").toLowerCase().includes(q)
      );
    }
    return base;
  }, [
    posFilter,
    outOfRange,
    inRange,
    stakedPositions,
    closed,
    chainFilter,
    searchQuery,
  ]);

  const isRunning = scanning || status?.combinedRunning || status?.fullRunning;

  return (
    <div className="space-y-4">
      {/* ============ 顶部紧凑型全局控制台 ============ */}
      <div className="card px-3.5 py-2.5 flex flex-wrap items-center justify-between gap-3">
        {/* 左侧：实时核心指标 + 扫描触发器 */}
        <div className="flex flex-wrap items-center gap-2">
          {/* 指标胶囊 */}
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-surface-raised/70 px-2.5 py-1 text-xs">
            <span className="text-ink-soft">监控中</span>
            <span className="font-mono font-bold text-ink">{active.length}</span>
            <span className="text-white/15">|</span>
            <span className="text-ink-soft">越界</span>
            <span
              className={`font-mono font-bold ${
                outOfRange.length > 0 ? "text-danger" : "text-ok"
              }`}
            >
              {outOfRange.length}
            </span>
            <span className="text-white/15">|</span>
            <span className="text-ink-soft">质押</span>
            <span className="font-mono font-bold text-brand-light">
              {stakedPositions.length}
            </span>
          </div>

          <button
            type="button"
            className="btn-primary btn-xs py-1.5 px-2.5"
            onClick={() => triggerScan("combined")}
            disabled={isRunning}
            title="快速增量发现新仓位并扫描所有活跃仓位最新 Tick 与 CEX 差价"
          >
            {isRunning ? "⟳ 扫描中…" : "⚡ 快速扫描"}
          </button>

          <button
            type="button"
            className="btn-ghost btn-xs py-1.5"
            onClick={() => triggerScan("deep")}
            disabled={isRunning}
            title="全量深度回溯链上历史事件，发现早期鑄造或质押的仓位"
          >
            🔍 深度发现
          </button>

          <div className="flex items-center gap-1 text-xs text-ink-soft">
            <span>轮询</span>
            <select
              className="input h-7 w-24 px-1.5 py-0 text-xs font-mono"
              value={status?.combinedCron ?? "* * * * *"}
              onChange={(e) => updateScanCron(e.target.value)}
            >
              <option value="*/30 * * * * *">30秒</option>
              <option value="* * * * *">1分钟</option>
              <option value="*/2 * * * *">2分钟</option>
              <option value="*/5 * * * *">5分钟</option>
              <option value="*/10 * * * *">10分钟</option>
            </select>
          </div>

          {status?.lastCombined?.at && (
            <span className="text-[11px] text-ink-muted hidden xl:inline">
              上次 {timeAgo(status.lastCombined.at)}
            </span>
          )}
        </div>

        {/* 右侧：预警开关 & 冷却时间（已按要求移除「区间波动冷却」下拉框，tick_move 无冷却） */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          {/* 区间内 Tick 波动预警 */}
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-surface-raised/50 px-2 py-1">
            <label className="flex items-center gap-1 text-ink-soft cursor-pointer">
              <input
                type="checkbox"
                checked={alertSettings?.tick_move_enabled ?? false}
                onChange={(e) =>
                  updateAlertSettings({
                    tick_move_enabled: e.target.checked ? "1" : "0",
                  })
                }
              />
              <span>Tick波动推送</span>
            </label>
            <select
              className="input h-6 w-20 px-1 py-0 text-[11px] font-mono"
              value={alertSettings?.tick_move_threshold ?? 1}
              disabled={!alertSettings?.tick_move_enabled}
              onChange={(e) =>
                updateAlertSettings({
                  tick_move_threshold: Number(e.target.value),
                })
              }
            >
              <option value={0}>任意变动</option>
              <option value={1}>≥1 tick</option>
              <option value={2}>≥2 ticks</option>
              <option value={5}>≥5 ticks</option>
              <option value={10}>≥10 ticks</option>
            </select>
          </div>

          {/* CEX 差价推送总开关 */}
          <label className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-surface-raised/50 px-2.5 py-1 text-ink-soft cursor-pointer">
            <input
              type="checkbox"
              checked={alertSettings?.cex_price_enabled ?? true}
              onChange={(e) =>
                updateAlertSettings({
                  cex_price_enabled: e.target.checked ? "1" : "0",
                })
              }
            />
            <span>CEX差价推送</span>
          </label>

          {/* 冷却设置（仅保留 CEX价差 与 区间越界状态，区间波动无冷却） */}
          <div className="flex items-center gap-1.5 rounded-lg border border-white/[0.07] bg-surface-raised/50 px-2 py-1 text-[11px] text-ink-soft">
            <span>冷却:</span>
            <span>CEX</span>
            <select
              className="input h-6 w-16 px-1 py-0 text-[11px] font-mono"
              value={alertSettings?.cooldown_cex ?? 5}
              onChange={(e) =>
                updateAlertSettings({ cooldown_cex: Number(e.target.value) })
              }
            >
              {[1, 2, 3, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
            <span>越界</span>
            <select
              className="input h-6 w-16 px-1 py-0 text-[11px] font-mono"
              value={alertSettings?.cooldown_range_state ?? 5}
              onChange={(e) =>
                updateAlertSettings({
                  cooldown_range_state: Number(e.target.value),
                })
              }
            >
              {[1, 2, 3, 5, 10, 15, 30, 60].map((m) => (
                <option key={m} value={m}>
                  {m}m
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* ============ 主工作区：左 7 列仓位监控矩阵 + 右 5 列一站式操作台 ============ */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-start">
        {/* ────── 左侧 7 列：LP 仓位实时监控与一键撤池矩阵 ────── */}
        <div className="lg:col-span-7 space-y-3">
          {/* 仓位筛选与搜索栏 */}
          <div className="card p-2.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1">
              {(
                [
                  {
                    key: "active" as PosFilter,
                    label: "全部活跃",
                    count: active.length,
                    badgeClass: "text-ink",
                  },
                  {
                    key: "out" as PosFilter,
                    label: "🚨 越界告警",
                    count: outOfRange.length,
                    badgeClass:
                      outOfRange.length > 0
                        ? "text-danger font-bold"
                        : "text-ink-soft",
                  },
                  {
                    key: "in" as PosFilter,
                    label: "✅ 区间内",
                    count: inRange.length,
                    badgeClass: "text-ok",
                  },
                  {
                    key: "staked" as PosFilter,
                    label: "🌾 质押中",
                    count: stakedPositions.length,
                    badgeClass: "text-brand-light",
                  },
                  {
                    key: "closed" as PosFilter,
                    label: "已归档",
                    count: closed.length,
                    badgeClass: "text-ink-muted",
                  },
                ] as const
              ).map((tab) => {
                const activeTab = posFilter === tab.key;
                return (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setPosFilter(tab.key)}
                    className={`rounded-lg px-2.5 py-1 text-xs font-medium transition flex items-center gap-1.5 ${
                      activeTab
                        ? "bg-brand/20 text-brand-light border border-brand/40 shadow-glow-cyan"
                        : "text-ink-soft hover:bg-white/[0.04] hover:text-ink border border-transparent"
                    }`}
                  >
                    <span>{tab.label}</span>
                    <span className={`font-mono text-[11px] ${tab.badgeClass}`}>
                      {tab.count}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center gap-1.5 flex-1 sm:flex-initial justify-end">
              {uniqueChains.length > 1 && (
                <select
                  className="input h-7 w-28 px-2 py-0 text-xs"
                  value={chainFilter}
                  onChange={(e) => setChainFilter(e.target.value)}
                >
                  <option value="all">全部链</option>
                  {uniqueChains.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              )}
              <input
                className="input h-7 w-36 sm:w-44 px-2.5 py-0 text-xs"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜币种 / #ID / 池…"
              />
            </div>
          </div>

          {/* 仓位卡片列表 */}
          {filteredPositions.length === 0 ? (
            <div className="card p-8 text-center space-y-2">
              <div className="text-sm font-medium text-ink">
                {active.length === 0
                  ? "当前暂无活跃 LP 仓位"
                  : "当前筛选条件下没有匹配的仓位"}
              </div>
              <p className="text-xs text-ink-soft">
                您可以在右侧「★ 收藏池工作台」点选任意池子一键建仓+质押，或点击上方「🔍 深度发现」同步链上已有仓位。
              </p>
            </div>
          ) : (
            <div className="space-y-2.5">
              {filteredPositions.map((p) => (
                <PositionCard
                  key={p.id}
                  p={p}
                  onMutate={() => mutate()}
                  onReopenPool={handleLoadPoolToWorkbench}
                />
              ))}
            </div>
          )}
        </div>

        {/* ────── 右侧 5 列：常驻粘性工作台（探针 + 建仓质押 + 兑换 + 资产统计） ────── */}
        <div className="lg:col-span-5 lg:sticky lg:top-16 space-y-3">
          {/* 工作台模块切换导航 */}
          <div className="card p-1.5 flex items-center justify-between gap-1">
            {(
              [
                { key: "mint" as WorkbenchTab, label: "🔬 探针 & 建仓质押" },
                { key: "swap" as WorkbenchTab, label: "💱 询价兑换" },
                { key: "portfolio" as WorkbenchTab, label: "📊 资产统计" },
                { key: "all" as WorkbenchTab, label: "📑 全部展开" },
              ] as const
            ).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => switchWorkbenchTab(t.key)}
                className={`flex-1 rounded-lg px-2 py-1.5 text-xs font-medium transition text-center ${
                  workbenchTab === t.key
                    ? "bg-brand/20 text-brand-light border border-brand/40 shadow-glow-cyan"
                    : "text-ink-soft hover:text-ink hover:bg-white/[0.04] border border-transparent"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* 模块 1：收藏池探针 + 一键建仓&质押 */}
          {(workbenchTab === "mint" || workbenchTab === "all") && (
            <LiquidityProbe externalPool={externalPool} />
          )}

          {/* 模块 2：多费率询价 & 兑换 */}
          {(workbenchTab === "swap" || workbenchTab === "all") && (
            <SwapQuoteSection />
          )}

          {/* 模块 3：监控钱包资产汇总统计 */}
          {(workbenchTab === "portfolio" || workbenchTab === "all") && (
            <PortfolioSection />
          )}
        </div>
      </div>
    </div>
  );
}

/* ============ 监控钱包资产统计面板（对齐 GET /api/portfolio?chain_id=N&address=0x...） ============ */
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
  const { data: wallets } = useSWR<any[]>("/api/wallets", fetcher);

  const [selectedChain, setSelectedChain] = useState<number>(0);
  const [selectedWallet, setSelectedWallet] = useState<string>("");
  const [customWallet, setCustomWallet] = useState<string>("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [result, setResult] = useState<PortfolioResult | null>(null);

  const enabledChains = (chains ?? []).filter((c) => c.enabled);
  const enabledWallets = (wallets ?? []).filter(
    (w) => w.enabled && (!selectedChain || w.chain_id_ref === selectedChain)
  );

  useEffect(() => {
    if (!selectedChain && enabledChains.length > 0) {
      setSelectedChain(enabledChains[0].id);
    }
  }, [selectedChain, enabledChains]);

  useEffect(() => {
    if (!selectedWallet && enabledWallets.length > 0) {
      setSelectedWallet(enabledWallets[0].address);
    }
  }, [selectedWallet, enabledWallets]);

  async function queryPortfolio() {
    const addr = (customWallet.trim() || selectedWallet).trim();
    if (!selectedChain || !addr) {
      toast.warn("请选择链并选择或输入钱包地址");
      return;
    }
    setLoading(true);
    setErr("");
    try {
      const sp = new URLSearchParams({
        chain_id: String(selectedChain),
        address: addr,
      });
      const r = await fetch(`/api/portfolio?${sp.toString()}`, {
        headers: authHeaders(),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "资产统计失败");
      setResult(j.data);
    } catch (e: any) {
      setErr(e.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  function fmtUsd(v: number | null | undefined) {
    if (v === null || v === undefined || !Number.isFinite(v)) return "—";
    return (
      "$" +
      v.toLocaleString("en-US", {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
    );
  }

  return (
    <div className="card p-3.5 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/[0.07] pb-2.5">
        <div>
          <h3 className="text-sm font-semibold text-ink">
            📊 钱包链上资产统计
          </h3>
          <p className="text-[11px] text-ink-muted">
            汇总 GAS 原生币、ERC20 余额与活跃 LP 拆解估值（已遵循交易对翻转）
          </p>
        </div>
        {result && (
          <div className="rounded-lg border border-ok/30 bg-ok/10 px-2.5 py-1 text-xs">
            <span className="text-ink-soft mr-1">总估值</span>
            <span className="font-mono font-bold text-ok">
              {fmtUsd(result.totalUsd)}
            </span>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-end">
        <div className="sm:col-span-4">
          <span className="label">链</span>
          <select
            className="input"
            value={selectedChain || ""}
            onChange={(e) => {
              setSelectedChain(Number(e.target.value));
              setSelectedWallet("");
              setResult(null);
            }}
          >
            {enabledChains.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-5">
          <span className="label">监控钱包</span>
          <select
            className="input"
            value={selectedWallet}
            onChange={(e) => {
              setSelectedWallet(e.target.value);
              setCustomWallet("");
              setResult(null);
            }}
          >
            <option value="">选择监控钱包…</option>
            {enabledWallets.map((w) => (
              <option key={w.id} value={w.address}>
                {w.label ? `${w.label} (${short(w.address)})` : short(w.address)}
              </option>
            ))}
          </select>
        </div>

        <div className="sm:col-span-3">
          <button
            type="button"
            className="btn-primary w-full h-[34px] text-xs"
            onClick={queryPortfolio}
            disabled={loading || !selectedChain}
          >
            {loading ? "统计中…" : "查询资产"}
          </button>
        </div>
      </div>

      <input
        className="input font-mono text-xs"
        value={customWallet}
        onChange={(e) => setCustomWallet(e.target.value)}
        placeholder="或粘贴任意钱包地址 0x… 进行即时盘点"
      />

      {err && <div className="text-xs text-danger">❌ {err}</div>}

      {result && (
        <div className="space-y-2 pt-1">
          {result.items.map((item, idx) => {
            const catLabel =
              item.kind === "native"
                ? "GAS"
                : item.kind === "lp"
                ? "LP 仓位"
                : "ERC20";
            const catClass =
              item.kind === "lp"
                ? "tag-info"
                : item.kind === "native"
                ? "tag-ok"
                : "tag-muted";

            return (
              <div
                key={`${item.kind}-${item.symbol}-${idx}`}
                className="rounded-lg border border-white/[0.07] bg-surface-raised/50 px-2.5 py-2 text-xs space-y-1"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className={catClass}>{catLabel}</span>
                    <span className="font-semibold text-ink truncate">
                      {item.symbol}
                    </span>
                    {item.kind !== "lp" && (
                      <span className="font-mono text-ink-soft">
                        {item.amount}
                      </span>
                    )}
                  </div>
                  <span className="font-mono font-semibold text-ok shrink-0">
                    {fmtUsd(item.valueUsd)}
                  </span>
                </div>

                {item.subItems && item.subItems.length > 0 && (
                  <div className="flex flex-wrap gap-3 pl-2 pt-1 border-t border-white/[0.05] text-[11px] font-mono text-ink-soft">
                    {item.subItems.map((sub, sIdx) => (
                      <span key={sIdx}>
                        {sub.amount} {sub.symbol}{" "}
                        {sub.valueUsd !== null ? `(${fmtUsd(sub.valueUsd)})` : ""}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ============ 单张 LP 仓位卡片（高对比度暗色终端风格 + 完整翻转统一） ============ */
function PositionCard({
  p,
  onMutate,
  onReopenPool,
}: {
  p: Position;
  onMutate: () => void;
  onReopenPool: (chainIdRef: number, pool: string) => void;
}) {
  const isClosed =
    p.notify_state === "closed" ||
    p.last_liquidity === "0" ||
    p.last_liquidity === "";
  const isOut = p.last_in_range === 0 && !isClosed;
  const isStaked = p.source === "staking" || !!p.staker_contract;

  const span = p.tick_upper - p.tick_lower;
  const rawPct = span > 0 ? ((p.last_tick - p.tick_lower) / span) * 100 : 50;
  const pct = Math.max(0, Math.min(100, rawPct));

  const sym0 = p.token0_symbol || short(p.token0);
  const sym1 = p.token1_symbol || short(p.token1);
  const flip = p.pair_flip === 1;

  // 原始数据库存的价格均为 1 token0 = ? token1
  const pLowerRaw = Number(p.price_lower ?? 0);
  const pUpperRaw = Number(p.price_upper ?? 0);
  const pCurrRaw = Number(p.price_current ?? p.dex_price ?? 0);

  // 根据 pair_flip 统一展示口径（flip=1 时 token1 为主币 Base，token0 为计价币 Quote）
  const baseSym = flip ? sym1 : sym0;
  const quoteSym = flip ? sym0 : sym1;
  const lowPrice = flip ? (pUpperRaw > 0 ? 1 / pUpperRaw : 0) : pLowerRaw;
  const highPrice = flip ? (pLowerRaw > 0 ? 1 / pLowerRaw : 0) : pUpperRaw;
  const currPrice = flip ? (pCurrRaw > 0 ? 1 / pCurrRaw : 0) : pCurrRaw;

  const pairLabel = `${baseSym}/${quoteSym}`;
  const feePct = p.fee
    ? `${(p.fee / 10000).toFixed(p.fee % 100 === 0 ? 2 : 4)}%`
    : "";
  const dexDisplay = p.dex_display_name || p.dex_name;

  async function toggleFlip() {
    try {
      const r = await fetch(`/api/positions/${p.id}/pair-flip`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ flip: !flip }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "翻转失败");
      onMutate();
      globalMutate("/api/liquidity-favorites");
      toast.success(
        `已切换计价方向：主币设为 ${!flip ? sym1 : sym0}（全局同步）`
      );
    } catch (e: any) {
      toast.error(e.message || "翻转失败");
    }
  }

  async function toggleCexMute() {
    try {
      const nextMute = p.cex_alert_muted !== 1;
      const r = await fetch(`/api/positions/${p.id}/cex-alert-mute`, {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ mute: nextMute }),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "操作失败");
      onMutate();
      toast.info(
        nextMute
          ? `已静音 ${pairLabel} 的 CEX 差价告警`
          : `已恢复 ${pairLabel} 的 CEX 差价告警`
      );
    } catch (e: any) {
      toast.error(e.message || "操作失败");
    }
  }

  const explorerLink =
    p.explorer_url && p.pool
      ? `${p.explorer_url.replace(/\/$/, "")}/address/${p.pool}`
      : null;

  const hasCex =
    p.cex_price !== undefined &&
    p.cex_price !== null &&
    p.cex_price !== "" &&
    Number(p.cex_price) > 0;
  const rawCexPrice = Number(p.cex_price ?? 0);
  const cexPriceDisplay =
    flip && rawCexPrice > 0 ? 1 / rawCexPrice : rawCexPrice;
  const cexDiffPct =
    p.cex_diff_ratio !== undefined && p.cex_diff_ratio !== null
      ? Math.abs(Number(p.cex_diff_ratio) * 100)
      : 0;
  const cexThresholdPct = p.fee ? (p.fee / 1_000_000) * 2 * 100 : 0.6;
  const cexExceeded = cexDiffPct >= cexThresholdPct;

  return (
    <div
      className={`rounded-xl border p-3.5 transition-all ${
        isOut
          ? "border-danger/60 bg-danger/[0.05] shadow-[0_0_20px_-6px_rgba(244,63,94,0.35)]"
          : "border-white/[0.08] bg-surface-card/90 hover:border-white/[0.15]"
      }`}
    >
      {/* 第一行：交易对 + 状态标签 + 链/DEX + 钱包 */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {isClosed ? (
            <span className="tag-muted">已归档</span>
          ) : isOut ? (
            <span className="tag-danger animate-pulse">🚨 越界告警</span>
          ) : (
            <span className="tag-ok">● 区间内</span>
          )}

          <span className="text-sm font-bold text-ink">{pairLabel}</span>
          {flip && (
            <span
              className="rounded bg-brand/15 px-1 text-[10px] font-mono text-brand-light"
              title="已翻转主币/计价币方向"
            >
              ⇄
            </span>
          )}
          {feePct && <span className="tag-muted font-mono">{feePct}</span>}

          <span className="font-mono text-xs text-ink-soft">#{p.token_id}</span>

          {isStaked && <span className="tag-info">🌾 质押中</span>}
        </div>

        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <span>
            {p.chain_name} · {dexDisplay}
          </span>
          <span className="text-white/15">|</span>
          <span className="font-mono">
            {p.wallet_label || short(p.wallet_address)}
          </span>
          {explorerLink && (
            <a
              href={explorerLink}
              target="_blank"
              rel="noreferrer"
              className="text-brand-light hover:underline"
              title="在区块浏览器查看池合约"
            >
              ↗
            </a>
          )}
          <span className="text-[11px] text-ink-muted">
            {timeAgo(p.last_checked_at)}
          </span>
        </div>
      </div>

      {/* 第二行：可视化价格与 Tick 区间进度条 */}
      <div className="mt-2.5 grid grid-cols-1 md:grid-cols-12 gap-2.5 items-center">
        {/* 价格与 CEX 差价详情 */}
        <div className="md:col-span-7 rounded-lg border border-white/[0.06] bg-surface-raised/60 px-2.5 py-2 text-xs space-y-1">
          <div className="flex flex-wrap items-center justify-between gap-1">
            <div>
              <span className="text-ink-muted">当前池价: </span>
              <span className="font-mono font-bold text-brand-light">
                {currPrice > 0
                  ? `1 ${baseSym} = ${fmtFull(currPrice)} ${quoteSym}`
                  : "—"}
              </span>
            </div>
            {lowPrice > 0 && highPrice > 0 && (
              <div className="font-mono text-[11px] text-ink-soft">
                区间: {fmtFull(lowPrice)} ~ {fmtFull(highPrice)}
              </div>
            )}
          </div>

          {/* CEX 差价对比行 */}
          {hasCex && (
            <div
              className={`flex flex-wrap items-center justify-between gap-1 pt-1 border-t border-white/[0.05] text-[11px] ${
                cexExceeded ? "text-warn font-medium" : "text-ink-soft"
              }`}
            >
              <span>
                📊 币安: 1 {baseSym} ={" "}
                <strong className="font-mono text-ink">
                  {fmtFull(cexPriceDisplay)}
                </strong>{" "}
                {quoteSym}
              </span>
              <span className="font-mono">
                差价 {cexDiffPct.toFixed(2)}%{" "}
                {cexExceeded ? (
                  <span className="text-warn font-bold">
                    ⚠️ 超阈值({cexThresholdPct.toFixed(2)}%)
                  </span>
                ) : (
                  <span className="text-ink-muted">
                    (阈值{cexThresholdPct.toFixed(2)}%)
                  </span>
                )}
              </span>
            </div>
          )}
        </div>

        {/* Tick 视觉滑轨 */}
        <div className="md:col-span-5 space-y-1">
          <div className="flex items-center justify-between font-mono text-[11px] text-ink-soft">
            <span>
              [{p.tick_lower}, {p.tick_upper}]
            </span>
            <span
              className={
                isOut ? "text-danger font-bold" : "text-ok font-semibold"
              }
            >
              Tick {p.last_tick}
            </span>
          </div>
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/[0.07]">
            <div className="absolute inset-y-0 left-[12%] right-[12%] bg-ok/25 rounded-full" />
            <div
              className={`absolute top-0 h-2.5 w-2 -translate-x-1/2 rounded-full transition-all ${
                isOut
                  ? "bg-danger shadow-[0_0_8px_#f43f5e]"
                  : "bg-ok shadow-[0_0_8px_#10b981]"
              }`}
              style={{
                left: `${
                  isOut
                    ? p.last_tick < p.tick_lower
                      ? 4
                      : 96
                    : 12 + pct * 0.76
                }%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* 第三行：快捷操作栏（翻转 / CEX静音 / 载入建仓台 / 深度分析 / 一键撤池 & 撤池重开） */}
      <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={toggleFlip}
            className={`btn-ghost btn-xs ${
              flip ? "border-brand/40 text-brand-light bg-brand/10" : ""
            }`}
            title="翻转该交易对的主币/计价币方向（自动同步至探针与建仓面板）"
          >
            ⇄ 翻转
          </button>

          <button
            type="button"
            onClick={toggleCexMute}
            className={`btn-ghost btn-xs ${
              p.cex_alert_muted === 1
                ? "border-warn/40 text-warn bg-warn/10"
                : ""
            }`}
            title="静音或恢复该交易对的 CEX 差价告警推送"
          >
            {p.cex_alert_muted === 1 ? "🔕 CEX已静音" : "🔔 CEX告警"}
          </button>

          {p.pool && (
            <button
              type="button"
              onClick={() => onReopenPool(p.chain_id_ref, p.pool)}
              className="btn-ghost btn-xs"
              title="将该仓位所在池载入右侧建仓台"
            >
              🎯 载入建仓台
            </button>
          )}

          {!isClosed && (
            <LiquidityButton positionId={p.id} pairFlip={p.pair_flip} />
          )}
        </div>

        {/* 右下角：一键撤池 & 撤池重开 */}
        {!isClosed && (
          <RemovePositionButton
            position={p}
            onRemoved={onMutate}
            onReopenPool={onReopenPool}
          />
        )}
      </div>
    </div>
  );
}
