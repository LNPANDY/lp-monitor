import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

interface FavoriteRow {
  id: number;
  chain_id_ref: number;
  label: string;
  pool_addr: string;
  staker_addr: string;
  npm_addr: string;
  sort_order: number;
  created_at: string;
  token0_symbol: string;
  token1_symbol: string;
  fee: number | null;
}

interface ChainInfo {
  id: number;
  name: string;
}

/** 列出所有收藏（带链名，按 sort_order 降序、created_at 降序）。
 *  额外关联最近一次快照的 token0/token1 symbol 与 fee，用于前端展示。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql = `SELECT f.*, c.name AS chain_name,
                    ls.token0_symbol, ls.token1_symbol,
                    json_extract(ls.payload, '$.fee') AS fee
             FROM liquidity_favorites f
             JOIN chains c ON c.id=f.chain_id_ref
             LEFT JOIN (
               SELECT chain_id_ref, pool_addr, staker_addr, token0_symbol, token1_symbol, payload
               FROM liquidity_snapshots
               WHERE id IN (
                 SELECT MAX(id) FROM liquidity_snapshots
                 GROUP BY chain_id_ref, pool_addr, staker_addr
               )
             ) ls ON ls.chain_id_ref=f.chain_id_ref
                  AND ls.pool_addr=f.pool_addr
                  AND ls.staker_addr=f.staker_addr
             WHERE 1=1`;
  const args: any[] = [];
  if (chainId) { sql += " AND f.chain_id_ref=?"; args.push(Number(chainId)); }
  sql += " ORDER BY f.sort_order DESC, f.created_at DESC";
  const rows = db.prepare(sql).all(...args) as (FavoriteRow & ChainInfo)[];
  return ok(rows);
}

/** 新建收藏。chain_id + pool 必填，label/staker/npm 可选。 */
export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; label?: string; pool?: string; staker?: string; npm?: string; sort_order?: number }>(req);
  if (!b.chain_id) return fail("缺少 chain_id");
  if (!b.pool) return fail("缺少 pool 地址");
  const db = getDb();
  const pool = String(b.pool).trim().toLowerCase();
  const staker = String(b.staker || "").trim().toLowerCase();
  const npm = String(b.npm || "").trim().toLowerCase();
  const sortOrder = Number(b.sort_order) || 0;
  try {
    const info = db.prepare(
      `INSERT INTO liquidity_favorites (chain_id_ref, label, pool_addr, staker_addr, npm_addr, sort_order)
       VALUES (?,?,?,?,?,?)`
    ).run(Number(b.chain_id), String(b.label || "").trim(), pool, staker, npm, sortOrder);
    return ok({ id: info.lastInsertRowid });
  } catch {
    return fail("该 chain+pool+staker 组合已收藏");
  }
}
