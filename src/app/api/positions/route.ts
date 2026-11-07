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
                    c.name AS chain_name, c.key AS chain_key, c.explorer_url, c.chain_id AS chain_id,
                    c.rpc_urls AS chain_rpc_urls, c.symbol AS chain_symbol,
                    d.name AS dex_display_name, d.npm AS dex_npm,
                    (SELECT a.type FROM alerts a WHERE a.position_id=p.id ORDER BY a.sent_at DESC LIMIT 1) AS last_alert_type,
                    (SELECT CASE WHEN m.id IS NOT NULL THEN 1 ELSE 0 END
                       FROM cex_alert_mutes m
                       WHERE m.chain_id_ref=p.chain_id_ref
                         AND m.token0=LOWER(p.token0)
                         AND m.token1=LOWER(p.token1)
                    ) AS cex_alert_muted
             FROM positions p
             JOIN wallets w ON w.id=p.wallet_id
             JOIN chains c ON c.id=p.chain_id_ref
             LEFT JOIN dexes d ON d.id=p.dex_id
             WHERE 1=1`;
  const args: any[] = [];
  if (only) { sql += " AND p.notify_state=?"; args.push(only); }
  else if (!includeClosed) { sql += " AND p.notify_state!='closed'"; }
  sql += " ORDER BY p.last_in_range ASC, p.last_checked_at DESC";
  if (only === "closed") { sql += " LIMIT 60"; }
  const rows = db.prepare(sql).all(...args) as any[];

  // 为未质押仓位自动匹配已配置的质押合约（按交易对币种符号或收藏池 staker_addr 匹配）
  const stakingRows = db
    .prepare("SELECT id, chain_id_ref, platform, pair_label, contract, dex_id FROM staking_contracts WHERE enabled=1")
    .all() as { id: number; chain_id_ref: number; platform: string; pair_label: string; contract: string; dex_id: number | null }[];
  const favRows = db
    .prepare("SELECT chain_id_ref, LOWER(pool_addr) AS pool_addr, staker_addr, label FROM liquidity_favorites WHERE staker_addr != ''")
    .all() as { chain_id_ref: number; pool_addr: string; staker_addr: string; label: string }[];

  const normSym = (s: string) =>
    (s || "").toLowerCase().replace(/\.(e|b|c|m|w)$/i, "").trim();

  for (const r of rows) {
    if (r.staker_contract) {
      r.available_staker_contract = r.staker_contract;
      continue;
    }
    const base0 = normSym(r.token0_symbol || "");
    const base1 = normSym(r.token1_symbol || "");
    const matchedStake = stakingRows.find((s) => {
      if (s.chain_id_ref !== r.chain_id_ref) return false;
      if (s.dex_id && r.dex_id && s.dex_id !== r.dex_id) return false;
      const rawLabel = (s.pair_label || "").toLowerCase();
      if (!rawLabel || !base0 || !base1) return false;
      const labelBases = rawLabel
        .split(/[\/\s,]+/)
        .map((t) => normSym(t))
        .filter((t) => t && !/^\d+(\.\d+)?%?$/.test(t));
      return labelBases.includes(base0) && labelBases.includes(base1);
    });
    if (matchedStake) {
      r.available_staker_contract = matchedStake.contract;
      r.available_staker_label = matchedStake.pair_label || matchedStake.platform;
      continue;
    }
    if (r.pool) {
      const matchedFav = favRows.find(
        (f) => f.chain_id_ref === r.chain_id_ref && f.pool_addr === String(r.pool).toLowerCase()
      );
      if (matchedFav) {
        r.available_staker_contract = matchedFav.staker_addr;
        r.available_staker_label = matchedFav.label || "收藏池质押合约";
      }
    }
  }

  return ok(rows);
}
