"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, fmtFull } from "@/components/util";
import { api, Field } from "@/components/form";
import { EditableRow } from "@/components/editable-row";
import { toast } from "@/components/toast";

type ConfigTab = "all" | "wallets" | "chains" | "dexes" | "staking" | "cex" | "notify";

export default function ConfigPage() {
  const [activeTab, setActiveTab] = useState<ConfigTab>("all");

  const tabs: Array<{ key: ConfigTab; label: string }> = [
    { key: "all", label: "全部配置" },
    { key: "wallets", label: "👛 监控钱包" },
    { key: "chains", label: "⛓️ 链与 RPC" },
    { key: "dexes", label: "🦄 DEX 合约" },
    { key: "staking", label: "🌾 质押合约" },
    { key: "cex", label: "📊 CEX 报价映射" },
    { key: "notify", label: "🔔 通知渠道" },
  ];

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-ink">系统配置中心</h1>
          <p className="text-xs text-ink-soft">
            管理多链 RPC、DEX 路由、LP 质押池、监控钱包与币安报价映射
          </p>
        </div>
        <div className="flex flex-wrap gap-1 rounded-xl border border-white/[0.08] bg-surface-card/90 p-1">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActiveTab(t.key)}
              className={`rounded-lg px-2.5 py-1 text-xs font-medium transition ${
                activeTab === t.key
                  ? "bg-brand/20 text-brand-light border border-brand/40"
                  : "text-ink-soft hover:text-ink hover:bg-white/[0.04] border border-transparent"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      <IoSection />
      {(activeTab === "all" || activeTab === "wallets") && <WalletsSection />}
      {(activeTab === "all" || activeTab === "chains") && <ChainsSection />}
      {(activeTab === "all" || activeTab === "dexes") && <DexesSection />}
      {(activeTab === "all" || activeTab === "staking") && <StakingSection />}
      {(activeTab === "all" || activeTab === "cex") && <CexMappingSection />}
      {(activeTab === "all" || activeTab === "notify") && <NotifySection />}
    </div>
  );
}

/* ============ 配置导入/导出 ============ */
function IoSection() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function doExport() {
    setMsg("");
    setBusy(true);
    try {
      const r = await fetch("/api/config", { headers: authHeaders() });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const blob = new Blob([JSON.stringify(j.data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lp-monitor-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg("✅ 已导出完整配置文件（含链、DEX、质押、翻转状态与收藏池）");
      toast.success("配置文件已导出");
    } catch (e: any) {
      setMsg(`❌ 导出失败：${e.message}`);
      toast.error(e.message || "导出失败");
    } finally {
      setBusy(false);
    }
  }

  function doImportFile(file: File) {
    setMsg("");
    setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bundle = JSON.parse(String(reader.result));
        const r = await fetch("/api/config", {
          method: "POST",
          headers: authHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify(bundle),
        });
        const j = await r.json();
        if (!j.ok) throw new Error(j.error);
        const d = j.data;
        let extraInfo = "";
        if (d.pair_flips?.applied) extraInfo += `，翻转 +${d.pair_flips.applied}`;
        if (d.liquidity_favorites)
          extraInfo += `，收藏 +${d.liquidity_favorites.added}/~${d.liquidity_favorites.updated}`;
        const summary = `✅ 导入完成：链 +${d.chains.added}/~${d.chains.updated}，DEX +${d.dexes.added}/~${d.dexes.updated}，质押 +${d.staking.added}/~${d.staking.updated}，钱包 +${d.wallets.added}/~${d.wallets.updated}，CEX +${d.cex_mappings.added}/~${d.cex_mappings.updated}${extraInfo}`;
        setMsg(summary);
        toast.success("配置导入成功");
        mutate(
          (k: string) =>
            typeof k === "string" &&
            (k.includes("/api/chains") ||
              k.includes("/api/dexes") ||
              k.includes("/api/staking") ||
              k.includes("/api/wallets") ||
              k.includes("/api/cex-mapping") ||
              k.includes("/api/positions") ||
              k.includes("/api/liquidity-favorites")),
          undefined,
          { revalidate: true }
        );
      } catch (e: any) {
        setMsg(`❌ 导入失败：${e.message}`);
        toast.error(e.message || "导入失败");
      } finally {
        setBusy(false);
      }
    };
    reader.readAsText(file);
  }

  return (
    <section className="card p-4 flex flex-wrap items-center justify-between gap-3">
      <div className="space-y-0.5">
        <h2 className="text-sm font-semibold text-ink">📦 配置备份与迁移</h2>
        <p className="text-xs text-ink-soft">
          一键打包或恢复链、DEX（含 Quoter/Router）、质押合约、监控钱包、CEX 映射、<strong>交易对翻转状态</strong>及<strong>收藏池列表</strong>。
        </p>
        {msg && <p className="text-xs text-brand-light pt-1">{msg}</p>}
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button className="btn-primary text-xs" onClick={doExport} disabled={busy}>
          导出 JSON
        </button>
        <label className="btn-ghost text-xs cursor-pointer">
          导入 JSON
          <input
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) doImportFile(f);
              e.target.value = "";
            }}
          />
        </label>
      </div>
    </section>
  );
}

/* ============ 钱包 ============ */
function WalletsSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: wallets } = useSWR<any[]>("/api/wallets", fetcher, {
    refreshInterval: 30_000,
  });
  const [chainId, setChainId] = useState<number | "">("");
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      await api("/api/wallets", "POST", {
        chain_id: Number(chainId),
        address: addr,
        label,
      });
      setAddr("");
      setLabel("");
      mutate("/api/wallets");
      toast.success("已添加监控钱包");
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message);
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <h2 className="text-sm font-semibold text-ink">👛 监控钱包</h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
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
        <Field label="备注">
          <input
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="主挖矿钱包"
          />
        </Field>
        <div className="flex items-end">
          <button
            className="btn-primary w-full"
            onClick={add}
            disabled={!chainId || !addr}
          >
            添加钱包
          </button>
        </div>
      </div>
      {err && <p className="text-xs text-danger">{err}</p>}
      <div className="space-y-2">
        {(wallets ?? []).map((w: any) => (
          <EditableRow
            key={w.id}
            fields={[{ key: "label", label: "备注" }]}
            values={w}
            onSave={async (u) => {
              await api(`/api/wallets/${w.id}`, "PATCH", u);
              mutate("/api/wallets");
              toast.success("已更新钱包备注");
            }}
            display={
              <div className="flex flex-wrap items-center gap-2">
                <span className="tag-muted">{w.chain_name}</span>
                {w.label && (
                  <span className="font-semibold text-ink">{w.label}</span>
                )}
                <span className="font-mono text-xs text-ink-soft">
                  {w.address}
                </span>
              </div>
            }
            actions={
              <>
                <Toggle id={w.id} enabled={!!w.enabled} kind="wallets" />
                <button
                  className="btn-ghost btn-xs hover:text-danger"
                  onClick={async () => {
                    await api(`/api/wallets/${w.id}`, "DELETE");
                    mutate("/api/wallets");
                    toast.info("已删除监控钱包");
                  }}
                >
                  删除
                </button>
              </>
            }
          />
        ))}
        {(wallets ?? []).length === 0 && (
          <p className="text-xs text-ink-soft">暂无监控钱包。</p>
        )}
      </div>
    </section>
  );
}

/* ============ 链 ============ */
function ChainsSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [form, setForm] = useState({
    key: "",
    name: "",
    chain_id: "",
    rpc_urls: "",
    explorer_url: "",
    symbol: "",
  });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      await api("/api/chains", "POST", {
        key: form.key,
        name: form.name,
        chain_id: Number(form.chain_id),
        rpc_urls: form.rpc_urls.split(/[\s,]+/).filter(Boolean),
        explorer_url: form.explorer_url,
        symbol: form.symbol || "ETH",
      });
      setForm({
        key: "",
        name: "",
        chain_id: "",
        rpc_urls: "",
        explorer_url: "",
        symbol: "",
      });
      mutate("/api/chains");
      toast.success("已添加新链");
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message);
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">⛓️ 链与多节点 RPC</h2>
        <p className="text-xs text-ink-soft">
          支持任意 EVM 链，多个 RPC URL 用空格或逗号分隔，系统自动并发竞速与故障切换。
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="唯一标识 key">
          <input
            className="input"
            value={form.key}
            onChange={(e) => setForm({ ...form, key: e.target.value })}
            placeholder="0g / arbitrum"
          />
        </Field>
        <Field label="显示名称">
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="0G Mainnet"
          />
        </Field>
        <Field label="EVM Chain ID">
          <input
            className="input font-mono"
            value={form.chain_id}
            onChange={(e) => setForm({ ...form, chain_id: e.target.value })}
            placeholder="16661"
          />
        </Field>
        <Field label="RPC URL（多个用空格或逗号分隔）">
          <input
            className="input font-mono"
            value={form.rpc_urls}
            onChange={(e) => setForm({ ...form, rpc_urls: e.target.value })}
            placeholder="https://evmrpc.0g.ai"
          />
        </Field>
        <Field label="区块浏览器 URL">
          <input
            className="input font-mono"
            value={form.explorer_url}
            onChange={(e) =>
              setForm({ ...form, explorer_url: e.target.value })
            }
            placeholder="https://chainscan.0g.ai"
          />
        </Field>
        <Field label="原生 GAS 币符号">
          <input
            className="input"
            value={form.symbol}
            onChange={(e) => setForm({ ...form, symbol: e.target.value })}
            placeholder="0G / ETH"
          />
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="btn-primary text-xs"
          onClick={add}
          disabled={!form.key || !form.name || !form.chain_id}
        >
          添加链
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
      <div className="space-y-2">
        {(chains ?? []).map((c: any) => (
          <EditableRow
            key={c.id}
            fields={[
              { key: "name", label: "显示名" },
              {
                key: "rpc_urls",
                label: "RPC URL（多空格/逗号分隔）",
                placeholder: "https://...",
              },
              { key: "explorer_url", label: "区块浏览器" },
              { key: "symbol", label: "代币符号" },
            ]}
            values={c}
            onSave={async (u) => {
              if (u.rpc_urls) {
                u.rpc_urls = Array.isArray(u.rpc_urls)
                  ? u.rpc_urls
                  : u.rpc_urls.split(/[\s,]+/).filter(Boolean);
              }
              await api(`/api/chains/${c.id}`, "PATCH", u);
              mutate("/api/chains");
              toast.success("已更新链配置");
            }}
            disabled={!!c.is_default}
            display={
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{c.name}</span>
                {c.is_default ? <span className="tag-muted">内置</span> : null}
                <span className="font-mono text-xs text-ink-soft">
                  ChainID {c.chain_id} · {c.symbol} · {(c.rpc_urls ?? []).length} 个 RPC
                </span>
              </div>
            }
            actions={
              <>
                <Toggle
                  id={c.id}
                  enabled={!!c.enabled}
                  kind="chains"
                  disabled={!!c.is_default}
                />
                {!c.is_default && (
                  <button
                    className="btn-ghost btn-xs hover:text-danger"
                    onClick={async () => {
                      await api(`/api/chains/${c.id}`, "DELETE");
                      mutate("/api/chains");
                      toast.info("已删除链");
                    }}
                  >
                    删除
                  </button>
                )}
              </>
            }
          />
        ))}
      </div>
    </section>
  );
}

/* ============ DEX ============ */
function DexesSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const { data: dexes } = useSWR<any[]>(
    chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes",
    fetcher
  );
  const [form, setForm] = useState({
    name: "",
    factory: "",
    npm: "",
    type: "v3-fork",
    stateview: "",
    quoter: "",
    router02: "",
    swaprouter: "",
  });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      await api("/api/dexes", "POST", { chain_id: Number(chainId), ...form });
      setForm({
        name: "",
        factory: "",
        npm: "",
        type: "v3-fork",
        stateview: "",
        quoter: "",
        router02: "",
        swaprouter: "",
      });
      mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes");
      toast.success("已添加 DEX");
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message);
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">🦄 DEX（集中流动性）</h2>
        <p className="text-xs text-ink-soft">
          v3-fork：兼容 Uniswap V3 NPM 的 DEX（如 ZIA DEX），填写 Factory 与 NPM 即可支持建仓与撤池；配置 QuoterV2 与 SwapRouter 后即可在工作台直接询价与兑换。
        </p>
      </div>
      <div className="max-w-xs">
        <Field label="按链筛选 / 新增目标链">
          <select
            className="input"
            value={chainId}
            onChange={(e) =>
              setChainId(e.target.value ? Number(e.target.value) : "")
            }
          >
            <option value="">全部链</option>
            {(chains ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="DEX 名称">
          <input
            className="input"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="ZIA DEX"
          />
        </Field>
        <Field label={form.type === "v4" ? "PoolManager" : "Factory 地址"}>
          <input
            className="input font-mono"
            value={form.factory}
            onChange={(e) => setForm({ ...form, factory: e.target.value })}
            placeholder="0x…"
          />
        </Field>
        <Field label={form.type === "v4" ? "PositionManager" : "NPM 地址"}>
          <input
            className="input font-mono"
            value={form.npm}
            onChange={(e) => setForm({ ...form, npm: e.target.value })}
            placeholder="0x…"
          />
        </Field>
        <Field label="协议类型">
          <select
            className="input"
            value={form.type}
            onChange={(e) => setForm({ ...form, type: e.target.value })}
          >
            <option value="v3-fork">v3-fork</option>
            <option value="v4">v4</option>
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="QuoterV2 地址（兑换报价用）">
          <input
            className="input font-mono"
            value={form.quoter}
            onChange={(e) => setForm({ ...form, quoter: e.target.value })}
            placeholder="0x…"
          />
        </Field>
        <Field label="SwapRouter02 地址（无 deadline struct）">
          <input
            className="input font-mono"
            value={form.router02}
            onChange={(e) => setForm({ ...form, router02: e.target.value })}
            placeholder="0x…（可选）"
          />
        </Field>
        <Field label="SwapRouter 地址（经典带 deadline）">
          <input
            className="input font-mono"
            value={form.swaprouter}
            onChange={(e) => setForm({ ...form, swaprouter: e.target.value })}
            placeholder="0x…（可选）"
          />
        </Field>
      </div>
      {form.type === "v4" && (
        <Field label="StateView 地址（v4 必填）">
          <input
            className="input font-mono"
            value={form.stateview}
            onChange={(e) => setForm({ ...form, stateview: e.target.value })}
            placeholder="0x…"
          />
        </Field>
      )}
      <div className="flex items-center gap-2">
        <button
          className="btn-primary text-xs"
          onClick={add}
          disabled={
            !chainId ||
            !form.name ||
            !form.factory ||
            !form.npm ||
            (form.type === "v4" && !form.stateview)
          }
        >
          添加 DEX
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
      <div className="space-y-2">
        {(dexes ?? []).map((d: any) => (
          <EditableRow
            key={d.id}
            fields={[
              { key: "name", label: "名称" },
              {
                key: "factory",
                label: d.type === "v4" ? "PoolManager 地址" : "Factory 地址",
              },
              {
                key: "npm",
                label: d.type === "v4" ? "PositionManager 地址" : "NPM 地址",
              },
              { key: "quoter", label: "QuoterV2 地址" },
              { key: "router02", label: "SwapRouter02 地址" },
              { key: "swaprouter", label: "SwapRouter 地址" },
              ...(d.type === "v4"
                ? [{ key: "stateview", label: "StateView 地址" }]
                : []),
            ]}
            values={d}
            onSave={async (u) => {
              await api(`/api/dexes/${d.id}`, "PATCH", u);
              mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes");
              toast.success("已更新 DEX 配置");
            }}
            display={
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{d.name}</span>
                <span className="tag-muted">{d.chain_name}</span>
                <span className="tag-info font-mono">{d.type}</span>
                <span className="font-mono text-xs text-ink-soft">
                  NPM {short(d.npm)}
                </span>
                {d.quoter && <span className="tag-ok text-[10px]">可询价</span>}
                {(d.router02 || d.swaprouter) && (
                  <span className="tag-ok text-[10px]">可兑换</span>
                )}
              </div>
            }
            actions={
              <>
                <Toggle id={d.id} enabled={!!d.enabled} kind="dexes" />
                <button
                  className="btn-ghost btn-xs hover:text-danger"
                  onClick={async () => {
                    await api(`/api/dexes/${d.id}`, "DELETE");
                    mutate(
                      chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"
                    );
                    toast.info("已删除 DEX");
                  }}
                >
                  删除
                </button>
              </>
            }
          />
        ))}
      </div>
    </section>
  );
}

/* ============ 质押合约 ============ */
function StakingSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const { data: staking } = useSWR<any[]>(
    chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking",
    fetcher
  );
  const { data: dexes } = useSWR<any[]>(
    chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes",
    fetcher
  );
  const [form, setForm] = useState({
    platform: "",
    pair_label: "",
    contract: "",
    read_type: "deposits_owner",
    dex_id: "" as number | "",
  });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      const body: any = { chain_id: Number(chainId), ...form };
      body.dex_id = form.dex_id ? Number(form.dex_id) : null;
      await api("/api/staking", "POST", body);
      setForm({
        platform: "",
        pair_label: "",
        contract: "",
        read_type: "deposits_owner",
        dex_id: "",
      });
      mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking");
      toast.success("已添加流动性质押合约");
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message);
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">🌾 流动性质押合约</h2>
        <p className="text-xs text-ink-soft">
          添加后自动监控质押在其中的 LP NFT，并在建仓面板支持「Mint 后自动质押」及「免每次 NFT 授权」加速。
        </p>
      </div>
      <div className="max-w-xs">
        <Field label="按链筛选 / 新增目标链">
          <select
            className="input"
            value={chainId}
            onChange={(e) =>
              setChainId(e.target.value ? Number(e.target.value) : "")
            }
          >
            <option value="">全部链</option>
            {(chains ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="平台名称">
          <input
            className="input"
            value={form.platform}
            onChange={(e) => setForm({ ...form, platform: e.target.value })}
            placeholder="ZIA Staker"
          />
        </Field>
        <Field label="交易对标识（用于自动匹配建仓池）">
          <input
            className="input"
            value={form.pair_label}
            onChange={(e) => setForm({ ...form, pair_label: e.target.value })}
            placeholder="ETH/USDC.e 0.05%"
          />
        </Field>
        <Field label="质押合约地址">
          <input
            className="input font-mono"
            value={form.contract}
            onChange={(e) => setForm({ ...form, contract: e.target.value })}
            placeholder="0x…"
          />
        </Field>
        <Field label="持有人读取方式">
          <select
            className="input"
            value={form.read_type}
            onChange={(e) => setForm({ ...form, read_type: e.target.value })}
          >
            <option value="deposits_owner">deposits(tokenId).owner</option>
            <option value="user_info_token">user_info_token</option>
          </select>
        </Field>
        <Field label="关联 DEX">
          <select
            className="input"
            value={form.dex_id}
            onChange={(e) =>
              setForm({
                ...form,
                dex_id: e.target.value ? Number(e.target.value) : "",
              })
            }
          >
            <option value="">自动匹配</option>
            {(dexes ?? []).map((d: any) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="flex items-center gap-2">
        <button
          className="btn-primary text-xs"
          onClick={add}
          disabled={!chainId || !form.platform || !form.contract}
        >
          添加质押合约
        </button>
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>
      <div className="space-y-2">
        {(staking ?? []).map((s: any) => (
          <EditableRow
            key={s.id}
            fields={[
              { key: "platform", label: "平台" },
              { key: "pair_label", label: "交易对" },
              { key: "contract", label: "合约地址" },
              { key: "read_type", label: "读取方式" },
              {
                key: "dex_id",
                label: "关联DEX",
                type: "select",
                options:
                  dexes?.map((d: any) => ({
                    value: d.id.toString(),
                    label: d.name,
                  })) || [],
              },
            ]}
            values={s}
            onSave={async (u) => {
              await api(`/api/staking/${s.id}`, "PATCH", u);
              mutate(
                chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking"
              );
              toast.success("已更新质押合约");
            }}
            display={
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{s.platform}</span>
                {s.pair_label && (
                  <span className="tag-info">{s.pair_label}</span>
                )}
                <span className="tag-muted">{s.chain_name}</span>
                <span className="font-mono text-xs text-ink-soft">
                  {short(s.contract)}
                </span>
                {s.dex_name && (
                  <span className="tag-muted text-xs">{s.dex_name}</span>
                )}
              </div>
            }
            actions={
              <>
                <Toggle id={s.id} enabled={!!s.enabled} kind="staking" />
                <button
                  className="btn-ghost btn-xs hover:text-danger"
                  onClick={async () => {
                    await api(`/api/staking/${s.id}`, "DELETE");
                    mutate(
                      chainId
                        ? `/api/staking?chain_id=${chainId}`
                        : "/api/staking"
                    );
                    toast.info("已删除质押合约");
                  }}
                >
                  删除
                </button>
              </>
            }
          />
        ))}
      </div>
    </section>
  );
}

/* ============ CEX 报价匹配 ============ */
function CexMappingSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const key = chainId
    ? `/api/cex-mapping?chain_id=${chainId}`
    : "/api/cex-mapping";
  const { data: mappings } = useSWR<any[]>(key, fetcher);
  const [form, setForm] = useState({
    token_addr: "",
    token_symbol: "",
    cex_symbol: "",
    fixed_price: "",
    quote: "",
    inverted: false,
    is_stable: false,
  });
  const [editingMappingId, setEditingMappingId] = useState<number | null>(null);
  const [err, setErr] = useState("");
  const [tests, setTests] = useState<
    Record<number, { status: string; text: string }>
  >({});

  async function add() {
    setErr("");
    try {
      const fp = form.fixed_price.trim();
      const body: any = {
        chain_id: Number(chainId),
        token_addr: form.token_addr,
        token_symbol: form.token_symbol,
        cex_symbol: form.cex_symbol,
        quote: form.quote,
        inverted: form.inverted ? 1 : 0,
        is_stable: form.is_stable ? 1 : 0,
      };
      if (fp && Number(fp) > 0) body.fixed_price = Number(fp);

      if (editingMappingId != null) {
        const editing = (mappings ?? []).find(
          (m: any) => m.id === editingMappingId
        );
        if (
          editing &&
          editing.token_addr.toLowerCase() ===
            form.token_addr.trim().toLowerCase()
        ) {
          await api(`/api/cex-mapping/${editingMappingId}`, "PATCH", body);
        } else {
          await api(`/api/cex-mapping/${editingMappingId}`, "DELETE");
          await api("/api/cex-mapping", "POST", body);
        }
        setEditingMappingId(null);
        toast.success("已更新 CEX 映射");
      } else {
        await api("/api/cex-mapping", "POST", body);
        toast.success("已添加 CEX 映射");
      }
      setForm({
        token_addr: "",
        token_symbol: "",
        cex_symbol: "",
        fixed_price: "",
        quote: "",
        inverted: false,
        is_stable: false,
      });
      mutate(key);
    } catch (e: any) {
      setErr(e.message);
      toast.error(e.message);
    }
  }

  async function testQuote(m: any) {
    setTests((t) => ({ ...t, [m.id]: { status: "loading", text: "检测中…" } }));
    try {
      if (
        m.fixed_price !== null &&
        m.fixed_price !== undefined &&
        m.fixed_price > 0
      ) {
        const baseLabel = m.token_symbol || m.cex_symbol || "—";
        const quoteLabel = (m.quote || "USD").toUpperCase();
        setTests((t) => ({
          ...t,
          [m.id]: {
            status: "ok",
            text: `📌 固定价: 1 ${baseLabel} = ${fmtFull(m.fixed_price)} ${quoteLabel}`,
          },
        }));
        return;
      }
      const r = await fetch(
        `/api/cex-quote?symbol=${encodeURIComponent(m.cex_symbol)}`,
        { headers: authHeaders() }
      );
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "拉取失败");
      const d = j.data;
      if (m.inverted) {
        const invPrice = 1 / d.price;
        setTests((t) => ({
          ...t,
          [m.id]: {
            status: "ok",
            text: `🔄 翻转: 1 ${d.quote} = ${fmtFull(invPrice)} ${d.base}`,
          },
        }));
      } else {
        const baseLabel = d.base || m.cex_symbol;
        const quoteLabel = d.quote || "";
        setTests((t) => ({
          ...t,
          [m.id]: {
            status: "ok",
            text: `✅ 币安: 1 ${baseLabel} = ${fmtFull(d.price)} ${quoteLabel}`,
          },
        }));
      }
    } catch (e: any) {
      setTests((t) => ({
        ...t,
        [m.id]: { status: "error", text: `❌ ${e.message}` },
      }));
    }
  }

  const isFixed = form.fixed_price.trim() && Number(form.fixed_price) > 0;

  return (
    <section className="card p-4 space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-ink">📊 CEX 报价映射</h2>
        <p className="text-xs text-ink-soft">
          为链上 Token 配对币安交易对（如 WETH → <code>ETHUSDT</code>）或为稳定币设固定价 <code>1</code>。同一个池的 token0、token1 映射到同一计价币种（如 USDT/USDC）后即可实时监控 DEX vs CEX 差价。
        </p>
      </div>
      <div className="max-w-xs">
        <Field label="按链筛选 / 新增目标链">
          <select
            className="input"
            value={chainId}
            onChange={(e) =>
              setChainId(e.target.value ? Number(e.target.value) : "")
            }
          >
            <option value="">全部链</option>
            {(chains ?? []).map((c: any) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field label="Token 地址（或点 GAS 代币）">
          <div className="flex gap-2">
            <input
              className="input flex-1 font-mono"
              value={form.token_addr}
              onChange={(e) => setForm({ ...form, token_addr: e.target.value })}
              placeholder="0x… 或 __native__"
            />
            <button
              type="button"
              className={
                form.token_addr === "__native__"
                  ? "btn-primary btn-xs whitespace-nowrap"
                  : "btn-ghost btn-xs whitespace-nowrap"
              }
              onClick={() =>
                setForm({
                  ...form,
                  token_addr:
                    form.token_addr === "__native__" ? "" : "__native__",
                })
              }
            >
              GAS 代币
            </button>
          </div>
        </Field>
        <Field label="Token 符号（如 ETH / USDC.e）">
          <input
            className="input"
            value={form.token_symbol}
            onChange={(e) =>
              setForm({ ...form, token_symbol: e.target.value })
            }
            placeholder="如 ETH / USDC.e"
          />
        </Field>
        {isFixed ? (
          <Field label="固定价">
            <input
              className="input font-mono"
              value={form.fixed_price}
              onChange={(e) =>
                setForm({ ...form, fixed_price: e.target.value })
              }
              placeholder="如 1"
            />
          </Field>
        ) : (
          <Field label="币安交易对">
            <input
              className="input font-mono"
              value={form.cex_symbol}
              onChange={(e) =>
                setForm({ ...form, cex_symbol: e.target.value })
              }
              placeholder="如 ETHUSDT"
            />
          </Field>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3 items-center">
        <Field label="计价币种（如 USDT / USDC）">
          <input
            className="input"
            value={form.quote}
            onChange={(e) => setForm({ ...form, quote: e.target.value })}
            placeholder="USDT"
          />
        </Field>
        <div className="flex flex-col gap-1.5 pt-2">
          <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer">
            <input
              type="checkbox"
              checked={!!form.is_stable}
              onChange={(e) =>
                setForm({ ...form, is_stable: e.target.checked })
              }
            />
            稳定币（兑换询价时显示币安对比）
          </label>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer">
            <input
              type="checkbox"
              checked={!!isFixed}
              onChange={(e) =>
                setForm({ ...form, fixed_price: e.target.checked ? "1" : "" })
              }
            />
            固定价模式（如 USDC.e = 1 USDT）
          </label>
        </div>
        {!isFixed && (
          <label className="flex items-center gap-1.5 text-xs text-ink-soft cursor-pointer pt-2">
            <input
              type="checkbox"
              checked={form.inverted}
              onChange={(e) =>
                setForm({ ...form, inverted: e.target.checked })
              }
            />
            取倒数翻转（币安无反向交易对时用）
          </label>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          className="btn-primary text-xs"
          onClick={add}
          disabled={
            !chainId || !form.token_addr || (!isFixed && !form.cex_symbol)
          }
        >
          {editingMappingId != null ? "保存修改" : "添加映射"}
        </button>
        {editingMappingId != null && (
          <button
            className="btn-ghost text-xs"
            onClick={() => {
              setEditingMappingId(null);
              setForm({
                token_addr: "",
                token_symbol: "",
                cex_symbol: "",
                fixed_price: "",
                quote: "",
                inverted: false,
                is_stable: false,
              });
            }}
          >
            取消编辑
          </button>
        )}
        {err && <span className="text-xs text-danger">{err}</span>}
      </div>

      <div className="space-y-2">
        {(mappings ?? []).map((m: any) => {
          const t = tests[m.id];
          const isFixedRow =
            m.fixed_price !== null &&
            m.fixed_price !== undefined &&
            m.fixed_price > 0;
          return (
            <div
              key={m.id}
              className="rounded-lg border border-white/[0.08] bg-surface-raised/40 px-3 py-2 text-sm hover:border-white/[0.15] transition"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                  <span className="font-semibold text-ink">
                    {m.token_symbol || "(无符号)"}
                  </span>
                  <span className="text-ink-muted">→</span>
                  {isFixedRow ? (
                    <span className="font-mono text-xs text-ok">
                      <span className="tag-muted mr-1">固定</span>
                      {fmtFull(m.fixed_price)} {(m.quote || "USD").toUpperCase()}
                    </span>
                  ) : (
                    <span className="font-mono text-xs text-brand-light">
                      {m.cex_symbol}
                      {m.inverted === 1 && (
                        <span className="ml-1 tag-info text-[10px]">取倒数</span>
                      )}
                    </span>
                  )}
                  <span className="tag-muted">{m.chain_name}</span>
                  <span className="font-mono text-xs text-ink-soft">
                    {m.token_addr === "__native__" ? (
                      <span className="tag-ok text-[10px]">GAS 代币</span>
                    ) : (
                      short(m.token_addr)
                    )}
                  </span>
                  {m.is_stable === 1 && (
                    <span className="tag-info text-[10px]">稳定币</span>
                  )}
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    className="btn-ghost btn-xs"
                    onClick={() => {
                      setChainId(m.chain_id_ref);
                      setForm({
                        token_addr: m.token_addr,
                        token_symbol: m.token_symbol ?? "",
                        cex_symbol: m.cex_symbol ?? "",
                        fixed_price:
                          m.fixed_price != null ? String(m.fixed_price) : "",
                        quote: m.quote ?? "",
                        inverted: m.inverted === 1,
                        is_stable: m.is_stable === 1,
                      });
                      setEditingMappingId(m.id);
                      window.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    className="btn-ghost btn-xs"
                    disabled={t?.status === "loading"}
                    onClick={() => testQuote(m)}
                  >
                    {t?.status === "loading" ? "测试中…" : "测试报价"}
                  </button>
                  {!isFixedRow && (
                    <button
                      className="btn-ghost btn-xs"
                      onClick={async () => {
                        await api(`/api/cex-mapping/${m.id}`, "PATCH", {
                          inverted: m.inverted === 1 ? 0 : 1,
                        });
                        mutate(key);
                        toast.info("已切换报价取倒数状态");
                      }}
                    >
                      {m.inverted === 1 ? "取消倒数" : "取倒数"}
                    </button>
                  )}
                  <Toggle id={m.id} enabled={!!m.enabled} kind="cex-mapping" />
                  <button
                    className="btn-ghost btn-xs hover:text-danger"
                    onClick={async () => {
                      await api(`/api/cex-mapping/${m.id}`, "DELETE");
                      mutate(key);
                      toast.info("已删除映射");
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
              {t && (
                <div
                  className={`mt-1.5 text-xs font-mono ${
                    t.status === "error" ? "text-danger" : "text-ok"
                  }`}
                >
                  {t.text}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

/* ============ 通知渠道 ============ */
function NotifySection() {
  const { data: channels, mutate } = useSWR<any[]>("/api/notify-test", fetcher);
  const [busy, setBusy] = useState("");

  async function test(key: string, name: string) {
    setBusy(key);
    try {
      await api("/api/notify-test", "POST", { channel: key });
      toast.success(`${name} 测试消息已发送`);
    } catch (e: any) {
      toast.error(`${name} 发送失败：${e.message}`);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="card p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-ink">🔔 通知渠道</h2>
          <p className="text-xs text-ink-soft">
            通过项目根目录下的 <code>.env.local</code> 配置，修改后重启服务生效。
          </p>
        </div>
        <button className="btn-ghost btn-xs" onClick={() => mutate()}>
          ↻ 刷新状态
        </button>
      </div>
      <div className="grid grid-cols-1 gap-2.5 md:grid-cols-2">
        {(channels ?? []).map((c: any) => (
          <div
            key={c.key}
            className="flex items-center justify-between rounded-lg border border-white/[0.08] bg-surface-raised/40 px-3 py-2.5 text-sm"
          >
            <div className="flex items-center gap-2">
              <span className="font-medium text-ink">{c.name}</span>
              <span className={c.configured ? "tag-ok" : "tag-muted"}>
                {c.configured ? "已配置" : "未配置"}
              </span>
            </div>
            <button
              className="btn-ghost btn-xs"
              disabled={!c.configured || busy === c.key}
              onClick={() => test(c.key, c.name)}
            >
              {busy === c.key ? "发送中…" : "发送测试"}
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

/* ============ 通用开关 ============ */
function Toggle({
  id,
  enabled,
  kind,
  disabled,
}: {
  id: number;
  enabled: boolean;
  kind: "wallets" | "chains" | "dexes" | "staking" | "cex-mapping";
  disabled?: boolean;
}) {
  async function toggle() {
    try {
      await api(`/api/${kind}/${id}`, "PATCH", { enabled: enabled ? 0 : 1 });
      mutate(
        (k: string) =>
          typeof k === "string" &&
          (k.includes(`/${kind}`) || k.includes("/positions")),
        undefined,
        { revalidate: true }
      );
    } catch (e: any) {
      toast.error(e.message || "切换失败");
    }
  }
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled}
      className={`relative h-5 w-9 rounded-full transition ${
        enabled ? "bg-ok/80" : "bg-white/[0.12]"
      } ${disabled ? "opacity-50" : ""}`}
      title={disabled ? "内置项不可禁用" : ""}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all ${
          enabled ? "left-4" : "left-0.5"
        }`}
      />
    </button>
  );
}
