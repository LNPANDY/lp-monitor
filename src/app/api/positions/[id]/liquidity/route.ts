import { getDb } from "@/lib/db";
import { ok, fail } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { getDexe } from "@/lib/chains/dexes";
import { analyzeDirect, analyzeStaked } from "@/lib/v3/liquidity";
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
}

/**
 * 对单个仓位做流动性分析（场景A 直持 / 场景B 质押）。
 *
 * 入参：
 *   - 路径参数 id：positions 主键
 *   - body.force=1：忽略缓存强制刷新
 *
 * 流程：
 *   1. 命中未过期快照 → 直接返回（payload 已是完整结果）
 *   2. 读 position 行，取 chain/dex/staking，构造 PublicClient
 *   3. resolveTokens 拿 decimals（缺失兜底 18）
 *   4. source=direct → analyzeDirect；source=staking → analyzeStaked
 *   5. 写入 liquidity_snapshots（payload 存完整 JSON），返回结果
 */
export async function POST(req: Request, { params }: { params: { id: string } }) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  const db = getDb();

  const pos = db.prepare("SELECT * FROM positions WHERE id=?").get(params.id) as PositionRow | undefined;
  if (!pos) return fail("仓位不存在", 404);

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
        return ok({ ...JSON.parse(cached.payload), cached: true });
      } catch {
        // payload 损坏，走重算
      }
    }
  }

  if (!pos.pool) return fail("该仓位缺少 pool 地址，无法分析");
  const { client } = getClient(pos.chain_id_ref);

  // 2. decimals（用缓存表 + 必要时 RPC）
  const tokenMap = await resolveTokens(client, pos.chain_id_ref, [pos.token0, pos.token1]);
  const dec0 = tokenMap.get(pos.token0.toLowerCase())?.decimals ?? 18;
  const dec1 = tokenMap.get(pos.token1.toLowerCase())?.decimals ?? 18;
  const sym0 = pos.token0_symbol || tokenMap.get(pos.token0.toLowerCase())?.symbol || pos.token0.slice(0, 8);
  const sym1 = pos.token1_symbol || tokenMap.get(pos.token1.toLowerCase())?.symbol || pos.token1.slice(0, 8);
  const myLiquidity = BigInt(pos.last_liquidity || "0");

  // 3. 计算流动性
  let result: LiquidityResult;
  try {
    if (pos.source === "staking" && pos.staker_contract) {
      const dex = pos.dex_id ? getDexe(pos.dex_id) : null;
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

  return ok({ ...result, cached: false });
}
