import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * GET: 列出 CEX 报价匹配。
 *  - ?chain_id=N  按链过滤
 *  - 不带参数     返回全部
 * 关联 chains 表带出链名。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql =
    "SELECT t.*, c.name AS chain_name, c.key AS chain_key " +
    "FROM token_symbols t JOIN chains c ON c.id=t.chain_id_ref WHERE 1=1";
  const args: any[] = [];
  if (chainId) {
    sql += " AND t.chain_id_ref=?";
    args.push(chainId);
  }
  sql += " ORDER BY t.created_at DESC";
  return ok(db.prepare(sql).all(...args));
}

/**
 * POST: 新增一条 CEX 报价匹配。
 * body: { chain_id, token_addr, token_symbol?, cex_symbol }
 *  - token_addr: 链上 token 合约地址
 *  - cex_symbol: 币安交易对 symbol，如 '0GUSDT' / 'ETHUSDC'（用户自选计价货币）
 *  - token_symbol: 可选，缓存的 ERC20 symbol（展示用，可留空）
 */
export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; token_addr?: string; token_symbol?: string; cex_symbol?: string }>(req);
  if (!b.chain_id || !b.token_addr || !b.cex_symbol) return fail("chain_id/token_addr/cex_symbol 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.token_addr)) return fail("token_addr 地址非法");
  if (!/^[A-Z0-9]{2,20}$/.test(b.cex_symbol.toUpperCase())) return fail("cex_symbol 格式非法（应为如 0GUSDT 的大写字母数字）");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO token_symbols (chain_id_ref, token_addr, token_symbol, cex_symbol, enabled)
       VALUES (?,?,?,?,1)`
    ).run(b.chain_id, b.token_addr.toLowerCase(), b.token_symbol?.trim() ?? "", b.cex_symbol.toUpperCase());
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("该链上已存在此 token 的匹配", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
