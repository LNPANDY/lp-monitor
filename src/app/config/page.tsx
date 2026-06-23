"use client";
import { useState } from "react";
import useSWR, { mutate } from "swr";
import { fetcher, short, fmtFull } from "@/components/util";
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
      setMsg("✅ 已导出配置文件");
    } catch (e: any) { setMsg(`❌ 导出失败：${e.message}`); }
    finally { setBusy(false); }
  }

  function doImportFile(file: File) {
    setMsg(""); setBusy(true);
    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bundle = JSON.parse(String(reader.result));
        const r = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(bundle) });
        const j = await r.json(); if (!j.ok) throw new Error(j.error);
        const d = j.data;
        setMsg(`✅ 导入完成：链 +${d.chains.added}/~${d.chains.updated}，DEX +${d.dexes.added}/~${d.dexes.updated}，质押 +${d.staking.added}/~${d.staking.updated}，钱包 +${d.wallets.added}/~${d.wallets.updated}`);
        mutate((k: string) => typeof k === "string" && (k.includes("/api/chains") || k.includes("/api/dexes") || k.includes("/api/staking") || k.includes("/api/wallets")), undefined, { revalidate: true });
      } catch (e: any) { setMsg(`❌ 导入失败：${e.message}`); }
      finally { setBusy(false); }
    };
    reader.readAsText(file);
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">配置导入 / 导出</h2>
      <p className="mb-3 text-xs text-ink-soft">把链、DEX、质押合约、监控钱包打包成 JSON 文件，方便多机部署、备份。导入时按唯一键 upsert，重复导入安全。</p>
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
  const [form, setForm] = useState({ name: "", factory: "", npm: "", type: "v3-fork" });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try { await api("/api/dexes", "POST", { chain_id: Number(chainId), ...form }); setForm({ name: "", factory: "", npm: "", type: "v3-fork" }); mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">DEX（集中流动性）</h2>
      <p className="mb-3 text-xs text-ink-soft">兼容 Uniswap V3 NPM 的 DEX，填 factory + NPM 地址即可接入。</p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="名称"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="PancakeSwap V3" /></Field>
        <Field label="Factory"><input className="input" value={form.factory} onChange={(e) => setForm({ ...form, factory: e.target.value })} placeholder="0x…" /></Field>
        <Field label="NPM"><input className="input" value={form.npm} onChange={(e) => setForm({ ...form, npm: e.target.value })} placeholder="0x…" /></Field>
        <Field label="类型"><select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value })}><option value="v3-fork">v3-fork</option></select></Field>
      </div>
      <div className="mb-3 flex gap-2"><button className="btn-primary" onClick={add} disabled={!chainId || !form.name || !form.factory || !form.npm}>添加 DEX</button>{err && <span className="self-center text-sm text-warn">{err}</span>}</div>
      <div className="space-y-2">
        {(dexes ?? []).map((d: any) => (
          <EditableRow
            key={d.id}
            fields={[
              { key: "name", label: "名称" },
              { key: "factory", label: "Factory 地址" },
              { key: "npm", label: "NPM 地址" },
            ]}
            values={d}
            onSave={async (u) => { await api(`/api/dexes/${d.id}`, "PATCH", u); mutate(chainId ? `/api/dexes?chain_id=${chainId}` : "/api/dexes"); }}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{d.name}</span>
                <span className="text-ink-soft">{d.chain_name}</span>
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
  const [form, setForm] = useState({ platform: "", pair_label: "", contract: "", read_type: "deposits_owner" });
  const [err, setErr] = useState("");

  async function add() {
    setErr("");
    try { await api("/api/staking", "POST", { chain_id: Number(chainId), ...form }); setForm({ platform: "", pair_label: "", contract: "", read_type: "deposits_owner" }); mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking"); }
    catch (e: any) { setErr(e.message); }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">流动性质押合约</h2>
      <p className="mb-3 text-xs text-ink-soft">添加后系统通过事件扫描 + Transfer 扫描自动发现质押在其中的仓位，归集到原钱包监控。</p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Field label="平台"><input className="input" value={form.platform} onChange={(e) => setForm({ ...form, platform: e.target.value })} placeholder="Uniswap V3 Staker" /></Field>
        <Field label="交易对"><input className="input" value={form.pair_label} onChange={(e) => setForm({ ...form, pair_label: e.target.value })} placeholder="WETH/USDC 0.05%" /></Field>
        <Field label="合约地址"><input className="input" value={form.contract} onChange={(e) => setForm({ ...form, contract: e.target.value })} placeholder="0x…" /></Field>
        <Field label="读取方式"><select className="input" value={form.read_type} onChange={(e) => setForm({ ...form, read_type: e.target.value })}><option value="deposits_owner">deposits(tokenId).owner</option><option value="user_info_token">user_info_token</option></select></Field>
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
            ]}
            values={s}
            onSave={async (u) => { await api(`/api/staking/${s.id}`, "PATCH", u); mutate(chainId ? `/api/staking?chain_id=${chainId}` : "/api/staking"); }}
            display={
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.platform}</span>
                {s.pair_label && <span className="text-ink-soft">{s.pair_label}</span>}
                <span className="text-ink-soft">{s.chain_name}</span>
                <span className="font-mono text-xs text-ink-soft">{short(s.contract)}</span>
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

/* ============ CEX 报价匹配 ============ */
function CexMappingSection() {
  const { data: chains } = useSWR<any[]>("/api/chains", fetcher);
  const [chainId, setChainId] = useState<number | "">("");
  const key = chainId ? `/api/cex-mapping?chain_id=${chainId}` : "/api/cex-mapping";
  const { data: mappings } = useSWR<any[]>(key, fetcher);
  const [form, setForm] = useState({ token_addr: "", token_symbol: "", cex_symbol: "" });
  const [err, setErr] = useState("");
  // 测试报价的行内结果：id → { status:'loading'|'ok'|'error', text }
  const [tests, setTests] = useState<Record<number, { status: string; text: string }>>({});

  async function add() {
    setErr("");
    try {
      await api("/api/cex-mapping", "POST", { chain_id: Number(chainId), ...form });
      setForm({ token_addr: "", token_symbol: "", cex_symbol: "" });
      mutate(key);
    } catch (e: any) { setErr(e.message); }
  }

  /** 拉取单条映射的币安实时报价，确认配对是否正确。 */
  async function testQuote(m: any) {
    setTests((t) => ({ ...t, [m.id]: { status: "loading", text: "拉取中…" } }));
    try {
      const r = await fetch(`/api/cex-quote?symbol=${encodeURIComponent(m.cex_symbol)}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || "拉取失败");
      const d = j.data;
      const baseLabel = d.base || m.cex_symbol;
      const quoteLabel = d.quote || "";
      setTests((t) => ({
        ...t,
        [m.id]: { status: "ok", text: `✅ 1 ${baseLabel} = ${fmtFull(d.price)} ${quoteLabel}` },
      }));
    } catch (e: any) {
      setTests((t) => ({ ...t, [m.id]: { status: "error", text: `❌ ${e.message}` } }));
    }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-1 text-base font-semibold">CEX 报价匹配</h2>
      <p className="mb-3 text-xs text-ink-soft">
        为链上 token 配对币安交易对 symbol（如 0G token → <code>0GUSDT</code>）。配置后扫描时拉取币安实时报价，与 DEX 价格对比，价差超过阈值即告警。计价货币（USDT/USDC）每个币种自选。添加后可点「测试报价」确认配对是否正确。
      </p>
      <div className="mb-3"><Field label="按链筛选"><select className="input" value={chainId} onChange={(e) => setChainId(e.target.value ? Number(e.target.value) : "")}><option value="">全部链</option>{(chains ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field></div>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-3">
        <Field label="Token 地址"><input className="input" value={form.token_addr} onChange={(e) => setForm({ ...form, token_addr: e.target.value })} placeholder="0x…" /></Field>
        <Field label="Token 符号（可选）"><input className="input" value={form.token_symbol} onChange={(e) => setForm({ ...form, token_symbol: e.target.value })} placeholder="如 0G / WETH" /></Field>
        <Field label="币安交易对"><input className="input" value={form.cex_symbol} onChange={(e) => setForm({ ...form, cex_symbol: e.target.value })} placeholder="如 0GUSDT" /></Field>
      </div>
      <div className="mb-3 flex gap-2"><button className="btn-primary" onClick={add} disabled={!chainId || !form.token_addr || !form.cex_symbol}>添加匹配</button>{err && <span className="self-center text-sm text-warn">{err}</span>}</div>
      <div className="space-y-2">
        {(mappings ?? []).map((m: any) => {
          const t = tests[m.id];
          return (
            <div key={m.id} className="rounded-md border border-slate-200 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="font-medium">{m.token_symbol || "(无符号)"}</span>
                  <span className="text-ink-soft">→</span>
                  <span className="font-mono text-sm">{m.cex_symbol}</span>
                  <span className="text-ink-soft">{m.chain_name}</span>
                  <span className="font-mono text-xs text-ink-soft">{short(m.token_addr)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    className="btn-ghost text-xs"
                    disabled={t?.status === "loading"}
                    onClick={() => testQuote(m)}
                  >
                    {t?.status === "loading" ? "测试中…" : "测试报价"}
                  </button>
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
