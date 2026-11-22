import { getDb, isPairFlipped } from "@/lib/db";
import { ok, fail } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { getDexe } from "@/lib/chains/dexes";
import { analyzeDirect, analyzeDirectV4, analyzeStaked } from "@/lib/v3/liquidity";
import type { LiquidityResult } from "@/lib/v3/liquidity";

export const dynamic = "force-dynamic";

/** 快照缓存有效期 10 分钟，避免高频重复打 RPC。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface PositionRow {
  id: number;
  chain_id_ref: number;
  dex_id: number | null;
  token0: string;
  token1: string;
  token0_symbol: string;
  token1_symbol: string;
  pool: string;
  tick_lower: number;
  tick_upper: number;
  source: string;
  staker_contract: string;
  last_liquidity: string;
  pair_flip?: number;
}

/**
 * 对单个仓位做流动性分析（场景A 直持 V3/V4 / 场景B 质押）。
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  try {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const db = getDb();

  const pos = db.prepare("SELECT * FROM positions WHERE id=?").get(params.id) as PositionRow | undefined;
  if (!pos) return fail("仓位不存在", 404);
  const pairFlip = pos.pair_flip === 1 || isPairFlipped(pos.chain_id_ref, pos.token0, pos.token1) ? 1 : 0;

  // 1. 命中缓存
  if (!force) {
    const cached = db
      .prepare(
        `SELECT payload, sampled_at, expires_at FROM liquidity_snapshots
         WHERE position_id=? AND datetime(expires_at) > datetime('now')
         ORDER BY id DESC LIMIT 1`
      )
      .get(params.id) as { payload: string } | undefined;
    if (cached?.payload) {
      try {
        return ok({ ...JSON.parse(cached.payload), pairFlip, cached: true });
      } catch {
        // payload 损坏，走重算
      }
    }
  }

  if (!pos.pool) return fail("该仓位缺少 pool 地址 / poolId，无法分析");
  const { client } = getClient(pos.chain_id_ref);

  // 2. decimals（用缓存表 + 必要时 RPC）
  const tokenMap = await resolveTokens(client, pos.chain_id_ref, [pos.token0, pos.token1]);
  const dec0 = tokenMap.get(pos.token0.toLowerCase())?.decimals ?? 18;
  const dec1 = tokenMap.get(pos.token1.toLowerCase())?.decimals ?? 18;
  const sym0 = pos.token0_symbol || tokenMap.get(pos.token0.toLowerCase())?.symbol || pos.token0.slice(0, 8);
  const sym1 = pos.token1_symbol || tokenMap.get(pos.token1.toLowerCase())?.symbol || pos.token1.slice(0, 8);
  const myLiquidity = BigInt(pos.last_liquidity || "0");
  let dex = pos.dex_id ? getDexe(pos.dex_id) : null;
  if (!dex && /^0x[0-9a-fA-F]{64}$/.test(pos.pool)) {
    const v4Row = db
      .prepare("SELECT id FROM dexes WHERE chain_id_ref=? AND type='v4' ORDER BY enabled DESC LIMIT 1")
      .get(pos.chain_id_ref) as { id: number } | undefined;
    if (v4Row) dex = getDexe(v4Row.id);
  }

  // 3. 计算流动性（支持 V4 StateView / V3 直持 / V3 质押）
  let result: LiquidityResult;
  try {
    if (dex?.type === "v4" || /^0x[0-9a-fA-F]{64}$/.test(pos.pool)) {
      if (!dex?.stateview || !/^0x[0-9a-fA-F]{40}$/.test(dex.stateview)) {
        return fail("该 V4 DEX 未配置 StateView 合约地址，无法分析流动性");
      }
      result = await analyzeDirectV4(
        client,
        dex.stateview as `0x${string}`,
        pos.pool as `0x${string}`,
        dec0,
        dec1,
        myLiquidity,
        pos.tick_lower,
        pos.tick_upper,
        sym0,
        sym1
      );
    } else if (pos.source === "staking" && pos.staker_contract) {
      if (!dex) return fail("该仓位缺少 DEX（npm）信息，无法分析质押流动性");
      result = await analyzeStaked(
        client,
        dex.npm as `0x${string}`,
        pos.staker_contract as `0x${string}`,
        pos.pool as `0x${string}`,
        dec0,
        dec1,
        pos.tick_lower,
        pos.tick_upper,
        sym0,
        sym1,
        myLiquidity
      );
    } else {
      result = await analyzeDirect(
        client,
        pos.pool as `0x${string}`,
        dec0,
        dec1,
        myLiquidity,
        pos.tick_lower,
        pos.tick_upper,
        sym0,
        sym1
      );
    }
  } catch (e) {
    return fail(`流动性分析失败：${(e as Error).message}`, 502);
  }

  // 4. 写快照缓存
  const now = new Date();
  const expires = new Date(now.getTime() + CACHE_TTL_MS);
  const payload = JSON.stringify(result);
  db.prepare(
    `INSERT INTO liquidity_snapshots
       (position_id, chain_id_ref, pool_addr, staker_addr,
        token0_symbol, token1_symbol,
        total_token0, total_token1, mine_token0, mine_token1, share,
        price_low, price_high, price_label,
        tick_lower, tick_upper, current_tick, position_count,
        payload, sampled_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    pos.id,
    pos.chain_id_ref,
    pos.pool,
    pos.staker_contract,
    sym0,
    sym1,
    result.total.amount0,
    result.total.amount1,
    result.mine.amount0,
    result.mine.amount1,
    result.share,
    result.priceLow,
    result.priceHigh,
    result.priceLabel,
    result.tickLower,
    result.tickUpper,
    result.currentTick,
    result.positionCount,
    payload,
    now.toISOString(),
    expires.toISOString()
  );

  return ok({ ...result, pairFlip, cached: false });
  } catch (e) {
    return fail(`流动性分析异常：${(e as Error).message}`, 500);
  }
}
