import { createPublicClient, fallback, http, type PublicClient, type Chain } from "viem";
import { getDb } from "../db";

export interface ChainRow {
  id: number;
  key: string;
  name: string;
  chain_id: number;
  rpc_urls: string[];
  explorer_url: string;
  symbol: string;
  enabled: number;
  is_default: number;
}

export function parseChainRow(r: any): ChainRow {
  return {
    ...r,
    rpc_urls: safeParseStrArray(r.rpc_urls),
  };
}

function safeParseStrArray(s: string): string[] {
  try {
    const a = JSON.parse(s);
    return Array.isArray(a) ? a.filter(Boolean) : [];
  } catch {
    return s ? [s] : [];
  }
}

export function listChains(enabledOnly = false): ChainRow[] {
  const db = getDb();
  const rows = enabledOnly
    ? db.prepare("SELECT * FROM chains WHERE enabled=1").all()
    : db.prepare("SELECT * FROM chains").all();
  return rows.map(parseChainRow);
}

export function getChain(id: number): ChainRow | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM chains WHERE id=?").get(id);
  return r ? parseChainRow(r) : null;
}

export function getChainByKey(key: string): ChainRow | null {
  const db = getDb();
  const r = db.prepare("SELECT * FROM chains WHERE key=?").get(key);
  return r ? parseChainRow(r) : null;
}

/**
 * viem 的 Chain 对象。我们只关心 chainId 和 name，RPC 通过 fallback(http) 注入，
 * 不依赖 viem 内置 chain 定义，因此支持任意自定义链。
 */
function toViemChain(c: ChainRow): Chain {
  return {
    id: c.chain_id,
    name: c.name,
    nativeCurrency: { name: c.symbol, symbol: c.symbol, decimals: 18 },
    rpcUrls: { default: { http: c.rpc_urls } },
  } as Chain;
}

const _clientCache = new Map<number, PublicClient>();

/** 按 chainId（数据库主键 id）返回带 fallback RPC 的 PublicClient。 */
export function getClient(chainDbId: number): { client: PublicClient; chain: ChainRow } {
  if (_clientCache.has(chainDbId)) {
    const cached = _clientCache.get(chainDbId)!;
    const chain = getChain(chainDbId)!;
    return { client: cached, chain };
  }
  const chain = getChain(chainDbId);
  if (!chain) throw new Error(`chain #${chainDbId} not found`);
  if (chain.rpc_urls.length === 0) throw new Error(`chain ${chain.key} has no rpc_urls`);

  const transports = chain.rpc_urls.map((u) => http(u, { timeout: 15_000, retryCount: 1 }));
  const client = createPublicClient({
    chain: toViemChain(chain),
    transport: fallback(transports, { rank: false }),
    batch: { multicall: true },
  });
  _clientCache.set(chainDbId, client);
  return { client, chain };
}

/** 清空 client 缓存——配置变更后调用，强制重建。 */
export function invalidateClients() {
  _clientCache.clear();
}
