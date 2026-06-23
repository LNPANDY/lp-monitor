import { getDb } from "@/lib/db";
import { ok } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 列出所有已发现的仓位（含链/钱包/DEX 信息）。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const only = url.searchParams.get("state"); // 'out_of_range' | 'closed' 等
  const includeClosed = url.searchParams.get("all") === "1";
  const db = getDb();
  let sql = `SELECT p.*, w.label AS wallet_label, w.address AS wallet_address,
                    c.name AS chain_name, c.key AS chain_key, c.explorer_url,
                    d.name AS dex_display_name,
                    (SELECT a.type FROM alerts a WHERE a.position_id=p.id ORDER BY a.sent_at DESC LIMIT 1) AS last_alert_type
             FROM positions p
             JOIN wallets w ON w.id=p.wallet_id
             JOIN chains c ON c.id=p.chain_id_ref
             LEFT JOIN dexes d ON d.id=p.dex_id
             WHERE 1=1`;
  const args: any[] = [];
  if (only) { sql += " AND p.notify_state=?"; args.push(only); }
  else if (!includeClosed) { sql += " AND p.notify_state!='closed'"; }
  sql += " ORDER BY p.last_in_range ASC, p.last_checked_at DESC";
  return ok(db.prepare(sql).all(...args));
}
