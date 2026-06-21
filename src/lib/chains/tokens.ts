/**
 * ERC20 token 元数据读取与缓存。
 * 扫描时读仓位的 token0/token1，用此模块换取 symbol/name/decimals，
 * 写入 tokens 表缓存。后续前端展示与告警文案统一用 symbol 而非地址。
 */
import type { PublicClient } from "viem";
import { getDb } from "../db";

const ERC20_ABI = [
  { name: "symbol", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { name: "name", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "string" }] },
  { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;

export interface TokenMeta {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
}

const _mem = new Map<string, TokenMeta>(); // key: `${chainDbId}:${addressLower}`

/** 批量解析多个 token 的元数据（带缓存）。失败的 token 回退为地址缩写。 */
export async function resolveTokens(
  client: PublicClient,
  chainDbId: number,
  addresses: string[]
): Promise<Map<string, TokenMeta>> {
  const out = new Map<string, TokenMeta>();
  const db = getDb();
  const todo: string[] = [];
  for (const raw of addresses) {
    const addr = raw.toLowerCase();
    const key = `${chainDbId}:${addr}`;
    if (_mem.has(key)) { out.set(addr, _mem.get(key)!); continue; }
    const row = db.prepare("SELECT * FROM tokens WHERE chain_id_ref=? AND address=?").get(chainDbId, addr) as any;
    if (row && row.symbol) {
      const m = { address: addr, symbol: row.symbol, name: row.name, decimals: row.decimals };
      _mem.set(key, m); out.set(addr, m);
    } else {
      todo.push(addr);
    }
  }

  // 对未命中的逐个 RPC 读取（ERC20 调用轻量，并行即可）
  await Promise.all(todo.map(async (addr) => {
    const m = await readFromChain(client, addr as `0x${string}`);
    const key = `${chainDbId}:${addr}`;
    _mem.set(key, m); out.set(addr, m);
    db.prepare(
      `INSERT INTO tokens (chain_id_ref, address, symbol, name, decimals, updated_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(chain_id_ref, address) DO UPDATE SET
         symbol=excluded.symbol, name=excluded.name, decimals=excluded.decimals, updated_at=excluded.updated_at`
    ).run(chainDbId, addr, m.symbol, m.name, m.decimals, new Date().toISOString());
  }));
  return out;
}

async function readFromChain(client: PublicClient, addr: `0x${string}`): Promise<TokenMeta> {
  const fallback: TokenMeta = { address: addr, symbol: shortAddr(addr), name: addr, decimals: 18 };
  try {
    const [symbol, name, decimals] = await Promise.all([
      safeRead(client, addr, "symbol"),
      safeRead(client, addr, "name"),
      safeReadNumber(client, addr, "decimals", 18),
    ]);
    return { address: addr, symbol: symbol || fallback.symbol, name: name || fallback.name, decimals };
  } catch {
    return fallback;
  }
}

async function safeRead(client: PublicClient, addr: `0x${string}`, fn: "symbol" | "name"): Promise<string> {
  try {
    const v = await client.readContract({ address: addr, abi: ERC20_ABI, functionName: fn });
    return String(v);
  } catch {
    return "";
  }
}

async function safeReadNumber(client: PublicClient, addr: `0x${string}`, fn: "decimals", def: number): Promise<number> {
  try {
    const v = await client.readContract({ address: addr, abi: ERC20_ABI, functionName: fn });
    return Number(v) || def;
  } catch {
    return def;
  }
}

function shortAddr(a: string): string {
  return a.length >= 10 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
}

/** 清空内存缓存（配置变更后调用）。 */
export function invalidateTokenCache() {
  _mem.clear();
}
