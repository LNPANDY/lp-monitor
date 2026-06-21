import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 列出所有监控钱包。 */
export async function GET() {
  const db = getDb();
  const rows = db.prepare(
    `SELECT w.*, c.name AS chain_name, c.key AS chain_key
     FROM wallets w JOIN chains c ON c.id=w.chain_id_ref
     ORDER BY w.created_at DESC`
  ).all();
  return ok(rows);
}

/** 添加监控钱包。body: { chain_id, address, label } */
export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; address?: string; label?: string }>(req);
  if (!b.chain_id || !b.address) return fail("chain_id 和 address 必填");
  const addr = b.address.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(addr)) return fail("address 格式非法");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO wallets (chain_id_ref, address, label, enabled) VALUES (?,?,?,1)`
    ).run(b.chain_id, addr.toLowerCase(), b.label?.trim() ?? "");
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("该链上已存在此钱包", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
