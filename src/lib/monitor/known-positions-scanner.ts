/**
 * 已知仓位快速扫描器
 * 专门用于快速更新已知仓位的状态，检测已关闭仓位，并处理告警
 * 性能目标：100个仓位 < 10秒
 */
import { getDb } from "../db";
import { listChains, getClient } from "../chains";
import type { PublicClient } from "viem";
import { resolveTokens } from "../chains/tokens";
import { listDexes } from "../chains/dexes";
import { getAdapter } from "../adapters";
import { isCexPriceEnabled } from "../db/settings";
import { notifyAll } from "../notify";
import { shouldPush, recordPush } from "../notify/dedup";
import { loadAllMappings, buildQuotesByAddr } from "../cex/binance";

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

interface Alert {
  type: string;
  message: string;
  severity: string;
  pushAllowed: boolean;
}

/**
 * 快速扫描已知仓位
 */
export async function scanKnownPositions(): Promise<KnownPositionsSummary> {
  const startTime = Date.now();
  const db = getDb();
  
  console.log(`[scanner-known] 开始已知仓位扫描`);
  
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
      await processChainPositions(chain, chainPositions, chainRef, summary);
    }
    
    // 4. 统计结果
    summary.durationMs = Date.now() - startTime;
    console.log(`[scanner-known] 已知仓位扫描完成: ${summary.active}个活跃, ${summary.closed}个已关闭, ${summary.alertsSent}个告警, ${summary.pushSkipped}个跳过, ${summary.durationMs}ms`);
    
  } catch (error) {
    console.error(`[scanner-known] 扫描失败:`, error);
    summary.errors.push(error instanceof Error ? error.message : String(error));
  }
  
  return summary;
}

/**
 * 处理单个链的仓位
 */
async function processChainPositions(chain: any, positions: any[], chainIdRef: number, summary: KnownPositionsSummary) {
  const db = getDb();
  
  try {
    // 获取链的客户端
    const chainClient = getClient(chainIdRef);
    if (!chainClient) {
      console.error(`[scanner-known] 无法获取链 ${chain.key} 的客户端`);
      return;
    }
    const client = chainClient.client;
    
    // 获取DEX信息
    const dexes = listDexes().filter(d => d.chain_id_ref === chain.id);
    if (dexes.length === 0) {
      console.error(`[scanner-known] 链 ${chain.key} 没有配置DEX`);
      return;
    }
    
    // 解析代币信息
    const tokenMap = await resolveTokens(client, chainIdRef, positions.flatMap(p => [p.token0, p.token1]));
    
    // 加载CEX映射
    const cexMappings = Array.from((await loadAllMappings()).values()).flat();
    const quotesByAddr = await buildQuotesByAddr(cexMappings, chain.key);
    
    // 批量处理仓位
    for (const position of positions) {
      try {
        await processSinglePosition(position, chain, dexes, tokenMap, quotesByAddr, client, summary);
      } catch (error) {
        console.error(`[scanner-known] 处理仓位失败:`, error);
        summary.errors.push(`处理仓位 ${position.id} 失败: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    
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
  quotesByAddr: Map<string, any>,
  client: PublicClient,
  summary: KnownPositionsSummary
) {
  const db = getDb();
  const now = new Date().toISOString();
  
  // 1. 获取仓位当前状态
  const positionStatus = await getPositionStatus(position, chain, dexes, tokenMap, quotesByAddr, client);
  
  // 2. 检查仓位是否已关闭
  if (positionStatus.isClosed) {
    // 标记为已关闭
    db.prepare(`
      UPDATE positions 
      SET notify_state = 'closed', 
          last_checked_at = ?,
          last_in_range = 0,
          last_liquidity = ''
      WHERE id = ?
    `).run(now, position.id);
    
    summary.closed++;
    console.log(`[scanner-known] 仓位已关闭: ${position.id} (${position.token0_symbol}/${position.token1_symbol})`);
    
    // 3. 处理关闭告警
    await processAlerts(position, {
      type: 'closed',
      message: `仓位已关闭 (${position.token0_symbol}/${position.token1_symbol})`,
      severity: 'info',
      pushAllowed: true
    }, summary);
    
    return;
  }
  
  // 4. 更新仓位状态
  db.prepare(`
    UPDATE positions 
    SET last_current_tick = ?,
        last_in_range = ?,
        last_checked_at = ?,
        last_price0 = ?,
        last_liquidity = ?,
        last_cex_price = ?
    WHERE id = ?
  `).run(
    positionStatus.currentTick,
    positionStatus.inRange ? 1 : 0,
    now,
    positionStatus.price0,
    positionStatus.liquidity,
    JSON.stringify(positionStatus.cexPrice),
    position.id
  );
  
  summary.active++;
  
  // 5. 检查告警条件
  const alerts = checkAlertConditions(position, positionStatus, dexes);
  
  // 6. 处理告警（统一推送去重）
  for (const alert of alerts) {
    await processAlerts(position, alert, summary, positionStatus.currentTick);
  }
}

/**
 * 获取仓位当前状态
 */
async function getPositionStatus(
  position: any,
  chain: any,
  dexes: any[],
  tokenMap: Map<string, any>,
  quotesByAddr: Map<string, any>,
  client: PublicClient
) {
  // 按仓位实际的 dex_id 精确匹配 DEX（不能用 dexes[0]，否则会用错 DEX 的 factory）
  const dex = dexes.find(d => d.id === position.dex_id) ?? dexes[0];
  if (!dex) {
    throw new Error(`仓位 ${position.id} 无匹配 DEX`);
  }
  const adapter = getAdapter(dex.type || 'v3-fork');
  if (!adapter) {
    throw new Error(`无法获取适配器: ${dex.type}`);
  }

  // 获取仓位的当前tick和流动性（factory 必须是合约地址，不是 DEX 名字）
  const posData = await adapter.readRange(client, {
    factory: dex.factory || "",
    npm: dex.npm || ""
  }, BigInt(position.token_id));
  
  // 获取CEX价格
  const cexPrice: Record<string, any> = {};
  if (isCexPriceEnabled()) {
    for (const tokenAddr of [position.token0, position.token1]) {
      const quote = quotesByAddr.get(tokenAddr.toLowerCase());
      if (quote) {
        cexPrice[tokenAddr] = quote;
      }
    }
  }
  
  if (posData.kind === 'closed') {
    return {
      currentTick: 0,
      inRange: false,
      liquidity: BigInt(0),
      price0: '0',
      isClosed: true,
      cexPrice: {}
    };
  }
  
  if (posData.kind === 'unreadable') {
    throw new Error('无法读取仓位状态');
  }
  
  return {
    currentTick: posData.status.currentTick,
    inRange: posData.status.inRange,
    liquidity: posData.liquidity,
    price0: posData.status.price.toString(),
    isClosed: posData.liquidity === BigInt(0) || !posData.liquidity,
    cexPrice
  };
}

/**
 * 检查告警条件
 */
function checkAlertConditions(position: any, status: any, dexes: any[]): Alert[] {
  const alerts: Alert[] = [];
  
  // 1. 越界告警
  if (!status.inRange && position.last_in_range === 1) {
    alerts.push({
      type: 'out_of_range',
      message: `仓位越界: ${position.token0_symbol}/${position.token1_symbol} (${status.currentTick} / [${position.tick_lower}, ${position.tick_upper}])`,
      severity: 'warning',
      pushAllowed: true
    });
  }
  
  // 2. 恢复区间告警
  if (status.inRange && position.last_in_range === 0) {
    alerts.push({
      type: 're_in_range',
      message: `仓位恢复区间: ${position.token0_symbol}/${position.token1_symbol}`,
      severity: 'info',
      pushAllowed: true
    });
  }
  
  // 3. CEX差价告警
  if (isCexPriceEnabled() && status.cexPrice && status.cexPrice[position.token0.toLowerCase()]) {
    // 计算DEX价格
    const dexPrice = parseFloat(status.price0);
    const cexPrice = parseFloat(status.cexPrice[position.token0.toLowerCase()].price);
    const priceDiff = Math.abs((dexPrice - cexPrice) / cexPrice * 100);

    // 阈值：用该仓位所属 DEX 的 fee*2（与全量扫描一致），无 fee 信息时回退 1%
    const posDex = dexes.find(d => d.id === position.dex_id);
    const feePct = posDex?.fee ? posDex.fee / 10000 : 0.01;
    if (priceDiff > feePct * 100) {
      alerts.push({
        type: 'cex_price',
        message: `CEX差价告警: ${position.token0_symbol}/${position.token1_symbol} DEX价格: $${dexPrice.toFixed(4)}, CEX价格: $${cexPrice.toFixed(4)}, 差价: ${priceDiff.toFixed(2)}%`,
        severity: 'warning',
        pushAllowed: true
      });
    }
  }
    
  // 4. Tick波动告警（复用全量扫描的阈值配置；已知扫描不追踪 margin 历史，故仅触发不计算 delta）
  // tick_move 的具体波动检测由全量扫描负责（它记录 last_margin_lower），已知扫描不重复实现
  
  return alerts;
}

/**
 * 处理告警（统一推送去重：与全量扫描共享 push_states）
 */
async function processAlerts(position: any, alert: Alert, summary: KnownPositionsSummary, currentTick: number = 0) {
  // 统一去重：按告警类型独立冷却，两个扫描器共享 push_states
  if (!shouldPush(position.id, alert.type)) {
    summary.pushSkipped++;
    console.log(`[scanner-known] 跳过推送: ${alert.type} (仓位 ${position.id})`);
    return;
  }

  summary.alertsSent++;
  console.log(`[scanner-known] 发送告警: ${alert.type} (仓位 ${position.id})`);

  // 发送通知
  try {
    await notifyAll({
      title: `仓位告警: ${alert.type}`,
      body: alert.message,
      url: `https://etherscan.io/nft/${position.nft_id}`
    });
  } catch (error) {
    console.error(`[scanner-known] 发送通知失败:`, error);
  }

  // 记录到 alerts 表（与全量扫描一致，告警历史可见）
  const db = getDb();
  db.prepare(
    `INSERT INTO alerts (position_id, type, tick_at, message, channels)
     VALUES (?, ?, ?, ?, ?)`
  ).run(position.id, alert.type, currentTick, alert.message, "[]");

  // 记录推送时间（统一去重）
  recordPush(position.id, alert.type);
}
