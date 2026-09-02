/**
 * 收藏池监控扫描（fav-pool scanner）。
 *
 * 对流动性探针收藏中开启"快速扫描监控"（monitor_cex=1）的池子：
 *   1. 轻量读取池子状态（token0/token1/fee/slot0，4 个 view 调用，不依赖仓位）
 *   2. 池价与 CEX 报价对比（复用 computeCexPriceDiff，动态阈值 fee×2 与现有推送一致）
 *   3. 超阈值 → 推送告警（受 fav_cex_price 冷却限制，push_states 按 entity_type='fav_pool' 隔离）
 *
 * 设计约束：
 *   - 不写 alerts 表（alerts.position_id 有 positions 外键约束，收藏 id 会违反）
 *   - 交易对翻转（pair_flip）与静音（cex_alert_mutes）检查与仓位推送保持一致
 *   - 由 enhanced-scheduler 在 fast discover 之后、known 扫描之前作为 Step 1.5 调用
 */
import { getDb } from "../db";
import { getClient } from "../chains";
import { resolveTokens } from "../chains/tokens";
import { isCexPriceEnabled } from "../db/settings";
import { loadAllMappings, buildQuotesByAddr, type CexQuote } from "../cex/binance";
import { computeCexPriceDiff, type CexPriceInfo, type CexPricePayload } from "./scanner";
import { notifyAll } from "../notify";
import { shouldPush, recordPush } from "../notify/dedup";
import type { PublicClient } from "viem";

export interface FavPoolScanSummary {
  /** 本次检查的收藏池数 */
  checked: number;
  /** 触发推送的池数 */
  alerted: number;
  /** 错误列表 */
  errors: string[];
}

const POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
    ],
  },
] as const;

/**
 * sqrtPriceX96 → raw 价字符串（token1 raw / token0 raw，18 位精度）。
 * 与 v3 的 1.0001^tick 同口径，可直接作为 computeCexPriceDiff 的 dexRateStr 入参。
 * price = (sqrtPriceX96 / 2^96)^2，放大 10^18 保留小数精度。
 */
function sqrtPriceX96ToRawPrice(sqrtPriceX96: bigint): string {
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const scaled = (priceX192 * (10n ** 18n)) >> 192n; // raw price × 10^18
  const intPart = scaled / 10n ** 18n;
  const fracPart = scaled % 10n ** 18n;
  return `${intPart}.${fracPart.toString().padStart(18, "0")}`;
}

/** 收藏池 CEX 价差告警文案 */
function buildFavCexNotification(opts: {
  chainName: string;
  poolAddr: string;
  label: string;
  sym0: string;
  sym1: string;
  payload: CexPricePayload;
  flipped: boolean;
  cexQuote0?: CexQuote;
  cexQuote1?: CexQuote;
}): { title: string; body: string } {
  const { chainName, poolAddr, label, sym0, sym1, payload, flipped, cexQuote0, cexQuote1 } = opts;
  const pairLabel = flipped ? `${sym1}/${sym0}` : `${sym0}/${sym1}`;
  const name = label || pairLabel;
  const pct = (payload.absDiff * 100).toFixed(2);
  const direction = payload.diff > 0 ? "DEX 高于 CEX" : "DEX 低于 CEX";
  const q0 = cexQuote0 ? `${payload.token0CexSymbol}=${cexQuote0.price}${cexQuote0.quote ? " " + cexQuote0.quote : ""}` : payload.token0CexSymbol;
  const q1 = cexQuote1 ? `${payload.token1CexSymbol}=${cexQuote1.price}${cexQuote1.quote ? " " + cexQuote1.quote : ""}` : payload.token1CexSymbol;
  return {
    title: `收藏池价差预警 ${name} · ${chainName}`,
    body: [
      `${name} 池价与 CEX 价差 ${pct}%（${direction}），超过动态阈值`,
      `DEX: 1 ${sym0} = ${payload.dexRate.toPrecision(8)} ${sym1}`,
      `CEX: 1 ${sym0} = ${payload.cexRate.toPrecision(8)} ${sym1}`,
      `报价: ${q0} · ${q1}`,
      `池子: ${poolAddr}`,
    ].join("\n"),
  };
}

/** 执行一次收藏池监控扫描 */
export async function scanFavoritePools(): Promise<FavPoolScanSummary> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let checked = 0;
  let alerted = 0;
  const db = getDb();

  const cexEnabled = isCexPriceEnabled();
  if (!cexEnabled) {
    return { checked: 0, alerted: 0, errors };
  }

  // 所有开启监控的收藏（仅 enabled 链）
  const favorites = db.prepare(
    `SELECT f.*, c.name AS chain_name
     FROM liquidity_favorites f
     JOIN chains c ON c.id = f.chain_id_ref
     WHERE f.monitor_cex = 1 AND c.enabled = 1`
  ).all() as any[];

  if (favorites.length === 0) {
    return { checked: 0, alerted: 0, errors };
  }

  // 按 chain 分组处理
  const byChain = new Map<number, any[]>();
  for (const f of favorites) {
    const list = byChain.get(f.chain_id_ref) ?? [];
    list.push(f);
    byChain.set(f.chain_id_ref, list);
  }

  const cexMappingsByChain = loadAllMappings();

  for (const [chainIdRef, favs] of byChain) {
    try {
      const { client, chain } = getClient(chainIdRef);
      const chainMappings = cexMappingsByChain.get(chainIdRef) ?? [];
      if (chainMappings.length === 0) continue;

      // 本链已静音的 token 对
      const mutedPairs = new Set<string>();
      const muteRows = db.prepare(
        "SELECT token0, token1 FROM cex_alert_mutes WHERE chain_id_ref=?"
      ).all(chainIdRef) as { token0: string; token1: string }[];
      for (const m of muteRows) mutedPairs.add(`${m.token0}|${m.token1}`);

      for (const fav of favs) {
        try {
          checked++;
          const pool = fav.pool_addr as `0x${string}`;

          // 1. 轻量读取池子状态（4 个 view 并行）
          const [token0, token1, fee, slot0] = await Promise.all([
            client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }) as Promise<string>,
            client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }) as Promise<string>,
            client.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }) as Promise<number>,
            client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<readonly any[]>,
          ]);
          const sqrtPriceX96 = slot0[0] as bigint;

          // 2. symbol/decimals（resolveTokens 带缓存）
          const tokenMap = await resolveTokens(client, chainIdRef, [token0, token1]);
          const sym0 = tokenMap.get(token0.toLowerCase())?.symbol ?? "";
          const sym1 = tokenMap.get(token1.toLowerCase())?.symbol ?? "";
          const dec0 = tokenMap.get(token0.toLowerCase())?.decimals ?? 18;
          const dec1 = tokenMap.get(token1.toLowerCase())?.decimals ?? 18;

          // 3. CEX 报价（buildQuotesByAddr 30s 缓存与 known 扫描共享）
          const needFetch = chainMappings.filter((m) =>
            [token0.toLowerCase(), token1.toLowerCase()].includes(m.tokenAddr)
          );
          if (needFetch.length === 0) continue; // 两侧都无 CEX 映射，跳过
          const quoteByAddr = await buildQuotesByAddr(needFetch);

          // 4. 池价 vs CEX（raw 价口径与仓位扫描一致）
          const rawPrice = sqrtPriceX96ToRawPrice(sqrtPriceX96);
          const cexPriceInfo: CexPriceInfo | null = computeCexPriceDiff(
            token0.toLowerCase(),
            token1.toLowerCase(),
            rawPrice,
            quoteByAddr,
            Number(fee),
            sym0,
            sym1,
            dec0,
            dec1
          );

          // 5. pair_flip（与探针 API 同款宽匹配）
          let flipped = false;
          const dexRow = fav.npm_addr
            ? db.prepare("SELECT name FROM dexes WHERE chain_id_ref=? AND LOWER(npm)=LOWER(?)").get(chainIdRef, fav.npm_addr) as { name: string } | undefined
            : undefined;
          const dexName = dexRow?.name ?? "";
          const flipRow = db.prepare(
            "SELECT id FROM pair_flips WHERE chain_id_ref=? AND (dex_name=? OR dex_name='') AND token0=? AND token1=?"
          ).get(chainIdRef, dexName, token0.toLowerCase(), token1.toLowerCase());
          if (flipRow) flipped = true;

          // 6. 不做静音检查：收藏池是用户手动逐个开启监控的白名单，
          //    cex_alert_mutes 静音表是给仓位自动推送降噪用的；想停某收藏池
          //    的推送直接关闭其 monitor_cex 开关即可。

          // 7. 超阈值 → 推送（fav_cex_price 冷却，entity_type=fav_pool）
          if (cexPriceInfo && cexPriceInfo.exceedsThreshold) {
            const allowed = shouldPush(fav.id, "fav_cex_price", "exceeds_threshold", "fav_pool");
            if (allowed) {
              const n = buildFavCexNotification({
                chainName: chain.name,
                poolAddr: fav.pool_addr,
                label: fav.label ?? "",
                sym0, sym1,
                payload: cexPriceInfo.payload,
                flipped,
                cexQuote0: quoteByAddr.get(token0.toLowerCase()),
                cexQuote1: quoteByAddr.get(token1.toLowerCase()),
              });
              try {
                await notifyAll(n);
              } catch (e: any) {
                errors.push(`[fav-pools] notify failed pool ${fav.pool_addr}: ${e?.message ?? e}`);
              }
              recordPush(fav.id, "fav_cex_price", "exceeds_threshold", "fav_pool");
              alerted++;
            }
          }
        } catch (e: any) {
          errors.push(`[fav-pools] pool ${fav.pool_addr} on chain ${chainIdRef}: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      errors.push(`[fav-pools] chain ${chainIdRef}: ${e?.message ?? e}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[fav-pools] done: checked=${checked} alerted=${alerted} errors=${errors.length} (${durationMs}ms)`);
  return { checked, alerted, errors };
}
