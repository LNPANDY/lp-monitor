/**
 * 已知仓位快速扫描器
 * 专门用于快速更新已知仓位的状态，检测已关闭仓位，并处理告警
 * 性能目标：100个仓位 < 10秒
 * 与全量扫描(scanner.ts)共享推送去重(dedup.ts)和告警文案构建函数
 */
import { getDb, isPairFlipped } from "../db";
import { listChains, getClient } from "../chains";
import type { PublicClient } from "viem";
import { resolveTokens } from "../chains/tokens";
import { listDexes, listStaking } from "../chains/dexes";
import { getAdapter } from "../adapters";
import { batchReadPoolTicks, primePoolAddressCache } from "../adapters/v3-fork";
import { findZiaVaultStakedPositions } from "../staking/discover";
import { isCexPriceEnabled, getTickMoveThreshold, isTickMoveEnabled } from "../db/settings";
import { notifyAll } from "../notify";
import { shouldPush, recordPush } from "../notify/dedup";
import { loadAllMappings, buildQuotesByAddr, type CexQuote } from "../cex/binance";
import {
  computeCexPriceDiff,
  rawToHumanPrice,
  buildNotification,
  buildTickMoveNotification,
  buildCexPriceNotification,
  type WalletRow,
  type CexPricePayload,
} from "./scanner";

async function eachLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = items[idx++];
      await worker(cur);
    }
  });
  await Promise.all(runners);
}

export interface KnownPositionsSummary {
  positions: number;          // 处理的仓位总数
  active: number;            // 活跃仓位数
  closed: number;            // 已关闭仓位数
  alertsSent: number;        // 发送的告警数
  pushSkipped: number;       // 跳过的推送数（频次控制）
  durationMs: number;         // 扫描耗时
  errors: string[];          // 错误信息
  at?: string;               // 扫描时间
  error?: string;            // 错误信息（单个错误）
}

/**
 * 快速扫描已知仓位
 */
export async function scanKnownPositions(): Promise<KnownPositionsSummary> {
  const startTime = Date.now();
  const db = getDb();
  
  console.log(`[scanner] 开始已知仓位快速扫描`);
  
  const summary: KnownPositionsSummary = {
    positions: 0,
    active: 0,
    closed: 0,
    alertsSent: 0,
    pushSkipped: 0,
    durationMs: 0,
    errors: [],
  };

  try {
    // CEX 静音缓存（与全量扫描一致：同一 token 对本次扫描内不重复查 DB）
    const cexMutedPairs = new Set<string>();

    // 1. 查询所有未关闭的仓位
    const positionsQuery = `
      SELECT p.*, w.label AS wallet_label, w.address AS wallet_address,
             c.name AS chain_name, c.key AS chain_key, c.symbol AS chain_symbol
      FROM positions p
      JOIN wallets w ON w.id = p.wallet_id
      JOIN chains c ON c.id = p.chain_id_ref
      WHERE p.notify_state != 'closed'
      ORDER BY p.last_checked_at ASC
    `;
    
    const positions = db.prepare(positionsQuery).all() as any[];
    summary.positions = positions.length;
    
    if (positions.length === 0) {
      console.log(`[scanner-known] 没有未关闭的仓位`);
      return summary;
    }
    
    console.log(`[scanner-known] 开始扫描 ${positions.length} 个已知仓位`);
    
    // 2. 按链分组，准备批量查询
    const chainsByRef = new Map<number, any>();
    const positionsByChain = new Map<number, any[]>();
    
    positions.forEach(pos => {
      if (!chainsByRef.has(pos.chain_id_ref)) {
        const chain = listChains().find(c => c.id === pos.chain_id_ref);
        if (chain) {
          chainsByRef.set(pos.chain_id_ref, chain);
          positionsByChain.set(pos.chain_id_ref, []);
        }
      }
      if (positionsByChain.has(pos.chain_id_ref)) {
        positionsByChain.get(pos.chain_id_ref)!.push(pos);
      }
    });
    
    // 3. 处理每个链的仓位
    for (const [chainRef, chain] of chainsByRef) {
      const chainPositions = positionsByChain.get(chainRef) || [];
      await processChainPositions(chain, chainPositions, chainRef, summary, cexMutedPairs);
    }
    
    // 4. 统计结果
    summary.durationMs = Date.now() - startTime;
    console.log(`[scanner] 已知仓位扫描完成: 扫描 ${summary.positions} 个仓位, ${summary.active} 个在区间内, ${summary.closed} 个已关闭, 发送 ${summary.alertsSent} 个告警${summary.pushSkipped > 0 ? `, ${summary.pushSkipped} 个去重跳过` : ""}, 耗时 ${summary.durationMs}ms`);
    if (summary.errors.length > 0) {
      console.log(`[scanner] 已知仓位扫描错误: ${summary.errors.length} 个`);
    }
    
  } catch (error) {
    console.error(`[scanner-known] 扫描失败:`, error);
    summary.errors.push(error instanceof Error ? error.message : String(error));
  }
  
  return summary;
}

/**
 * 处理单个链的仓位
 */
async function processChainPositions(chain: any, positions: any[], chainIdRef: number, summary: KnownPositionsSummary, cexMutedPairs: Set<string>) {
  const db = getDb();
  
  try {
    // 获取链的客户端
    const chainClient = getClient(chainIdRef);
    if (!chainClient) {
      console.error(`[scanner-known] 无法获取链 ${chain.key} 的客户端`);
      return;
    }
    const client = chainClient.client;
    
    // 获取DEX信息与质押合约信息
    const dexes = listDexes().filter(d => d.chain_id_ref === chain.id);
    if (dexes.length === 0) {
      console.error(`[scanner-known] 链 ${chain.key} 没有配置DEX`);
      return;
    }
    const stakingList = listStaking(chainIdRef, true);

    // 自愈同步：通过 ZiaVault 1-RPC 极速检查已知仓位是否已被质押（解决一键质押后仍显示持仓钱包的延迟问题）
    if (stakingList.length > 0) {
      const uniqueWallets = Array.from(
        new Set(positions.map(p => String(p.wallet_address || "").toLowerCase()).filter(w => /^0x[a-f0-9]{40}$/.test(w)))
      ) as `0x${string}`[];
      if (uniqueWallets.length > 0) {
        try {
          const stakedByWallet = await findZiaVaultStakedPositions(client, uniqueWallets, dexes, stakingList);
          const stakedByTokenId = new Map<string, { stakerContract?: string; stakingId?: number }>();
          for (const [, list] of stakedByWallet) {
            for (const dp of list) {
              stakedByTokenId.set(String(dp.tokenId), {
                stakerContract: dp.stakerContract,
                stakingId: dp.stakingId,
              });
            }
          }
          for (const pos of positions) {
            const stInfo = stakedByTokenId.get(String(pos.token_id));
            if (stInfo && (pos.source !== "staking" || (stInfo.stakerContract && pos.staker_contract !== stInfo.stakerContract))) {
              pos.source = "staking";
              pos.staker_contract = stInfo.stakerContract ?? pos.staker_contract;
              pos.staking_id = stInfo.stakingId ?? pos.staking_id;
              db.prepare(
                `UPDATE positions SET source='staking', staker_contract=?, staking_id=? WHERE id=?`
              ).run(pos.staker_contract ?? null, pos.staking_id ?? null, pos.id);
              console.log(`[scanner-known] 自愈同步质押状态: #${pos.token_id} -> staking @ ${pos.staker_contract}`);
            }
          }
        } catch (e) {
          console.warn(`[scanner-known] ZiaVault 质押自愈检查失败:`, (e as Error).message);
        }
      }
    }
    
    // 解析代币信息
    const tokenMap = await resolveTokens(client, chainIdRef, positions.flatMap(p => [p.token0, p.token1]));
    
    // 预热已知仓位的 Pool 地址缓存，并对同链所有已知 Pool 一次性去重读取 slot0()
    for (const pos of positions) {
      const dex = dexes.find(d => d.id === pos.dex_id) ?? dexes[0];
      if (dex?.factory && pos.token0 && pos.token1 && pos.fee && pos.pool) {
        primePoolAddressCache(dex.factory, pos.token0, pos.token1, pos.fee, pos.pool);
      }
    }
    const poolTicks = await batchReadPoolTicks(
      client,
      positions.map(p => p.pool).filter(Boolean),
      8
    );

    // 加载本链 CEX 映射（按链隔离，防止跨链 __native__ 覆盖，且不误传 chain.key 给 skipCache）
    const chainMappings = loadAllMappings().get(chainIdRef) ?? [];
    const quotesByAddr = chainMappings.length > 0 ? await buildQuotesByAddr(chainMappings, false) : new Map<string, CexQuote>();
    
    // 8 路并发处理仓位（每个已知 Pool 仓位只需 1 次 positions(tokenId) 调用）
    await eachLimit(positions, 8, async (position) => {
      try {
        await processSinglePosition(position, chain, dexes, tokenMap, quotesByAddr, client, summary, cexMutedPairs, poolTicks);
      } catch (error) {
        console.error(`[scanner-known] 处理仓位失败:`, error);
        summary.errors.push(`处理仓位 ${position.id} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    
  } catch (error) {
    console.error(`[scanner-known] 处理链 ${chain.key} 失败:`, error);
    summary.errors.push(`处理链 ${chain.key} 失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 处理单个仓位
 */
async function processSinglePosition(
  position: any,
  chain: any,
  dexes: any[],
  tokenMap: Map<string, any>,
  quotesByAddr: Map<string, CexQuote>,
  client: PublicClient,
  summary: KnownPositionsSummary,
  cexMutedPairs: Set<string>,
  poolTicks: Map<string, number>
) {
  const db = getDb();
  const now = new Date().toISOString();
  const effectiveFlip = position.pair_flip === 1 || isPairFlipped(position.chain_id_ref, position.token0, position.token1) ? 1 : 0;

  // 1. 获取仓位当前状态（包含 CEX 价差、margin）
  const status = await getPositionStatus(position, chain, dexes, tokenMap, quotesByAddr, client, poolTicks);

  // 2. 检查仓位是否已关闭
  if (status.isClosed) {
    db.prepare(`
      UPDATE positions
      SET notify_state = 'closed',
          last_checked_at = ?,
          last_in_range = 0,
          last_liquidity = ''
      WHERE id = ?
    `).run(now, position.id);

    summary.closed++;
    const pairLabel = effectiveFlip
      ? `${position.token1_symbol}/${position.token0_symbol}`
      : `${position.token0_symbol}/${position.token1_symbol}`;
    console.log(`[scanner-known] 仓位已关闭: #${position.token_id} ${pairLabel} (${chain.name})`);

    // 关闭告警（统一去重）
    if (shouldPush(position.id, "closed", "closed")) {
      const dexName = dexes.find(d => d.id === position.dex_id)?.name ?? "";
      await sendAndRecord(position, chain, dexes, "closed", {
        title: `仓位已关闭 ${pairLabel} · ${chain.name}/${dexName}`,
        body: `仓位 #${position.token_id}（${pairLabel}）已关闭。\n钱包: ${position.wallet_address ?? ""}`,
      }, summary, 0, "closed");
    }
    return;
  }

  // 3. tick_move 检测（与全量扫描一致：对比上次 margin）
  const tickMoveEnabled = isTickMoveEnabled();
  const tickMoveThreshold = getTickMoveThreshold() / 100;
  let tickMoveTriggered = false;
  let tickMoveDelta = 0;
  let tickMoveDirection = "";
  if (tickMoveEnabled && typeof position.last_margin_lower === "number") {
    const dLower = Math.abs(status.marginLower - position.last_margin_lower);
    const dUpper = Math.abs(status.marginUpper - position.last_margin_upper);
    const delta = Math.max(dLower, dUpper);
    if (delta >= tickMoveThreshold) {
      tickMoveTriggered = true;
      tickMoveDelta = delta;
      tickMoveDirection = status.marginLower > position.last_margin_lower ? "靠近上界" : "靠近下界";
    }
  }

  // 4. 更新仓位状态（含 margin、CEX 数据、检查时间、pair_flip、pool 补全）
  const cexJson = status.cexPriceInfo ? JSON.stringify(status.cexPriceInfo.payload) : "";
  db.prepare(`
    UPDATE positions
    SET last_current_tick = ?,
        last_in_range = ?,
        last_checked_at = ?,
        last_price0 = ?,
        last_liquidity = ?,
        last_margin_lower = ?,
        last_margin_upper = ?,
        last_cex_price = ?,
        notify_state = ?,
        pair_flip = ?,
        pool = CASE WHEN pool IS NULL OR pool = '' THEN ? ELSE pool END
    WHERE id = ?
  `).run(
    status.currentTick,
    status.inRange ? 1 : 0,
    now,
    status.price0Human || status.price0,
    status.liquidity.toString(),
    status.marginLower,
    status.marginUpper,
    cexJson,
    status.inRange ? "in_range" : "out_of_range",
    effectiveFlip,
    status.pool || position.pool || "",
    position.id
  );

  summary.active++;

  // 5. 越界/恢复告警
  const prevState = position.notify_state ?? "unknown";
  const enteredOutOfRange = !status.inRange && (prevState === "in_range" || prevState === "unknown");
  const reEnteredRange = status.inRange && prevState === "out_of_range";
  const stillOutOfRangeAndExpired = !status.inRange && prevState === "out_of_range";

  if (enteredOutOfRange || reEnteredRange || stillOutOfRangeAndExpired) {
    const alertType = !status.inRange ? "out_of_range" : "re_in_range";
    if (shouldPush(position.id, alertType, alertType)) {
      const dp = makeDp(position);
      const w = makeWalletRow(position);
      const n = buildNotification(w, chain.name, dexes.find(d => d.id === position.dex_id)?.name ?? "", dp, makeReadResult(position, status), position.token0_symbol, position.token1_symbol, effectiveFlip, status.price0Human);
      await sendAndRecord(position, chain, dexes, alertType, n, summary, status.currentTick, alertType);
    }
  }

  // 6. tick_move 告警
  if (tickMoveTriggered) {
    if (shouldPush(position.id, "tick_move", "moved")) {
      const dp = makeDp(position);
      const w = makeWalletRow(position);
      const n = buildTickMoveNotification(w, chain.name, dexes.find(d => d.id === position.dex_id)?.name ?? "", dp, makeReadResult(position, status), position.token0_symbol, position.token1_symbol, position.last_margin_lower, status.marginLower, tickMoveDelta, tickMoveDirection, effectiveFlip, status.price0Human);
      await sendAndRecord(position, chain, dexes, "tick_move", n, summary, status.currentTick, "moved");
    }
  }

  // 7. CEX 价差告警（与全量扫描一致：动态阈值 fee*2 + 静音检查）
  const cexEnabled = isCexPriceEnabled();
  const muteKey = `${position.chain_id_ref}|${(position.token0 || "").toLowerCase()}|${(position.token1 || "").toLowerCase()}`;
  // 缓存静音状态：同一 token 对在本次扫描内不重复查 DB
  if (!cexMutedPairs.has(muteKey)) {
    const muted = db
      .prepare("SELECT id FROM cex_alert_mutes WHERE chain_id_ref=? AND token0=? AND token1=?")
      .get(position.chain_id_ref, (position.token0 || "").toLowerCase(), (position.token1 || "").toLowerCase());
    if (muted) cexMutedPairs.add(muteKey);
  }
  if (status.cexPriceInfo && status.cexPriceInfo.exceedsThreshold && cexEnabled && !cexMutedPairs.has(muteKey)) {
    if (shouldPush(position.id, "cex_price", "exceeds_threshold")) {
      const dp = makeDp(position);
      const w = makeWalletRow(position);
      const n = buildCexPriceNotification(w, chain.name, dexes.find(d => d.id === position.dex_id)?.name ?? "", dp, makeReadResult(position, status), position.token0_symbol, position.token1_symbol, status.cexPriceInfo.payload, effectiveFlip);
      await sendAndRecord(position, chain, dexes, "cex_price", n, summary, status.currentTick, "exceeds_threshold");
    }
  }
}

/** 构造全量扫描兼容的 WalletRow 对象 */
function makeWalletRow(position: any): WalletRow {
  return { id: position.wallet_id, chain_id_ref: position.chain_id_ref, address: position.wallet_address ?? "", label: position.wallet_label ?? "" };
}

/** 构造全量扫描兼容的 DiscoveredPosition 对象 */
function makeDp(position: any): any {
  return {
    tokenId: position.token_id,
    source: position.source,
    stakerContract: position.staker_contract ?? "",
  };
}

/** 构造全量扫描兼容的 r（readRange result）对象 */
function makeReadResult(position: any, status: any): any {
  return {
    token0: position.token0,
    token1: position.token1,
    fee: position.fee ?? 0,
    tickLower: status.tickLower,
    tickUpper: status.tickUpper,
    status: {
      currentTick: status.currentTick,
      price: status.price0,
    },
  };
}

/** 发送通知 + 写 alerts 表 + 记录推送去重（统一入口） */
async function sendAndRecord(position: any, _chain: any, _dexes: any[], alertType: string, n: { title: string; body: string }, summary: KnownPositionsSummary, currentTick: number, currentState: string) {
  summary.alertsSent++;
  let sentChannels: string[] = [];
  try {
    const sendRes = await notifyAll(n);
    sentChannels = sendRes.sent ?? [];
  } catch (error) {
    console.error(`[scanner-known] 发送通知失败:`, error);
  }
  // 写入 alerts 表（与全量扫描一致，记录真实成功推送的渠道列表）
  const db = getDb();
  db.prepare(
    `INSERT INTO alerts (position_id, type, tick_at, message, channels) VALUES (?, ?, ?, ?, ?)`
  ).run(position.id, alertType, currentTick, n.body, JSON.stringify(sentChannels));
  // 记录推送去重（用调用点传入的状态，确保与 shouldPush 一致）
  recordPush(position.id, alertType, currentState);
}

/**
 * 获取仓位当前状态（与全量扫描对齐：CEX 价差、margin、tick_move 都在此计算）
 */
async function getPositionStatus(
  position: any,
  chain: any,
  dexes: any[],
  tokenMap: Map<string, any>,
  quotesByAddr: Map<string, CexQuote>,
  client: PublicClient,
  poolTicks: Map<string, number>
) {
  // 按仓位实际的 dex_id 精确匹配 DEX
  const dex = dexes.find(d => d.id === position.dex_id) ?? dexes[0];
  if (!dex) throw new Error(`仓位 ${position.id} 无匹配 DEX`);
  const adapter = getAdapter(dex.type || 'v3-fork');
  if (!adapter) throw new Error(`无法获取适配器: ${dex.type}`);

  const knownPool = position.pool ? (position.pool as `0x${string}`) : undefined;
  const knownTick = knownPool ? poolTicks.get(knownPool.toLowerCase()) : undefined;

  const posData = await adapter.readRange(client, {
    factory: dex.factory || "",
    npm: dex.npm || "",
    stateview: dex.stateview || "",
    knownPool,
    knownTick,
  }, BigInt(position.token_id));

  // 获取 decimals
  const dec0 = tokenMap.get((position.token0 || "").toLowerCase())?.decimals ?? 18;
  const dec1 = tokenMap.get((position.token1 || "").toLowerCase())?.decimals ?? 18;
  const sym0 = position.token0_symbol || "";
  const sym1 = position.token1_symbol || "";

  if (posData.kind === 'closed') {
    return {
      currentTick: 0,
      inRange: false,
      liquidity: BigInt(0),
      price0: '0',
      price0Human: '',
      isClosed: true,
      tickLower: position.tick_lower,
      tickUpper: position.tick_upper,
      marginLower: 0,
      marginUpper: 0,
      cexPriceInfo: null,
      pool: knownPool || "",
    };
  }

  if (posData.kind === 'unreadable') {
    throw new Error('无法读取仓位状态（NFT 可能已 burn 或 RPC 异常）');
  }

  // === 与全量扫描完全一致的 CEX 价差计算 ===
  const price0Human = rawToHumanPrice(posData.status.price, dec0, dec1);
  const cexPriceInfo = computeCexPriceDiff(
    (position.token0 || "").toLowerCase(),
    (position.token1 || "").toLowerCase(),
    posData.status.price,
    quotesByAddr,
    position.fee ?? 0,
    sym0, sym1, dec0, dec1
  );

  return {
    currentTick: posData.status.currentTick,
    inRange: posData.status.inRange,
    liquidity: posData.liquidity,
    price0: posData.status.price.toString(),
    price0Human,
    isClosed: posData.liquidity === BigInt(0) || !posData.liquidity,
    tickLower: posData.status.tickLower,
    tickUpper: posData.status.tickUpper,
    marginLower: posData.status.marginLower,
    marginUpper: posData.status.marginUpper,
    cexPriceInfo,  // 完整的 CEX 价差对比结果（与全量扫描一致）
    pool: posData.status.pool || knownPool || "",
  };
}

