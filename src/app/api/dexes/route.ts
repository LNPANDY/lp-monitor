import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql = "SELECT d.*, c.name AS chain_name, c.key AS chain_key FROM dexes d JOIN chains c ON c.id=d.chain_id_ref WHERE 1=1";
  const args: any[] = [];
  if (chainId) { sql += " AND d.chain_id_ref=?"; args.push(chainId); }
  sql += " ORDER BY d.created_at DESC";
  return ok(db.prepare(sql).all(...args));
}

/** 添加自定义 DEX（V3-fork 兼容）。body: { chain_id, name, factory, npm, type? } */
export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; name?: string; factory?: string; npm?: string; type?: string }>(req);
  if (!b.chain_id || !b.name || !b.factory || !b.npm) return fail("chain_id/name/factory/npm 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.factory)) return fail("factory 地址非法");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.npm)) return fail("npm 地址非法");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO dexes (chain_id_ref, name, type, factory, npm, enabled) VALUES (?,?,?,?,?,1)`
    ).run(b.chain_id, b.name.trim(), b.type?.trim() || "v3-fork", b.factory.toLowerCase(), b.npm.toLowerCase());
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("该链上已存在此 factory", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
