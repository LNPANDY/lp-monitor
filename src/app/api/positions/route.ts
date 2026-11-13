import { getDb } from "@/lib/db";
import { ok } from "@/lib/api";
import { matchStakingContractsForPool } from "@/lib/staking/match";

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
                    t0.decimals AS token0_decimals, t1.decimals AS token1_decimals,
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
             LEFT JOIN tokens t0 ON t0.chain_id_ref=p.chain_id_ref AND LOWER(t0.address)=LOWER(p.token0)
             LEFT JOIN tokens t1 ON t1.chain_id_ref=p.chain_id_ref AND LOWER(t1.address)=LOWER(p.token1)
             WHERE 1=1`;
  const args: any[] = [];
  if (only) { sql += " AND p.notify_state=?"; args.push(only); }
  else if (!includeClosed) { sql += " AND p.notify_state!='closed'"; }
  sql += " ORDER BY p.last_in_range ASC, p.last_checked_at DESC";
  if (only === "closed") { sql += " LIMIT 60"; }
  const rows = db.prepare(sql).all(...args) as any[];

  // 为未质押仓位自动匹配已配置的质押合约（优先按链上 poolToken0/poolToken1/poolFee 精确匹配，其次按收藏池或币对+费率匹配）
  const stakingRows = db
    .prepare("SELECT id, chain_id_ref, platform, pair_label, contract, dex_id FROM staking_contracts WHERE enabled=1")
    .all() as { id: number; chain_id_ref: number; platform: string; pair_label: string; contract: string; dex_id: number | null }[];
  const favRows = db
    .prepare("SELECT chain_id_ref, LOWER(pool_addr) AS pool_addr, staker_addr, label FROM liquidity_favorites WHERE staker_addr != ''")
    .all() as { chain_id_ref: number; pool_addr: string; staker_addr: string; label: string }[];

  for (const r of rows) {
    if (r.staker_contract) {
      r.available_staker_contract = r.staker_contract;
      continue;
    }
    const matchedList = matchStakingContractsForPool(stakingRows, {
      chainIdRef: r.chain_id_ref,
      dexId: r.dex_id,
      token0: r.token0,
      token1: r.token1,
      symbol0: r.token0_symbol,
      symbol1: r.token1_symbol,
      fee: Number(r.fee) || undefined,
    });
    const matchedStake = matchedList[0];
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
