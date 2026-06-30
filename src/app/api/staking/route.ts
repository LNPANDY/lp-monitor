import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql = "SELECT s.*, c.name AS chain_name, c.key AS chain_key FROM staking_contracts s JOIN chains c ON c.id=s.chain_id_ref WHERE 1=1";
  const args: any[] = [];
  if (chainId) { sql += " AND s.chain_id_ref=?"; args.push(chainId); }
  sql += " ORDER BY s.created_at DESC";
  return ok(db.prepare(sql).all(...args));
}

/**
 * 添加自定义质押合约。
 * body: { chain_id, platform, pair_label?, contract, read_type?, dex_id? }
 * platform：平台名（如 'Uniswap V3 Staker'、'Gamma'）—— 对应「合约对应的平台」
 * pair_label：交易对/池信息（如 'WETH/USDC 0.05%'）—— 对应「合约对应的交易对信息」
 * read_type：'deposits_owner'（默认，调 deposits(tokenId).owner）或 'user_info_token'
 * dex_id：关联的 DEX ID（可选，合约直查时用于定位 NPM ABI）
 */
export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; platform?: string; pair_label?: string; contract?: string; read_type?: string; dex_id?: number | null }>(req);
  if (!b.chain_id || !b.platform || !b.contract) return fail("chain_id/platform/contract 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.contract)) return fail("contract 地址非法");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO staking_contracts (chain_id_ref, platform, pair_label, contract, read_type, dex_id, enabled)
       VALUES (?,?,?,?,?,?,1)`
    ).run(b.chain_id, b.platform.trim(), b.pair_label?.trim() ?? "", b.contract.toLowerCase(), b.read_type?.trim() || "deposits_owner", b.dex_id ?? null);
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("该链上已存在此质押合约", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
