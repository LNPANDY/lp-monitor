import { getDb } from "@/lib/db";
import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 历史告警时间线。?limit=100 */
export async function GET(req: Request) {
  const limit = Math.min(Number(new URL(req.url).searchParams.get("limit") ?? 100), 500);
  const db = getDb();
  const rows = db.prepare(
    `SELECT a.*, p.dex_name, p.token_id, p.token0, p.token1, p.chain_id_ref,
            w.label AS wallet_label, w.address AS wallet_address, c.name AS chain_name, c.key AS chain_key
     FROM alerts a
     LEFT JOIN positions p ON p.id=a.position_id
     LEFT JOIN wallets w ON w.id=p.wallet_id
     LEFT JOIN chains c ON c.id=p.chain_id_ref
     ORDER BY a.sent_at DESC
     LIMIT ?`
  ).all(limit);
  return ok(rows);
}
