import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { listDexes } from "@/lib/chains/dexes";
import { resolveTokens } from "@/lib/chains/tokens";
import { probeMinRange } from "@/lib/v3/liquidity";
import type { MinRangeProbeResult } from "@/lib/v3/liquidity";

export const dynamic = "force-dynamic";

/** 快照缓存有效期 10 分钟（按 chain+pool+staker 维度缓存）。 */
const CACHE_TTL_MS = 10 * 60 * 1000;

interface ProbeBody {
  chainId: number; // chains 主键 id
  pool: string;
  staker?: string; // 可选质押/vault 地址
  npm?: string; // 可选 NPM 地址；不传则按 chain 取第一个 enabled 的 v3-fork dex
  force?: boolean;
}

/**
 * 场景C：给定池子地址，算 fee 对应 tickSpacing 的最小窗口流动性 + 价格区间。
 *
 * 入参（JSON body）：
 *   - chainId  chains 主键
 *   - pool     池子地址
 *   - staker   可选；提供时枚举 vault 持有的同池子 LP，统计该窗口总流动性
 *   - npm      可选；不传则取该链第一个 enabled 的 v3-fork DEX 的 npm
 *   - force=1  忽略缓存
 *
 * 流程：
 *   1. 校验 chainId / pool
 *   2. 命中 (chainId, pool, staker) 维度的快照缓存 → 直接返回
 *   3. 从 pool 读 token0/token1 → resolveTokens 拿 decimals/symbol
 *   4. 调 probeMinRange，npm/staker 同时存在才枚举 vault
 *   5. 写缓存，返回结果
 */
export async function POST(req: Request) {
  const b = await getBody<ProbeBody>(req);
  if (!b.chainId) return fail("缺少 chainId");
  if (!b.pool) return fail("缺少 pool 地址");
  const staker = (b.staker || "").trim().toLowerCase();
  const force = b.force === true;
  const db = getDb();

  // 1. 命中缓存（按 chain+pool+staker 维度）
  if (!force) {
    const cached = db
      .prepare(
        `SELECT payload FROM liquidity_snapshots
         WHERE chain_id_ref=? AND pool_addr=? AND staker_addr=?
           AND datetime(expires_at) > datetime('now')
         ORDER BY id DESC LIMIT 1`
      )
      .get(b.chainId, b.pool.toLowerCase(), staker) as { payload: string } | undefined;
    if (cached?.payload) {
      try {
        return ok({ ...JSON.parse(cached.payload), cached: true });
      } catch {
        // payload 损坏，走重算
      }
    }
  }

  const { client } = getClient(b.chainId);

  // 2. 从 pool 读 token0/token1（pool 是 v3 池，必有这两个 view）
  const POOL_TOKEN_ABI = [
    { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
    { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  ] as const;
  let token0: string;
  let token1: string;
  try {
    [token0, token1] = (await Promise.all([
      client.readContract({ address: b.pool as `0x${string}`, abi: POOL_TOKEN_ABI, functionName: "token0" }),
      client.readContract({ address: b.pool as `0x${string}`, abi: POOL_TOKEN_ABI, functionName: "token1" }),
    ])) as [string, string];
  } catch (e) {
    return fail(`读取池子 token 失败：${(e as Error).message}`, 502);
  }

  // 3. decimals / symbol
  const tokenMap = await resolveTokens(client, b.chainId, [token0, token1]);
  const dec0 = tokenMap.get(token0.toLowerCase())?.decimals ?? 18;
  const dec1 = tokenMap.get(token1.toLowerCase())?.decimals ?? 18;
  const sym0 = tokenMap.get(token0.toLowerCase())?.symbol || token0.slice(0, 8);
  const sym1 = tokenMap.get(token1.toLowerCase())?.symbol || token1.slice(0, 8);

  // 4. 确定 npm（staker 场景枚举 NFT 必需）
  let npm: string | undefined = b.npm;
  if (!npm) {
    const dex = listDexes(b.chainId, true).find((d) => d.type === "v3-fork");
    npm = dex?.npm;
  }
  const npmArg = npm ? (npm as `0x${string}`) : undefined;
  const stakerArg = staker ? (staker as `0x${string}`) : undefined;

  // 5. 计算
  let result: MinRangeProbeResult;
  try {
    result = await probeMinRange(
      client,
      b.pool as `0x${string}`,
      dec0,
      dec1,
      sym0,
      sym1,
      npmArg,
      stakerArg
    );
  } catch (e) {
    return fail(`最小区间探针失败：${(e as Error).message}`, 502);
  }

  // 6. 写缓存（probe 快照 position_id 为空）
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
     VALUES (NULL,?,?,?,?, ?,?, '','','','',
             ?,?,?, ?,?,?,?,
             ?,?,?)`
  ).run(
    b.chainId,
    b.pool.toLowerCase(),
    staker,
    sym0,
    sym1,
    result.priceLow,
    result.priceHigh,
    result.priceLabel,
    result.tickLower,
    result.tickUpper,
    result.currentTick,
    0,
    payload,
    now.toISOString(),
    expires.toISOString()
  );

  return ok({ ...result, cached: false });
}
