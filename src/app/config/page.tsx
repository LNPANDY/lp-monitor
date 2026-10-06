"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, authHeaders, short, fmtFull } from "@/components/util";
import { api, Field } from "@/components/form";
import { EditableRow } from "@/components/editable-row";

export default function ConfigPage() {
  return (
    <div className="space-y-6">
      <h1 className="text-lg font-semibold">配置</h1>
      <IoSection />
      <WalletsSection />
      <ChainsSection />
      <DexesSection />
      <StakingSection />
      <ScanSettingsSection />
      <CexMappingSection />
      <NotifySection />
    </div>
  );
}

/* ============ 配置导入/导出 ============ */
function IoSection() {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function doExport() {
    setMsg(""); setBusy(true);
    try {
      const r = await fetch("/api/config");
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      const blob = new Blob([JSON.stringify(j.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url;
      a.download = `lp-monitor-config-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); URL.revokeObjectURL(url);
      setMsg("✅ 已导出配置文件（包含收藏）");
    } catch (e: any) { setMsg(`❌ 导出失败：${e.message}`); }
    finally { setBusy(false); }
  }

  function doImportFile(file: File) {
    setMsg(""); setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bundle = JSON.parse(String(reader.result));
        const r = await fetch("/api/config", { method: "POST", headers: authHeaders({ "Content-Type": "application/json" }), body: JSON.stringify(bundle) });
        const j = await r.json(); if (!j.ok) throw new Error(j.error);
        const d = j.data;
        let extraInfo = "";
        if (d.pair_flips?.applied) extraInfo += `，翻转 +${d.pair_flips.applied}`;
        if (d.liquidity_favorites) extraInfo += `，收藏 +${d.liquidity_favorites.added}/~${d.liquidity_favorites.updated}`;
        setMsg(`✅ 导入完成：链 +${d.chains.added}/~${d.chains.updated}，DEX +${d.dexes.added}/~${d.dexes.updated}，质押 +${d.staking.added}/~${d.staking.updated}，钱包 +${d.wallets.added}/~${d.wallets.updated}，CEX +${d.cex_mappings.added}/~${d.cex_mappings.updated}${extraInfo}`);
        mutate((k: string) => typeof k === "string" && (k.includes("/api/chains") || k.includes("/api/dexes") || k.includes("/api/staking") || k.includes("/api/wallets") || k.includes("/api/cex-mapping") || k.includes("/api/positions") || k.includes("/api/liquidity-favorites")), undefined, { revalidate: true });
      } catch (e: any) { setMsg(`❌ 导入失败：${e.message}`); }
      finally { setBusy(false); }
    };
    reader.readAsText(file);
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">配置导入 / 导出</h2>
      <p className="mb-3 text-xs text-ink-soft">把链、DEX、质押合约、监控钱包、CEX 报价匹配、交易对翻转状态<strong>和流动性探针收藏（包含链、DEX、Token信息）</strong>打包成 JSON 文件，方便多机部署、备份。导入时按唯一键 upsert，重复导入安全。</p>
      <div className="flex flex-wrap items-center gap-3">
        <button className="btn-primary" onClick={doExport} disabled={busy}>导出配置</button>
        <label className="btn-ghost cursor-pointer">导入配置
          <input type="file" accept="application/json,.json" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) doImportFile(f); e.target.value = ""; }} />
        </label>
        {busy && <span className="text-sm text-ink-soft">处理中…</span>}
      </div>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
    </section>
  );
}

/* ============ 钱包 ============ */
function WalletsSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const { data: wallets } = useSWR<any[]>("/api/wallets", fetcher, { refreshInterval: 30_000 });
  const [chainId, setChainId] = useState<number | "">("");
  const [addr, setAddr] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try { await api("/api/wallets", "POST", { chain_id: Number(chainId), address: addr, label }); setAddr(""); setLabel(""); mutate("/api/wallets"); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 text-base font-semibold">监控钱包</h2>
      <div className="mb-4 grid grid-cols-1 gap-3 md:grid-cols-4">
        <Field label="链"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">选择链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
        <Field label="钱包地址"><input className="input" value={addr} onChange={(e) => setAddr(e.target.value)} placeholder="0x…" /></Field>
        <Field label="备注"><input className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="热钱包A" /></Field>
        <div className="flex items-end"><button className="btn-primary w-full" onClick={add} disabled={!chainId || !addr}>添加</button></div>
      </div>
      {err && <p className="mb-3 text-sm text-warn">{err}</p>}
      <div className="space-y-2">
        {(wallets ?? []).map((w: any) => (
          <EditableRow
            key={w.id}
            fields={[{ key: "label", label: "备注" }]}
            values={w}
            onSave={async (u) => { await api(`/api/wallets/${w.id}`, "PATCH", u); mutate("/api/wallets"); }}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{w.chain_name}</span>
                {w.label && <span className="text-ink-soft">［{w.label}］</span>}
                <span className="font-mono text-xs text-ink-soft">{short(w.address)}</span>
              </div>
            }
            actions={<>
              <Toggle id={w.id} enabled={!!w.enabled} kind="wallets" />
              <button className="btn-ghost" onClick={async () => { await api(`/api/wallets/${w.id}`, "DELETE"); mutate("/api/wallets"); }}>删除</button>
            </>}
          />
        ))}
        {(wallets ?? []).length === 0 && <p className="text-sm text-ink-soft">暂无监控钱包。</p>}
      </div>
    </section>
  );
}

/* ============ 链 ============ */
function ChainsSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [form, setForm] = useState({ key: "", name: "", chain_id: "", rpc_urls: "", explorer_url: "", symbol: "" });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      await api("/api/chains", "POST", { key: form.key, name: form.name, chain_id: Number(form.chain_id), rpc_urls: form.rpc_urls.split(/[\s,]+/).filter(Boolean), explorer_url: form.explorer_url, symbol: form.symbol || "ETH" });
      setForm({ key: "", name: "", chain_id: "", rpc_urls: "", explorer_url: "", symbol: "" }); mutate("/api/chains");
    } catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">链</h2>
      <p className="mb-3 text-xs text-ink-soft">默认内置 Ethereum。可添加任意 EVM 链，多 RPC URL 用空格/逗号分隔自动 failover。</p>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="key"><input className="input" value={form.key} onChange={(e) => setForm({ ...form, key: e.target.value })} placeholder="arbitrum" /></Field>
        <Field label="显示名"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Arbitrum One" /></Field>
        <Field label="chainId"><input className="input" value={form.chain_id} onChange={(e) => setForm({ ...form, chain_id: e.target.value })} placeholder="42161" /></Field>
        <Field label="RPC URL" hint="多个用空格/逗号分隔"><input className="input" value={form.rpc_urls} onChange={(e) => setForm({ ...form, rpc_urls: e.target.value })} placeholder="https://arb1.arbitrum.io/rpc" /></Field>
        <Field label="区块浏览器"><input className="input" value={form.explorer_url} onChange={(e) => setForm({ ...form, explorer_url: e.target.value })} placeholder="https://arbiscan.io" /></Field>
        <Field label="代币符号"><input className="input" value={form.symbol} onChange={(e) => setForm({ ...form, symbol: e.target.value })} placeholder="ETH" /></Field>
      </div>
      <div className="mb-3 flex gap-2"><button className="btn-primary" onClick={add} disabled={!form.key || !form.name || !form.chain_id}>添加链</button>{err && <span className="self-center text-sm text-warn">{err}</span>}</div>
      <div className="space-y-2">
        {(chains ?? []).map((c: any) => (
          <EditableRow
            key={c.id}
            fields={[
              { key: "name", label: "显示名" },
              { key: "rpc_urls", label: "RPC URL（多空格/逗号分隔）", placeholder: "https://..." },
              { key: "explorer_url", label: "区块浏览器" },
              { key: "symbol", label: "代币符号" },
            ]}
            values={c}
            onSave={async (u) => {
              if (u.rpc_urls) u.rpc_urls = (Array.isArray(u.rpc_urls) ? u.rpc_urls : u.rpc_urls.split(/[\s,]+/).filter(Boolean));
              await api(`/api/chains/${c.id}`, "PATCH", u); mutate("/api/chains");
            }}
            disabled={!!c.is_default}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{c.name}</span>
                {c.is_default ? <span className="tag-muted">内置</span> : null}
                <span className="text-ink-soft">id {c.chain_id} · {c.symbol} · {(c.rpc_urls ?? []).length} RPC</span>
              </div>
            }
            actions={<>
              <Toggle id={c.id} enabled={!!c.enabled} kind="chains" disabled={!!c.is_default} />
              {!c.is_default && <button className="btn-ghost" onClick={async () => { await api(`/api/chains/${c.id}`, "DELETE"); mutate("/api/chains"); }}>删除</button>}
            </>}
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
  const { data: dexes } = useSWR<any[]>(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes", fetcher);
  const [form, setForm] = useState({ name: "", factory: "", npm: "", type: "v3-fork", stateview: "" });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try { await api("/api/dexes", "POST", { chain_id: Number(chainId), ...form }); setForm({ name: "", factory: "", npm: "", type: "v3-fork", stateview: "" }); mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">DEX（集中流动性）</h2>
      <p className="mb-3 text-xs text-ink-soft">v3-fork：兼容 Uniswap V3 NPM 的 DEX，填 factory + NPM。v4：factory 填 PoolManager、npm 填 PositionManager，并需配置 StateView 地址。</p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="名称"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Uniswap V4" /></Field>
        <Field label={form.type === "v4" ? "PoolManager" : "Factory"}><input className="input" value={form.factory} onChange={(e) => setForm({ ...form, factory: e.target.value })} placeholder="0x…" /></Field>
        <Field label={form.type === "v4" ? "PositionManager" : "NPM"}><input className="input" value={form.npm} onChange={(e) => setForm({ ...form, npm: e.target.value })} placeholder="0x…" /></Field>
        <Field label="类型"><select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="v3-fork">v3-fork</option><option value="v4">v4</option></select></Field>
      </div>
      {form.type === "v4" && (
        <div className="mb-3">
          <Field label="StateView 地址（v4 必填，读池状态用，跨链地址不同）"><input className="input" value={form.stateview} onChange={(e) => setForm({ ...form, stateview: e.target.value })} placeholder="0x…" /></Field>
        </div>
      )}
      <div className="mb-3 flex gap-2"><button className="btn-primary" onClick={add} disabled={!chainId || !form.name || !form.factory || !form.npm || (form.type === "v4" && !form.stateview)}>添加 DEX</button>{err && <span className="self-center text-sm text-warn">{err}</span>}</div>
      <div className="space-y-2">
        {(dexes ?? []).map((d: any) => (
          <EditableRow
            key={d.id}
            fields={[
              { key: "name", label: "名称" },
              { key: "factory", label: d.type === "v4" ? "PoolManager 地址" : "Factory 地址" },
              { key: "npm", label: d.type === "v4" ? "PositionManager 地址" : "NPM 地址" },
              ...(d.type === "v4" ? [{ key: "stateview", label: "StateView 地址" }] : []),
            ]}
            values={d}
            onSave={async (u) => { await api(`/api/dexes/${d.id}`, "PATCH", u); mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"); }}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{d.name}</span>
                <span className="text-ink-soft">{d.chain_name}</span>
                <span className="rounded bg-slate-100 px-1 text-xs text-ink-soft">{d.type}</span>
                <span className="font-mono text-xs text-ink-soft">factory {short(d.factory)}</span>
              </div>
            }
            actions={<>
              <Toggle id={d.id} enabled={!!d.enabled} kind="dexes" />
              <button className="btn-ghost" onClick={async () => { await api(`/api/dexes/${d.id}`, "DELETE"); mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"); }}>删除</button>
            </>}
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
  const { data: staking } = useSWR<any[]>(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking", fetcher);
  const { data: dexes } = useSWR<any[]>(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes", fetcher);
  const [form, setForm] = useState({ platform: "", pair_label: "", contract: "", read_type: "deposits_owner", dex_id: "" as number | "" });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try {
      const body: any = { chain_id: Number(chainId), ...form };
      body.dex_id = form.dex_id ? Number(form.dex_id) : null;
      await api("/api/staking", "POST", body);
      setForm({ platform: "", pair_label: "", contract: "", read_type: "deposits_owner", dex_id: "" });
      mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking");
    }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">流动性质押合约</h2>
      <p className="mb-3 text-xs text-ink-soft">添加后系统通过事件扫描 + Transfer 扫描自动发现质押在其中的仓位，归集到原钱包监控。</p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Field label="平台"><input className="input" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="Uniswap V3 Staker" /></Field>
        <Field label="交易对"><input className="input" value={form.pair_label} onChange={(e) => setForm({ ...form, pair_label: e.target.value })} placeholder="WETH/USDC 0.05%" /></Field>
        <Field label="合约地址"><input className="input" value={form.contract} onChange={(e) => setForm({ ...form, contract: e.target.value })} placeholder="0x…" /></Field>
        <Field label="读取方式"><select className="input" value={form.read_type} onChange={(e) => setForm({ ...form, read_type: e.target.value })}><option value="deposits_owner">deposits(tokenId).owner</option><option value="user_info_token">user_info_token</option></select></Field>
        <Field label="关联 DEX"><select className="input" value={form.dex_id} onChange={(e) => setForm({ ...form, dex_id: e.target.value ? Number(e.target.value) : "" })}><option value="">自动匹配</option>{(dexes ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      </div>
      <div className="mb-3 flex gap-2"><button className="btn-primary" onClick={add} disabled={!chainId || !form.platform || !form.contract}>添加质押合约</button>{err && <span className="self-center text-sm text-warn">{err}</span>}</div>
      <div className="space-y-2">
        {(staking ?? []).map((s: any) => (
          <EditableRow
            key={s.id}
            fields={[
              { key: "platform", label: "平台" },
              { key: "pair_label", label: "交易对" },
              { key: "contract", label: "合约地址" },
              { key: "read_type", label: "读取方式" },
              { key: "dex_id", label: "关联DEX", type: "select", options: dexes?.map((d: any) => ({ value: d.id.toString(), label: d.name })) || [] },
            ]}
            values={s}
            onSave={async (u) => { await api(`/api/staking/${s.id}`, "PATCH", u); mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking"); }}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.platform}</span>
                {s.pair_label && <span className="text-ink-soft">{s.pair_label}</span>}
                <span className="text-ink-soft">{s.chain_name}</span>
                <span className="font-mono text-xs text-ink-soft">{short(s.contract)}</span>
                {s.dex_name && <span className="tag-muted text-xs">{s.dex_name}</span>}
              </div>
            }
            actions={<>
              <Toggle id={s.id} enabled={!!s.enabled} kind="staking" />
              <button className="btn-ghost" onClick={async () => { await api(`/api/staking/${s.id}`, "DELETE"); mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking"); }}>删除</button>
            </>}
          />
        ))}
      </div>
    </section>
  );
}

/* ============ 扫描设置 ============ */
function ScanSettingsSection() {
  const { data: settings, mutate } = useSWR<any>("/api/scan-settings", fetcher);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const handleSave = async (updates: any) => {
    setMsg("");
    setBusy(true);
    try {
      const r = await fetch("/api/scan-settings", {
        method: "PUT",
        headers: authHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify(updates)
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error);
      setMsg("✅ 设置已保存");
      mutate();
    } catch (e: any) {
      setMsg(`❌ 保存失败：${e.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">扫描设置</h2>
      <p className="mb-3 text-xs text-ink-soft">配置扫描相关参数</p>

      <div className="space-y-4">
        <div>
          <label className="block mb-1 text-sm font-medium">
            默认推送冷却（分钟）
          </label>
          <input
            type="number"
            min="1"
            max="60"
            value={settings?.push_cooldown_minutes || 2}
            onChange={(e) => handleSave({ push_cooldown_minutes: Number(e.target.value) })}
            className="input"
          />
          <p className="mt-1 text-xs text-ink-soft">
            默认推送冷却时间，1-60分钟。各类告警可单独配置覆盖此值。
          </p>
        </div>
      </div>

      {busy && <span className="text-sm text-ink-soft">保存中…</span>}
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </section>
  );
}

/* ============ CEX 报价匹配 ============ */
function CexMappingSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const key = chainId ? `/api/cex-mapping?chain_id=${chainId}` : "/api/cex-mapping";
  const { data: mappings } = useSWR<any[]>(key, fetcher);
  const [form, setForm] = useState({ token_addr: "", token_symbol: "", cex_symbol: "", fixed_price: "", quote: "", inverted: false });
  const [err, setErr] = useState("");
  // 测试报价的行内结果：id → { status:'loading'|'ok'|'error', text }
  const [tests, setTests] = useState<Record<number, { status: string; text: string }>>({});

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
      };
      // 有固定价时带上
      if (fp && Number(fp) > 0) body.fixed_price = Number(fp);
      await api("/api/cex-mapping", "POST", body);
      setForm({ token_addr: "", token_symbol: "", cex_symbol: "", fixed_price: "", quote: "", inverted: false });
      mutate(key);
    } catch (e: any) { setErr(e.message); }
  }

  /** 拉取单条映射的报价（固定价直接展示，币安模式走接口；翻转时展示反向口径）。 */
  async function testQuote(m: any) {
    setTests((t) => ({ ...t, [m.id]: { status: "loading", text: "检测中…" } }));
    try {
      // 固定价模式：直接用 fixed_price 展示，不需要请求币安
      if (m.fixed_price !== null && m.fixed_price !== undefined && m.fixed_price > 0) {
        const baseLabel = m.token_symbol || m.cex_symbol || "—";
        const quoteLabel = (m.quote || "USD").toUpperCase();
        setTests((t) => ({
          ...t,
          [m.id]: { status: "ok", text: `📌 固定价: 1 ${baseLabel} = ${fmtFull(m.fixed_price)} ${quoteLabel}` },
        }));
        return;
      }
      // 币安模式：走接口
      const r = await fetch(`/api/cex-quote?symbol=${encodeURIComponent(m.cex_symbol)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "拉取失败");
      const d = j.data;
      // 翻转：币安原口径是 1 base = price quote，翻转后展示为 1 quote = 1/price base
      if (m.inverted) {
        const invPrice = 1 / d.price;
        setTests((t) => ({
          ...t,
          [m.id]: { status: "ok", text: `🔄 翻转: 1 ${d.quote} = ${fmtFull(invPrice)} ${d.base}` },
        }));
      } else {
        const baseLabel = d.base || m.cex_symbol;
        const quoteLabel = d.quote || "";
        setTests((t) => ({
          ...t,
          [m.id]: { status: "ok", text: `✅ 币安: 1 ${baseLabel} = ${fmtFull(d.price)} ${quoteLabel}` },
        }));
      }
    } catch (e: any) {
      setTests((t) => ({ ...t, [m.id]: { status: "error", text: `❌ ${e.message}` } }));
    }
  }

  const isFixed = form.fixed_price.trim() && Number(form.fixed_price) > 0;

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">CEX 报价匹配</h2>
      <p className="mb-3 text-xs text-ink-soft">
        为链上 token 配对币安交易对 symbol（如 W0G → <code>0GUSDT</code>、WETH → <code>ETHUSDT</code>），
        或为稳定币设固定价（如 USDC.e 填固定价 <code>1</code>，计价币种填 <code>USDC</code>）。
        <strong>同一个 LP 的 token0、token1 都需映射，且映射到同一计价币种</strong>，
        系统据此算出 CEX 上的 token0/token1 汇率，与 DEX 池价对比，差价超该池费率 2 倍即告警。
        币安只有 <code>USDCUSDT</code> 没有 <code>USDTUSDC</code> 时，USDT token 可配 <code>USDCUSDT</code> 并勾选「翻转」。
        GAS 原生代币（如 ETH/0G/BNB）无合约地址，点「GAS 代币」快捷填入，token 符号会自动取该链 symbol。
        添加后点「测试报价」可验证。
      </p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Token 地址（或 GAS 代币）">
          <div className="flex gap-2">
            <input className="input flex-1" value={form.token_addr} onChange={(e) => setForm({ ...form, token_addr: e.target.value })} placeholder="0x… 或 __native__" />
            <button
              type="button"
              className={form.token_addr === "__native__" ? "btn-primary text-xs whitespace-nowrap" : "btn-ghost text-xs whitespace-nowrap"}
              onClick={() => setForm({ ...form, token_addr: form.token_addr === "__native__" ? "" : "__native__" })}
              title="GAS 原生代币（ETH/0G/BNB），无合约地址用 __native__ 占位"
            >
              GAS 代币
            </button>
          </div>
        </Field>
        <Field label="Token 符号（可选）"><input className="input" value={form.token_symbol} onChange={(e) => setForm({ ...form, token_symbol: e.target.value })} placeholder="如 0G / WETH" /></Field>
        {isFixed ? (
          <Field label="固定价">
            <input className="input" value={form.fixed_price} onChange={(e) => setForm({ ...form, fixed_price: e.target.value })} placeholder="如 1" />
          </Field>
        ) : (
          <Field label="币安交易对">
            <input className="input" value={form.cex_symbol} onChange={(e) => setForm({ ...form, cex_symbol: e.target.value })} placeholder="如 0GUSDT" />
          </Field>
        )}
      </div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="计价币种（如 USDC）">
          <input className="input" value={form.quote} onChange={(e) => setForm({ ...form, quote: e.target.value })} placeholder="USDC" />
        </Field>
        <label className="flex items-center gap-1 text-xs text-ink-soft">
          <input type="checkbox" checked={!!isFixed} onChange={(e) => setForm({ ...form, fixed_price: e.target.checked ? "1" : "" })} />
          固定价模式（稳定币专用，如 USDC.e = 1 USDT）
        </label>
        {!isFixed && (
          <label className="flex items-center gap-1 text-xs text-ink-soft">
            <input type="checkbox" checked={form.inverted} onChange={(e) => setForm({ ...form, inverted: e.target.checked })} />
            翻转（币安无反向交易对时用，如 USDT 配 USDCUSDT 并翻转）
          </label>
        )}
      </div>
      <div className="mb-3 flex gap-2">
        <button className="btn-primary" onClick={add} disabled={!chainId || !form.token_addr || (!isFixed && !form.cex_symbol)}>添加匹配</button>
        {err && <span className="self-center text-sm text-warn">{err}</span>}
      </div>
      <div className="space-y-2">
        {(mappings ?? []).map((m: any) => {
          const t = tests[m.id];
          const isFixedRow = m.fixed_price !== null && m.fixed_price !== undefined && m.fixed_price > 0;
          return (
            <div key={m.id} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="font-medium">{m.token_symbol || "(无符号)"}</span>
                  <span className="text-ink-soft">→</span>
                  {isFixedRow ? (
                    <span className="font-mono text-sm">
                      <span className="tag-muted text-xs">固定</span> {fmtFull(m.fixed_price)} {(m.quote || "USD").toUpperCase()}
                    </span>
                  ) : (
                    <span className="font-mono text-sm">
                      {m.cex_symbol}
                      {m.inverted === 1 && <span className="ml-1 text-xs text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded" title="取倒数翻转">翻转</span>}
                    </span>
                  )}
                  <span className="text-ink-soft">{m.chain_name}</span>
                  <span className="font-mono text-xs text-ink-soft">{m.token_addr === "__native__" ? <span className="tag-info text-xs">GAS 代币</span> : short(m.token_addr)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn-ghost text-xs"
                    disabled={t?.status === "loading"}
                    onClick={() => testQuote(m)}
                  >
                    {t?.status === "loading" ? "测试中…" : "测试报价"}
                  </button>
                  {!isFixedRow && (
                    <button
                      className="btn-ghost text-xs"
                      title="翻转/取倒数（币安无反向交易对时用）"
                      onClick={async () => { await api(`/api/cex-mapping/${m.id}`, "PATCH", { inverted: m.inverted === 1 ? 0 : 1 }); mutate(key); }}
                    >
                      {m.inverted === 1 ? "取消翻转" : "翻转"}
                    </button>
                  )}
                  <Toggle id={m.id} enabled={!!m.enabled} kind="cex-mapping" />
                  <button className="btn-ghost text-xs" onClick={async () => { await api(`/api/cex-mapping/${m.id}`, "DELETE"); mutate(key); }}>删除</button>
                </div>
              </div>
              {t && (
                <div className={`mt-1 text-xs ${t.status === "error" ? "text-warn" : "text-ink-soft"}`}>{t.text}</div>
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
  const [msg, setMsg] = useState("");

  async function test(key: string, name: string) {
    setBusy(key); setMsg("");
    try { await api("/api/notify-test", "POST", { channel: key }); setMsg(`✅ ${name} 测试消息已发送`); }
    catch (e: any) { setMsg(`❌ ${name} 失败：${e.message}`); }
    finally { setBusy(""); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">通知渠道</h2>
      <p className="mb-3 text-xs text-ink-soft">通过 <code>.env.local</code> 配置（项目根目录下）。修改后需重启 dev 服务。</p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {(channels ?? []).map((c: any) => (
          <div key={c.key} className="flex items-center justify-between rounded-md border border-slate-200 px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{c.name}</span>
              <span className={`ml-2 tag ${c.configured ? "tag-ok" : "tag-muted"}`}>{c.configured ? "已配置" : "未配置"}</span>
            </div>
            <button className="btn-ghost" disabled={!c.configured || busy === c.key} onClick={() => test(c.key, c.name)}>{busy === c.key ? "发送中…" : "发送测试"}</button>
          </div>
        ))}
      </div>
      {msg && <p className="mt-3 text-sm">{msg}</p>}
      <button className="btn-ghost mt-2" onClick={() => mutate()}>刷新状态</button>
    </section>
  );
}

/* ============ 收藏导入/导出 ============ */
/* ============ 通用开关 ============ */
function Toggle({ id, enabled, kind, disabled }: { id: number; enabled: boolean; kind: "wallets" | "chains" | "dexes" | "staking" | "cex-mapping"; disabled?: boolean }) {
  async function toggle() {
    try {
      await api(`/api/${kind}/${id}`, "PATCH", { enabled: enabled ? 0 : 1 });
      mutate((k: string) => typeof k === "string" && (k.includes(`/${kind}`) || k.includes("/positions")), undefined, { revalidate: true });
    } catch (e: any) { alert(e.message); }
  }
  return (
    <button onClick={toggle} disabled={disabled}
      className={`relative h-5 w-9 rounded-full transition ${enabled ? "bg-ok" : "bg-slate-300"} ${disabled ? "opacity-50" : ""}`}
      title={disabled ? "内置项不可禁用" : ""}>
      <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${enabled ? "left-4" : "left-0.5"}`} />
    </button>
  );
}
