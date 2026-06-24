/**
 * 配置导入/导出：把 chains / dexes / staking_contracts / wallets / token_symbols 五张配置表
 * 打包成一个 JSON 文件，方便多机部署、团队复用、备份。
 *
 * 导出格式（version 2）：
 * {
 *   version: 2,
 *   exportedAt: ISO,
 *   chains:    [{ key, name, chain_id, rpc_urls[], explorer_url, symbol, enabled }],
 *   dexes:     [{ chain_key, name, type, factory, npm, enabled }],
 *   staking:   [{ chain_key, platform, pair_label, contract, read_type, enabled }],
 *   wallets:   [{ chain_key, address, label, enabled }],
 *   cex_mappings: [{ chain_key, token_addr, token_symbol, cex_symbol, fixed_price, quote, enabled }]
 * }
 *
 * 导入策略：以「业务唯一键」做 upsert（chain key / chain_id、dex factory、staking contract、
 * wallet chain+address、cex_mapping chain+token_addr），不依赖数据库自增 id，重复导入安全。
 * 默认勾选项 enabled 生效。
 */
import { getDb } from "../db";
import { invalidateClients } from "../chains";
import { invalidateTokenCache } from "../chains/tokens";

const EXPORT_VERSION = 2;

export interface ConfigBundle {
  version: number;
  exportedAt: string;
  chains: any[];
  dexes: any[];
  staking: any[];
  wallets: any[];
  cex_mappings: any[];
}

/** 导出当前全部配置（不含 positions/alerts/tokens 运行态数据）。 */
export function exportConfig(): ConfigBundle {
  const db = getDb();
  const chains = (db.prepare("SELECT key,name,chain_id,rpc_urls,explorer_url,symbol,enabled FROM chains").all() as any[])
    .map((c) => ({ ...c, rpc_urls: safeParse(c.rpc_urls), enabled: !!c.enabled }));
  const dexes = (db.prepare(
    `SELECT c.key AS chain_key, d.name, d.type, d.factory, d.npm, d.enabled
     FROM dexes d JOIN chains c ON c.id=d.chain_id_ref`
  ).all() as any[]).map((d) => ({ ...d, enabled: !!d.enabled, factory: d.factory.toLowerCase(), npm: d.npm.toLowerCase() }));
  const staking = (db.prepare(
    `SELECT c.key AS chain_key, s.platform, s.pair_label, s.contract, s.read_type, s.enabled
     FROM staking_contracts s JOIN chains c ON c.id=s.chain_id_ref`
  ).all() as any[]).map((s) => ({ ...s, enabled: !!s.enabled, contract: s.contract.toLowerCase() }));
  const wallets = (db.prepare(
    `SELECT c.key AS chain_key, w.address, w.label, w.enabled
     FROM wallets w JOIN chains c ON c.id=w.chain_id_ref`
  ).all() as any[]).map((w) => ({ ...w, enabled: !!w.enabled, address: w.address.toLowerCase() }));
  const cexMappings = (db.prepare(
    `SELECT c.key AS chain_key, ts.token_addr, ts.token_symbol, ts.cex_symbol, ts.fixed_price, ts.quote, ts.enabled
     FROM token_symbols ts JOIN chains c ON c.id=ts.chain_id_ref`
  ).all() as any[]).map((m) => ({
    ...m,
    enabled: !!m.enabled,
    token_addr: m.token_addr.toLowerCase(),
    cex_symbol: m.cex_symbol.toUpperCase(),
    quote: (m.quote || "").toUpperCase(),
  }));

  return { version: EXPORT_VERSION, exportedAt: new Date().toISOString(), chains, dexes, staking, wallets, cex_mappings: cexMappings };
}

export interface ImportResult {
  chains: { added: number; updated: number };
  dexes: { added: number; updated: number };
  staking: { added: number; updated: number };
  wallets: { added: number; updated: number };
  cex_mappings: { added: number; updated: number };
}

/** 导入配置。事务内 upsert，失败回滚。mode: 'merge'（默认，跳过已存在）/ 'overwrite'（暂等同 merge）。 */
export function importConfig(bundle: Partial<ConfigBundle>, mode: "merge" | "overwrite" = "merge"): ImportResult {
  const db = getDb();
  const res: ImportResult = {
    chains: { added: 0, updated: 0 },
    dexes: { added: 0, updated: 0 },
    staking: { added: 0, updated: 0 },
    wallets: { added: 0, updated: 0 },
    cex_mappings: { added: 0, updated: 0 },
  };
  void mode;

  const tx = db.transaction(() => {
    // 先建链，后续按 chain_key 找 id
    const chainKeyToId = new Map<string, number>();
    for (const ch of bundle.chains ?? []) {
      if (!ch.key || !ch.chain_id || !Array.isArray(ch.rpc_urls) || ch.rpc_urls.length === 0) continue;
      const existing = db.prepare("SELECT id FROM chains WHERE key=? OR chain_id=?").get(ch.key, ch.chain_id) as any;
      const rpcJson = JSON.stringify(ch.rpc_urls);
      if (existing) {
        db.prepare(
          `UPDATE chains SET name=COALESCE(NULLIF(?, ''), name), rpc_urls=?, explorer_url=?, symbol=?, enabled=?
           WHERE id=?`
        ).run(ch.name ?? "", rpcJson, ch.explorer_url ?? "", ch.symbol ?? "ETH", ch.enabled === false ? 0 : 1, existing.id);
        chainKeyToId.set(ch.key, existing.id);
        res.chains.updated++;
      } else {
        const info = db.prepare(
          `INSERT INTO chains (key, name, chain_id, rpc_urls, explorer_url, symbol, enabled, is_default)
           VALUES (?,?,?,?,?,?,?,0)`
        ).run(ch.key, ch.name ?? ch.key, ch.chain_id, rpcJson, ch.explorer_url ?? "", ch.symbol ?? "ETH", ch.enabled === false ? 0 : 1);
        chainKeyToId.set(ch.key, Number(info.lastInsertRowid));
        res.chains.added++;
      }
    }

    for (const d of bundle.dexes ?? []) {
      const chainId = chainKeyToId.get(d.chain_key);
      if (!chainId || !d.factory || !d.npm) continue;
      const factory = d.factory.toLowerCase();
      const npm = d.npm.toLowerCase();
      const existing = db.prepare("SELECT id FROM dexes WHERE chain_id_ref=? AND factory=?").get(chainId, factory) as any;
      if (existing) {
        db.prepare(`UPDATE dexes SET name=?, type=?, npm=?, enabled=? WHERE id=?`)
          .run(d.name ?? "DEX", d.type ?? "v3-fork", npm, d.enabled === false ? 0 : 1, existing.id);
        res.dexes.updated++;
      } else {
        db.prepare(`INSERT INTO dexes (chain_id_ref, name, type, factory, npm, enabled) VALUES (?,?,?,?,?,?)`)
          .run(chainId, d.name ?? "DEX", d.type ?? "v3-fork", factory, npm, d.enabled === false ? 0 : 1);
        res.dexes.added++;
      }
    }

    for (const s of bundle.staking ?? []) {
      const chainId = chainKeyToId.get(s.chain_key);
      if (!chainId || !s.contract) continue;
      const contract = s.contract.toLowerCase();
      const existing = db.prepare("SELECT id FROM staking_contracts WHERE chain_id_ref=? AND contract=?").get(chainId, contract) as any;
      if (existing) {
        db.prepare(`UPDATE staking_contracts SET platform=?, pair_label=?, read_type=?, enabled=? WHERE id=?`)
          .run(s.platform ?? "", s.pair_label ?? "", s.read_type ?? "deposits_owner", s.enabled === false ? 0 : 1, existing.id);
        res.staking.updated++;
      } else {
        db.prepare(`INSERT INTO staking_contracts (chain_id_ref, platform, pair_label, contract, read_type, enabled) VALUES (?,?,?,?,?,?)`)
          .run(chainId, s.platform ?? "", s.pair_label ?? "", contract, s.read_type ?? "deposits_owner", s.enabled === false ? 0 : 1);
        res.staking.added++;
      }
    }

    for (const w of bundle.wallets ?? []) {
      const chainId = chainKeyToId.get(w.chain_key);
      if (!chainId || !w.address) continue;
      const addr = /^0x[a-fA-F0-9]{40}$/.test(w.address) ? w.address.toLowerCase() : null;
      if (!addr) continue;
      const existing = db.prepare("SELECT id FROM wallets WHERE chain_id_ref=? AND address=?").get(chainId, addr) as any;
      if (existing) {
        db.prepare(`UPDATE wallets SET label=?, enabled=? WHERE id=?`)
          .run(w.label ?? "", w.enabled === false ? 0 : 1, existing.id);
        res.wallets.updated++;
      } else {
        db.prepare(`INSERT INTO wallets (chain_id_ref, address, label, enabled) VALUES (?,?,?,?)`)
          .run(chainId, addr, w.label ?? "", w.enabled === false ? 0 : 1);
        res.wallets.added++;
      }
    }

    for (const m of bundle.cex_mappings ?? []) {
      const chainId = chainKeyToId.get(m.chain_key);
      if (!chainId || !m.token_addr) continue;
      const tokenAddr = m.token_addr.toLowerCase();
      const existing = db.prepare("SELECT id FROM token_symbols WHERE chain_id_ref=? AND token_addr=?").get(chainId, tokenAddr) as any;
      const cexSymbol = (m.cex_symbol || "").toUpperCase();
      const tokenSymbol = m.token_symbol ?? "";
      const fixedPrice = (m.fixed_price != null && Number(m.fixed_price) > 0) ? Number(m.fixed_price) : null;
      const quote = (m.quote || "").toUpperCase();
      const enabled = m.enabled === false ? 0 : 1;
      if (existing) {
        db.prepare(`UPDATE token_symbols SET token_symbol=?, cex_symbol=?, fixed_price=?, quote=?, enabled=? WHERE id=?`)
          .run(tokenSymbol, cexSymbol, fixedPrice, quote, enabled, existing.id);
        res.cex_mappings.updated++;
      } else {
        db.prepare(`INSERT INTO token_symbols (chain_id_ref, token_addr, token_symbol, cex_symbol, fixed_price, quote, enabled) VALUES (?,?,?,?,?,?,?)`)
          .run(chainId, tokenAddr, tokenSymbol, cexSymbol, fixedPrice, quote, enabled);
        res.cex_mappings.added++;
      }
    }
  });

  tx();
  // 配置变了，缓存可能失效
  invalidateClients();
  invalidateTokenCache();
  return res;
}

function safeParse(s: string): string[] {
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
}
