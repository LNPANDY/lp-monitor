import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { listDexes } from "@/lib/chains/dexes";
import { resolveTokens } from "@/lib/chains/tokens";
import { probeMinRange } from "@/lib/v3/liquidity";
import type { MinRangeProbeResult } from "@/lib/v3/liquidity";
import { loadAllMappings, buildQuotesByAddr, type CexQuote } from "@/lib/cex/binance";
import { sqrtPriceX96ToHumanPrice } from "@/lib/v3/math";

export const dynamic = "force-dynamic";

interface ProbeBody {
  chainId: number; // chains 主键 id
  pool: string;
  staker?: string; // 可选质押/vault 地址
  npm?: string; // 可选 NPM 地址；不传则按 chain 取第一个 enabled 的 v3-fork dex
  force?: boolean;
}

/**
 * 场景C：给定池子地址，算 fee 对应 tickSpacing 的最小窗口流动性 + 价格区间。
 * 不使用缓存——每次都走链上实时计算，确保数据最新。
 *
 * 入参（JSON body）：
 *   - chainId  chains 主键
 *   - pool     池子地址
 *   - staker   可选；提供时枚举 vault 持有的同池子 LP，统计该窗口总流动性
 *   - npm      可选；不传则取该链第一个 enabled 的 v3-fork DEX 的 npm
 *
 * 流程：
 *   1. 校验 chainId / pool
 *   2. 从 pool 读 token0/token1 → resolveTokens 拿 decimals/symbol
 *   3. 调 probeMinRange，npm/staker 同时存在才枚举 vault
 *   4. 返回结果
 */
export async function POST(req: Request) {
  try {
  const b = await getBody<ProbeBody>(req);
  if (!b.chainId) return fail("缺少 chainId");
  if (!b.pool) return fail("缺少 pool 地址");
  const staker = (b.staker || "").trim().toLowerCase();
  const db = getDb();

  const { client } = getClient(b.chainId);

  // 1. 从 pool 读 token0/token1（pool 是 v3 池，必有这两个 view）
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

  // 2. decimals / symbol
  const tokenMap = await resolveTokens(client, b.chainId, [token0, token1]);
  const dec0 = tokenMap.get(token0.toLowerCase())?.decimals ?? 18;
  const dec1 = tokenMap.get(token1.toLowerCase())?.decimals ?? 18;
  const sym0 = tokenMap.get(token0.toLowerCase())?.symbol || token0.slice(0, 8);
  const sym1 = tokenMap.get(token1.toLowerCase())?.symbol || token1.slice(0, 8);

  // 3. 确定 npm（staker 场景枚举 NFT 必需）
  let npm: string | undefined = b.npm;
  if (!npm) {
    const dex = listDexes(b.chainId, true).find((d) => d.type === "v3-fork");
    npm = dex?.npm;
  }
  const npmArg = npm ? (npm as `0x${string}`) : undefined;
  const stakerArg = staker ? (staker as `0x${string}`) : undefined;

  // 4. 计算
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

  // 5. CEX 差价计算（复用 scanner 同款逻辑）
  const cexMappingsByChain = loadAllMappings();
  const chainMappings = cexMappingsByChain.get(b.chainId) ?? [];
  let cexPayload: any = undefined;
  if (chainMappings.length > 0) {
    const quoteByAddr = await buildQuotesByAddr(chainMappings);
    const q0 = quoteByAddr.get(token0.toLowerCase());
    const q1 = quoteByAddr.get(token1.toLowerCase());
    if (q0 && q1 && result.priceCurrent) {
      const dexRate = Number(result.priceCurrent);
      const cexRate = q0.price / q1.price;
      if (Number.isFinite(dexRate) && dexRate > 0 && Number.isFinite(cexRate) && cexRate > 0) {
        const diff = (dexRate - cexRate) / cexRate;
        const absDiff = Math.abs(diff);
        const threshold = (result.fee / 1_000_000) * 2;
        const quote = q0.quote === q1.quote ? q0.quote || "USD" : `${q0.quote}/${q1.quote}`;
        cexPayload = {
          pairLabel: `${sym0}/${sym1}`,
          token0CexSymbol: q0.symbol,
          token1CexSymbol: q1.symbol,
          quote,
          dexRate,
          cexRate,
          diff,
          absDiff,
          exceedsThreshold: absDiff >= threshold,
        };
      }
    }
  }

  // 6. 翻转状态：从 pair_flips 表读取（按 chain + token 对匹配）
  let pairFlip = 0;
  const dexName = npm
    ? (listDexes(b.chainId, false).find(d => d.npm.toLowerCase() === npm.toLowerCase())?.name ?? "")
    : "";
  const flipRow = db
    .prepare("SELECT id FROM pair_flips WHERE chain_id_ref=? AND (dex_name=? OR dex_name='') AND token0=? AND token1=?")
    .get(b.chainId, dexName, token0.toLowerCase(), token1.toLowerCase());
  if (flipRow) pairFlip = 1;

  // 7. 探针成功后，把 symbol 写回匹配的收藏（按 UNIQUE 键 chain_id_ref+pool_addr+staker_addr）
  // 这样收藏列表能显示真实 token symbol（如 W0G/USDC.e），而非空值回退
  if (sym0 && sym1) {
    try {
      db.prepare(
        `UPDATE liquidity_favorites
         SET token0_symbol = ?, token1_symbol = ?
         WHERE chain_id_ref = ? AND pool_addr = ? AND COALESCE(staker_addr, '') = ?`
      ).run(sym0, sym1, b.chainId, b.pool.toLowerCase(), staker);
    } catch {
      // 写回失败不影响探针主流程
    }
  }

  return ok({ ...result, token0, token1, pairFlip, cex: cexPayload, cached: false });
  } catch (e) {
    console.error("[liquidity-probe] UNCAUGHT:", e);
    return fail(`未捕获异常：${(e as Error).message}`, 500);
  }
}
