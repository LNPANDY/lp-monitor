/**
 * 扫描编排：
 *  1. 加载启用的钱包
 *  2. 对每个钱包：发现仓位（直接持有 + 质押溯源）
 *  3. 读取每个仓位的区间状态
 *  4. 与上次状态对比 → 状态翻转才告警；同状态用 cooldown 去重
 *  5. 写回 positions / alerts
 */
import { getDb } from "../db";
import { getClient, listChains } from "../chains";
import type { PublicClient } from "viem";
import { resolveTokens } from "../chains/tokens";
import { listDexes, listStaking, type DexRow, type StakingRow } from "../chains/dexes";
import { getAdapter } from "../adapters";
import {
  getTickMoveThreshold,
  isTickMoveEnabled,
  isCexPriceEnabled,
} from "../db/settings";
import {
  findDirectPositions,
  findStakedPositions,
  findRecentPositionsByTransfer,
  type DiscoveredPosition,
} from "../staking/discover";
import { ownerOf } from "../adapters/v3-fork";
import { notifyAll } from "../notify";
import { shouldPush, recordPush } from "../notify/dedup";
import {
  loadAllMappings,
  buildQuotesByAddr,
  type CexMapping,
  type CexQuote,
} from "../cex/binance";
import { estimateBlockTimeSec, secondsToBlocks } from "../chains/blocktime";
import {
  getFullScanFirstHours,
  getFullScanPaddingSec,
} from "../db/settings";

export interface ScanSummary {
  wallets: number;
  positions: number;      // 活跃仓位数（r.kind===ok）
  discovered: number;      // 本次处理的所有仓位数（含 closed/unreadable，对应 DB upsert 数）
  /**
   * 以下三字段仅 fast scan 提供（深度扫描不细分新增/恢复/关闭）。
   * 设为可选，以便深度扫描的 ScanSummary 可省略。
   * 未来若 fast scan 与 known 快扫合并，由合并体统一填入即可。
   */
  new?: number;            // 本次 DB 新增仓位数（INSERT 新行）
  reopened?: number;        // 本次从 closed 状态恢复为活跃的仓位数
  closed?: number;          // 本次被标 notify_state='closed' 的仓位数
  outOfRange: number;
  alertsSent: number;
  errors: string[];
  startedAt: string;
  durationMs: number;
  at?: string;
  error?: string;
}

export interface WalletRow {
  id: number;
  chain_id_ref: number;
  address: string;
  label: string;
}

export async function runScan(): Promise<ScanSummary> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let positions = 0;
  let discoveredCount = 0;
  let outOfRange = 0;
  let alertsSent = 0;
  const db = getDb();

  // CEX 对比全局开关：控制是否推送 CEX 价差告警（不影响 CEX 数据计算与卡片展示）。
  const cexEnabled = isCexPriceEnabled();
  // 所有链上的 token→CEX 映射（按 chain_id_ref 分组）。始终加载，确保仓位卡片始终显示 CEX 数据。
  const cexMappingsByChain = loadAllMappings();
  // 报价缓存（本次扫描内复用）：(tokenAddrLower) → CexQuote
  const cexQuoteByAddr = new Map<string, CexQuote>();
  // 本次扫描中已静音的 CEX 差价预警 token 对集合：(chain_id_ref|token0|token1) → true
  const cexMutedPairs = new Set<string>();

  const wallets = db.prepare("SELECT * FROM wallets WHERE enabled=1").all() as WalletRow[];
  if (wallets.length === 0) {
    return { wallets: 0, positions: 0, discovered: 0, outOfRange: 0, alertsSent: 0, errors, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt };
  }

  for (const w of wallets) {
    try {
      const tWallet0 = Date.now();
      const { client, chain } = getClient(w.chain_id_ref);
      const dexes = listDexes(w.chain_id_ref, true);
      const staking = listStaking(w.chain_id_ref, true);

      // 发现仓位：直接持有 + 质押溯源（深度模式：默认 100,000 块窗口）
      const direct = await findDirectPositions(client, w.address as `0x${string}`, dexes);
      const staked = await findStakedPositions(
        client,
        w.address as `0x${string}`,
        dexes,
        staking
      );

      const discovered = dedupeDiscovered([...direct, ...staked]);

      // 兜底恢复：库里有但本次未发现的仓位（尤其质押仓位：转账发生在扫描窗口外）。
      const recovered = await recoverMissedPositions(client, w, dexes, staking, discovered);

      console.log(`[scanner-deep] wallet ${w.address} chain ${chain.name}: discover=${direct.length}d+${staked.length}s recover=${recovered.length} ${(Date.now()-tWallet0)}ms`);

      // ===== 预取本链 CEX 报价（开启 CEX 对比时）=====
      const chainMappings = cexMappingsByChain.get(w.chain_id_ref) ?? [];
      if (cexEnabled && chainMappings.length > 0) {
        const needFetch = chainMappings.filter((m) => !cexQuoteByAddr.has(m.tokenAddr));
        if (needFetch.length > 0) {
          const byAddr = await buildQuotesByAddr(needFetch);
          for (const [addr, quote] of byAddr) cexQuoteByAddr.set(addr, quote);
        }
      }

      const ctx: ScanCtx = {
        db, client, chain, w, dexes,
        cexEnabled, cexQuoteByAddr, cexMutedPairs,
        positions, discovered: discoveredCount, outOfRange, alertsSent, errors,
      };

      for (const dp of [...discovered, ...recovered]) {
        const r = await processPosition(ctx, dp);
        positions = r.positions; discoveredCount = r.discovered; outOfRange = r.outOfRange; alertsSent = r.alertsSent;
      }
    } catch (e: any) {
      errors.push(`wallet ${w.address}: ${e?.message ?? e}`);
    }
  }

  return {
    wallets: wallets.length,
    positions,
    discovered: discoveredCount,
    outOfRange,
    alertsSent,
    errors,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/**
 * 快速全量扫描：默认 cron 调用的扫描模式。
 *
 * 与深度模式（runScan）的差异：
 *  1. transfer 扫描窗口由调度器传入（首次回溯 N 小时，之后距上次扫描 + 冗余）
 *  2. 兜底 ownerOf 反查走节流版（同一仓位 5 分钟内已反查过的跳过）+ 并发（限并 10）
 *  3. 其余（readRange、写库、告警、CEX 计算）与深度模式完全一致
 *
 * @param opts.fromBlockByChain 各链的 transfer 扫描起始区块（由调度器维护状态）
 * @param opts.recoverCheckRecord 各仓位上次 ownerOf 反查的时间戳记录（由调度器维护状态）
 */
export async function runFastScan(opts: {
  fromBlockByChain?: Record<number, bigint>;
}): Promise<ScanSummary> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let positions = 0;
  let discoveredCount = 0;
  let newCount = 0;
  let reopenedCount = 0;
  let closedCount = 0;
  let outOfRange = 0;
  let alertsSent = 0;
  const db = getDb();

  const cexEnabled = isCexPriceEnabled();
  const cexMappingsByChain = loadAllMappings();
  const cexQuoteByAddr = new Map<string, CexQuote>();
  const cexMutedPairs = new Set<string>();

  const wallets = db.prepare("SELECT * FROM wallets WHERE enabled=1").all() as WalletRow[];
  if (wallets.length === 0) {
    return { wallets: 0, positions: 0, discovered: 0, new: 0, reopened: 0, closed: 0, outOfRange: 0, alertsSent: 0, errors, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt };
  }

  for (const w of wallets) {
    try {
      const tWallet0 = Date.now();
      const { client, chain } = getClient(w.chain_id_ref);
      const dexes = listDexes(w.chain_id_ref, true);
      const staking = listStaking(w.chain_id_ref, true);

      // ===== transfer 扫描：只发现窗口内变化的仓位 =====
      const fromBlock = opts.fromBlockByChain?.[w.chain_id_ref] ?? 0n;
      const latest = await client.getBlockNumber();
      console.log(`[scanner-fast] start: chain=${chain.name} (id=${w.chain_id_ref}), fromBlock=${fromBlock}, latest=${latest}`);

      const tScan0 = Date.now();
      const cands = await findRecentPositionsByTransfer(
        client, w.address as `0x${string}`, dexes, staking, fromBlock
      );
      const scanMs = Date.now() - tScan0;
      const stakingCnt = cands.candidates.filter(c => c.source === "staking").length;
      const directCnt = cands.candidates.length - stakingCnt;
      console.log(`[scanner-fast] wallet ${w.address} chain ${chain.name}: candidates=${cands.candidates.length} (direct=${directCnt}, staking=${stakingCnt}), outgoing=${cands.outgoing.length} (${scanMs}ms)`);

      // ===== outgoing: from=钱包 转出，DB 中已存在 → ownerOf 反查确认是否标 closed =====
      const tClosed0 = Date.now();
      const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
      const walletLower = w.address.toLowerCase();
      const nowIso = new Date().toISOString();
      let outgoingClosed = 0;
      for (const out of cands.outgoing) {
        const dex = dexes.find((d) => d.id === out.dexId);
        if (!dex) continue;
        // 查 DB 中是否存在该仓位
        const existing = db
          .prepare("SELECT id, notify_state FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
          .get(w.chain_id_ref, dex.name, out.tokenId) as { id: number; notify_state: string } | undefined;
        if (!existing) continue; // DB 没记录的转出场景无所谓
        if (existing.notify_state === "closed") continue;
        // ownerOf 反查确认 owner 是否还是本钱包或已知质押合约
        let currentOwner: string | null = null;
        try {
          currentOwner = await ownerOf(client, dex.npm as `0x${string}`, BigInt(out.tokenId));
        } catch {
          continue;
        }
        if (!currentOwner) continue;
        const ownerLower = currentOwner.toLowerCase();
        if (ownerLower === walletLower) continue; // 还在钱包里
        if (stakingByAddr.has(ownerLower)) continue; // 还在质押合约里
        // owner 改为非本钱包非质押合约 → 真的转移，标 closed
        db.prepare(
          `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0
           WHERE id=?`
        ).run(nowIso, existing.id);
        closedCount++;
        outgoingClosed++;
      }

      // ===== 处理候选：DB 不存在的 INSERT；DB 已存在但 source 变了（旧 direct → 新 staking）UPDATE =====
      const tProc0 = Date.now();
      let processedNew = 0;
      let sourceChanged = 0;

      // 预取本链 CEX 报价（processPosition 会用到）
      const chainMappings = cexMappingsByChain.get(w.chain_id_ref) ?? [];
      if (cexEnabled && chainMappings.length > 0) {
        const needFetch = chainMappings.filter((m) => !cexQuoteByAddr.has(m.tokenAddr));
        if (needFetch.length > 0) {
          const byAddr = await buildQuotesByAddr(needFetch);
          for (const [addr, quote] of byAddr) cexQuoteByAddr.set(addr, quote);
        }
      }

      const ctx: ScanCtx = {
        db, client, chain, w, dexes,
        cexEnabled, cexQuoteByAddr, cexMutedPairs,
        positions, discovered: discoveredCount, outOfRange, alertsSent, errors,
      };

      for (const dp of cands.candidates) {
        const dex = dexes.find((d) => d.id === dp.dexId);
        if (!dex) continue;
        // 判断 DB 是否已存在
        const existing = db
          .prepare("SELECT id, notify_state, source FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
          .get(w.chain_id_ref, dex.name, dp.tokenId) as { id: number; notify_state: string; source: string } | undefined;
        if (existing) {
          // DB 已有：检查 source 是否发生了 direct ↔ staking 变化（后到事件覆盖）
          if (existing.source !== dp.source) {
            db.prepare(
              `UPDATE positions SET source=?, staker_contract=?, staking_id=?, last_checked_at=? WHERE id=?`
            ).run(dp.source, dp.stakerContract ?? "", dp.stakingId ?? null, nowIso, existing.id);
            sourceChanged++;
          }
          continue;
        }
        // DB 不存在 → 真新仓位，processPosition 处理（内部 INSERT）
        const r = await processPosition(ctx, dp);
        positions = r.positions; discoveredCount = r.discovered; outOfRange = r.outOfRange; alertsSent = r.alertsSent;
        newCount++;
        processedNew++;
      }
      const procMs = Date.now() - tProc0;
      const totalMs = Date.now() - tWallet0;
      console.log(`[scanner-fast] result: chain=${chain.name} wallets=1 new=${processedNew} source_changed=${sourceChanged} closed=${outgoingClosed} processing=${procMs}ms total=${totalMs}ms`);
    } catch (e: any) {
      errors.push(`wallet ${w.address}: ${e?.message ?? e}`);
    }
  }

  return {
    wallets: wallets.length,
    positions,
    discovered: discoveredCount,
    new: newCount,
    reopened: reopenedCount,
    closed: closedCount,
    outOfRange,
    alertsSent,
    errors,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
}

/** 扫描上下文：processPosition 所需的运行时共享状态。 */
interface ScanCtx {
  db: ReturnType<typeof getDb>;
  client: PublicClient;
  chain: { name: string; [k: string]: any };
  w: WalletRow;
  dexes: DexRow[];
  cexEnabled: boolean;
  cexQuoteByAddr: Map<string, CexQuote>;
  cexMutedPairs: Set<string>;
  positions: number;   // 活跃仓位（r.kind===ok）
  discovered: number;   // 本次处理的所有仓位（含 closed/unreadable，对应 DB upsert 数）
  outOfRange: number;
  alertsSent: number;
  errors: string[];
}

/**
 * 处理单个仓位：readRange → 写库 → 越界/波动/CEX 告警。
 * runScan 与 runFastScan 共用，确保两种模式行为等价。
 */
async function processPosition(ctx: ScanCtx, dp: DiscoveredPosition): Promise<ScanCtx> {
  const { db, client, chain, w, dexes, cexEnabled, cexQuoteByAddr, cexMutedPairs } = ctx;
  let { positions, discovered, outOfRange, alertsSent, errors } = ctx;

  try {
    const dex = dexes.find((d) => d.id === dp.dexId);
    if (!dex) return ctx;
    const adapter = getAdapter(dex.type);
    const r = await adapter.readRange(client, { factory: dex.factory, npm: dex.npm }, BigInt(dp.tokenId));

    const nowIso = new Date().toISOString();
    discovered++;  // 所有成功读到 readRange 的都计入 discovered（含 closed/unreadable）

    // ===== 三态处理 =====
    if (r.kind === "unreadable") {
      db.prepare(
        `UPDATE positions SET last_checked_at=? WHERE chain_id_ref=? AND dex_name=? AND token_id=?`
      ).run(nowIso, w.chain_id_ref, dex.name, dp.tokenId);
      return { ...ctx, positions, discovered, outOfRange, alertsSent, errors };
    }
    if (r.kind === "closed") {
      db.prepare(
        `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0
         WHERE chain_id_ref=? AND dex_name=? AND token_id=?`
      ).run(nowIso, w.chain_id_ref, dex.name, dp.tokenId);
      return { ...ctx, positions, discovered, outOfRange, alertsSent, errors };
    }

    // r.kind === "ok"，正常处理
    positions++;

    // 解析 token0/token1 的 symbol（带缓存），用于展示和告警文案
    const tokenMap = await resolveTokens(client, w.chain_id_ref, [r.token0, r.token1]);
    const sym0 = tokenMap.get(r.token0.toLowerCase())?.symbol ?? "";
    const sym1 = tokenMap.get(r.token1.toLowerCase())?.symbol ?? "";

    const inRange = r.status.inRange;
    if (!inRange) outOfRange++;

    // 计算 tick 在区间内的相对位置（0~1，0=下界，1=上界），用于波动预警
    const span = Math.max(r.tickUpper - r.tickLower, 1);
    const currMarginLower = (r.status.currentTick - r.tickLower) / span;
    const currMarginUpper = (r.tickUpper - r.status.currentTick) / span;

    const prev = db
      .prepare("SELECT * FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
      .get(w.chain_id_ref, dex.name, dp.tokenId) as any;

    const prevState = prev?.notify_state ?? "unknown";

    // ===== 波动预警判定（每次扫描都对比上次，超过阈值就告警，不设冷却）=====
    const tickMoveEnabled = isTickMoveEnabled();
    const tickMoveThreshold = getTickMoveThreshold() / 100; // 百分比 → 0~1
    let tickMoveTriggered = false;
    let tickMoveDelta = 0;
    let tickMoveDirection = "";
    if (tickMoveEnabled && prev && typeof prev.last_margin_lower === "number") {
      const dLower = Math.abs(currMarginLower - prev.last_margin_lower);
      const dUpper = Math.abs(currMarginUpper - prev.last_margin_upper);
      const delta = Math.max(dLower, dUpper);
      if (delta >= tickMoveThreshold) {
        tickMoveTriggered = true;
        tickMoveDelta = delta;
        tickMoveDirection = currMarginLower > prev.last_margin_lower ? "靠近上界" : "靠近下界";
      }
    }

    // ===== CEX 价差判定 =====
    const dec0 = tokenMap.get(r.token0.toLowerCase())?.decimals ?? 18;
    const dec1 = tokenMap.get(r.token1.toLowerCase())?.decimals ?? 18;
    const price0Human = rawToHumanPrice(r.status.price, dec0, dec1);
    const cexPriceInfo = computeCexPriceDiff(
      r.token0.toLowerCase(), r.token1.toLowerCase(),
      r.status.price, cexQuoteByAddr,
      r.fee, sym0, sym1, dec0, dec1
    );

    // upsert 仓位最新状态（pair_flip 从 prev 保留；prev 为 null 时从 pair_flips 表恢复历史翻转）
    let prevPairFlip = prev?.pair_flip ?? 0;
    if (prevPairFlip === 0) {
      const savedFlip = db.prepare(
        "SELECT id FROM pair_flips WHERE chain_id_ref=? AND dex_name=? AND token0=? AND token1=?"
      ).get(w.chain_id_ref, dex.name, r.token0.toLowerCase(), r.token1.toLowerCase());
      if (savedFlip) prevPairFlip = 1;
    }
    db.prepare(
      `INSERT INTO positions
        (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, token0_symbol, token1_symbol, fee, pool,
         tick_lower, tick_upper, source, staker_contract, staking_id,
         last_current_tick, last_in_range, last_price0, last_liquidity,
         last_margin_lower, last_margin_upper, last_cex_price,
         last_checked_at, notify_state, last_notified_at, pair_flip)
       VALUES (@wallet_id,@chain_id_ref,@dex_id,@dex_name,@token_id,@token0,@token1,@token0_symbol,@token1_symbol,@fee,@pool,
               @tick_lower,@tick_upper,@source,@staker_contract,@staking_id,
               @last_current_tick,@last_in_range,@last_price0,@last_liquidity,
               @last_margin_lower,@last_margin_upper,@last_cex_price,
               @last_checked_at,@notify_state,@last_notified_at,@pair_flip)
       ON CONFLICT(chain_id_ref, dex_name, token_id) DO UPDATE SET
         last_current_tick=excluded.last_current_tick,
         last_in_range=excluded.last_in_range,
         last_price0=excluded.last_price0,
         last_liquidity=excluded.last_liquidity,
         last_margin_lower=excluded.last_margin_lower,
         last_margin_upper=excluded.last_margin_upper,
         last_cex_price=excluded.last_cex_price,
         last_checked_at=excluded.last_checked_at,
         notify_state=excluded.notify_state,
         token0=excluded.token0, token1=excluded.token1,
         token0_symbol=excluded.token0_symbol, token1_symbol=excluded.token1_symbol,
         fee=excluded.fee, pool=excluded.pool,
         tick_lower=excluded.tick_lower, tick_upper=excluded.tick_upper,
         dex_id=excluded.dex_id, source=excluded.source, staker_contract=excluded.staker_contract,
         staking_id=excluded.staking_id,
         pair_flip=excluded.pair_flip`
    ).run({
      wallet_id: w.id,
      chain_id_ref: w.chain_id_ref,
      dex_id: dex.id,
      dex_name: dex.name,
      token_id: dp.tokenId,
      token0: r.token0,
      token1: r.token1,
      token0_symbol: sym0,
      token1_symbol: sym1,
      fee: r.fee,
      pool: r.status.pool,
      tick_lower: r.tickLower,
      tick_upper: r.tickUpper,
      source: dp.source,
      staker_contract: dp.stakerContract ?? "",
      staking_id: dp.stakingId ?? null,
      last_current_tick: r.status.currentTick,
      last_in_range: inRange ? 1 : 0,
      last_price0: price0Human,
      last_liquidity: r.liquidity?.toString() ?? "",
      last_margin_lower: currMarginLower,
      last_margin_upper: currMarginUpper,
      last_cex_price: cexPriceInfo ? JSON.stringify(cexPriceInfo.payload) : "",
      last_checked_at: nowIso,
      notify_state: inRange ? "in_range" : "out_of_range",
      last_notified_at: prev?.last_notified_at ?? "",
      pair_flip: prevPairFlip,
    });

    const positionRow = db
      .prepare("SELECT id, last_notified_at, pair_flip FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
      .get(w.chain_id_ref, dex.name, dp.tokenId) as { id: number; last_notified_at: string; pair_flip?: number };

    // ===== 越界告警触发判定 =====
    const enteredOutOfRange =
      !inRange && (prevState === "in_range" || prevState === "unknown");
    const reEnteredRange =
      inRange && prevState === "out_of_range";
    const stillOutOfRangeAndExpired =
      !inRange && prevState === "out_of_range" && shouldPush(positionRow.id, "out_of_range", "out_of_range");

    const rangeTrigger = enteredOutOfRange || reEnteredRange || stillOutOfRangeAndExpired;

    // ===== 发送告警（越界 + 波动各自独立发送）=====
    if (rangeTrigger) {
      const alertType = !inRange ? "out_of_range" : "re_in_range";
      if (shouldPush(positionRow.id, alertType, alertType)) {
        const n = buildNotification(w, chain.name, dex.name, dp, r, sym0, sym1, positionRow.pair_flip, price0Human);
        const sendRes = await notifyAll(n);
        alertsSent++;

        db.prepare(
          `INSERT INTO alerts (position_id, type, tick_at, message, channels)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          positionRow.id, alertType, r.status.currentTick, n.body, JSON.stringify(sendRes.sent)
        );
        recordPush(positionRow.id, alertType, alertType);
      }
    }

    // 波动告警（独立于越界告警，受 tick_move 冷却控制）
    if (tickMoveTriggered) {
      if (shouldPush(positionRow.id, "tick_move", "moved")) {
        const n = buildTickMoveNotification(
          w, chain.name, dex.name, dp, r, sym0, sym1,
          prev.last_margin_lower, currMarginLower,
          tickMoveDelta, tickMoveDirection, positionRow.pair_flip, price0Human
        );
        const sendRes = await notifyAll(n);
        alertsSent++;

        db.prepare(
          `INSERT INTO alerts (position_id, type, tick_at, message, channels)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          positionRow.id, "tick_move", r.status.currentTick, n.body, JSON.stringify(sendRes.sent)
        );
        recordPush(positionRow.id, "tick_move", "moved");
      }
    }

    // CEX 价差告警（独立发送，每次超过阈值都发，不设冷却）
    const muteKey = `${w.chain_id_ref}|${r.token0.toLowerCase()}|${r.token1.toLowerCase()}`;
    if (!cexMutedPairs.has(muteKey)) {
      const muted = db
        .prepare("SELECT id FROM cex_alert_mutes WHERE chain_id_ref=? AND token0=? AND token1=?")
        .get(w.chain_id_ref, r.token0.toLowerCase(), r.token1.toLowerCase());
      if (muted) cexMutedPairs.add(muteKey);
    }
    if (cexPriceInfo && cexPriceInfo.exceedsThreshold && cexEnabled && !cexMutedPairs.has(muteKey)) {
      if (shouldPush(positionRow.id, "cex_price", "exceeds_threshold")) {
        const n = buildCexPriceNotification(
          w, chain.name, dex.name, dp, r, sym0, sym1,
          cexPriceInfo.payload, positionRow.pair_flip
        );
        const sendRes = await notifyAll(n);
        alertsSent++;

        db.prepare(
          `INSERT INTO alerts (position_id, type, tick_at, message, channels)
           VALUES (?, ?, ?, ?, ?)`
        ).run(
          positionRow.id, "cex_price", r.status.currentTick, n.body, JSON.stringify(sendRes.sent)
        );
        recordPush(positionRow.id, "cex_price", "exceeds_threshold");
      }
    }
  } catch (e: any) {
    errors.push(`position ${dp.tokenId} on chain ${w.chain_id_ref}: ${e?.message ?? e}`);
  }

  return { ...ctx, positions, outOfRange, alertsSent, errors };
}

function dedupeDiscovered(list: DiscoveredPosition[]): DiscoveredPosition[] {
  const map = new Map<string, DiscoveredPosition>();
  for (const d of list) {
    // 同 tokenId 同时直接持有 + 质押（理论上不会）时，优先直接持有
    const key = `${d.dexId}:${d.tokenId}`;
    if (!map.has(key) || d.source === "direct") map.set(key, d);
  }
  return [...map.values()];
}

interface DbPositionRow {
  id: number;
  dex_id: number | null;
  dex_name: string;
  token_id: string;
  source: string;
  staker_contract: string;
  staking_id: number | null;
  notify_state: string;
}

/**
 * 兜底恢复：本次扫描没发现、但库里仍存在（且非 closed）的仓位。
 *
 * 场景：质押溯源依赖近 N 个块的 Transfer 日志；如果质押发生在更早的区块（fromBlockDelta 之外），
 * 转账扫描就抓不到，仓位会从 discovered 列表里「消失」。直接按消失处理会误标 closed。
 *
 * 策略：反查 NFT 当前 owner ——
 *   - owner == 钱包本身            → 视为直接持有，恢复
 *   - owner 命中已知质押合约        → 视为质押，恢复（带质押信息）
 *   - owner 为其它地址 / 已销毁     → 真的没了，标记 closed
 *
 * 这样即便扫描窗口外的老仓位也能被持续监控，直到它真正被转走或平仓。
 */
async function recoverMissedPositions(
  client: PublicClient,
  wallet: WalletRow,
  dexes: DexRow[],
  staking: StakingRow[],
  discovered: DiscoveredPosition[]
): Promise<DiscoveredPosition[]> {
  const db = getDb();
  const nowIso = new Date().toISOString();

  // 本次发现的 (dexId, tokenId) 集合
  const foundKeys = new Set(discovered.map((d) => `${d.dexId}:${d.tokenId}`));

  // 库里属于该钱包、且非 closed 的仓位
  const rows = db
    .prepare(
      `SELECT id, dex_id, dex_name, token_id, source, staker_contract, staking_id, notify_state
       FROM positions WHERE wallet_id=? AND notify_state!='closed'`
    )
    .all(wallet.id) as DbPositionRow[];

  // 已知质押合约：地址小写 → StakingRow（含 dex 归属信息由 staking_contracts 表的 chain 唯一即可）
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
  const walletLower = wallet.address.toLowerCase();

  const recovered: DiscoveredPosition[] = [];

  for (const row of rows) {
    const dex = dexes.find((d) => d.id === row.dex_id) ?? dexes.find((d) => d.name === row.dex_name);
    if (!dex) continue; // 该 DEX 已被禁用/删除，跳过
    if (foundKeys.has(`${dex.id}:${row.token_id}`)) continue; // 本次已发现，无需恢复

    // 反查当前 owner
    const currentOwner = await ownerOf(client, dex.npm as `0x${string}`, BigInt(row.token_id));

    if (currentOwner && currentOwner.toLowerCase() === walletLower) {
      // 仍在钱包里（直接持有），恢复
      recovered.push({ tokenId: row.token_id, dexId: dex.id, source: "direct" });
      continue;
    }

    const s = currentOwner ? stakingByAddr.get(currentOwner.toLowerCase()) : undefined;
    if (s) {
      // 仍质押在已知合约里，恢复（带质押信息）
      recovered.push({
        tokenId: row.token_id,
        dexId: dex.id,
        source: "staking",
        stakerContract: s.contract,
        stakingId: s.id,
      });
      continue;
    }

    // 既不在钱包也不在已知质押合约 → 真正转移或销毁，标记 closed
    db.prepare(
      `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0
       WHERE id=?`
    ).run(nowIso, row.id);
  }

  return recovered;
}


export function buildNotification(
  w: WalletRow,
  chainName: string,
  dexName: string,
  dp: DiscoveredPosition,
  r: any,
  sym0: string,
  sym1: string,
  pair_flip?: number,
  price0Human: string = ""
) {
  const tag = w.label ? `[${w.label}]` : "";
  // token 对标签：优先用 symbol，没有则回退到地址缩写
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // 处理交易对翻转：翻转后展示口径变为「1 token1 = ? token0」
  // price0Human 是整币单位「1 token0 = ? token1」（已按 decimals 换算），翻转时取倒数
  const flip = pair_flip === 1;
  const baseLabel0 = sym0 || short(r.token0);
  const baseLabel1 = sym1 || short(r.token1);
  const displayLabel0 = flip ? baseLabel1 : baseLabel0;
  const displayLabel1 = flip ? baseLabel0 : baseLabel1;
  const displayPair = `${displayLabel0}/${displayLabel1}`;
  // 翻转时汇率取倒数；空值兜底显示原字符串
  const displayPrice = price0Human
    ? flip
      ? fmt(1 / Number(price0Human))
      : price0Human
    : "";

  const title = `⚠️ LP 越界 ${tag} ${displayPair} · ${chainName}/${dexName}`;
  const dir = r.status.currentTick < r.tickLower ? "低于下界" : "高于上界";
  const body =
    `仓位 #${dp.tokenId}（${displayPair}）已 ${dir}！\n` +
    `token0: ${displayLabel0} (${flip ? short(r.token1) : short(r.token0)})\n` +
    `token1: ${displayLabel1} (${flip ? short(r.token0) : short(r.token1)})\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    `价格(1 ${displayLabel0} ≈ x ${displayLabel1}): ${displayPrice}\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

/** tick 波动告警文案。margin 用 0~1 的相对位置，展示时转成百分比。 */
export function buildTickMoveNotification(
  w: WalletRow,
  chainName: string,
  dexName: string,
  dp: DiscoveredPosition,
  r: any,
  sym0: string,
  sym1: string,
  prevMarginLower: number,
  currMarginLower: number,
  delta: number,
  direction: string,
  pair_flip?: number,
  price0Human: string = ""
) {
  const tag = w.label ? `[${w.label}]` : "";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  // 处理交易对翻转：翻转后展示口径变为「1 token1 = ? token0」
  // price0Human 是整币单位「1 token0 = ? token1」（已按 decimals 换算），翻转时取倒数
  const flip = pair_flip === 1;
  const baseLabel0 = sym0 || short(r.token0);
  const baseLabel1 = sym1 || short(r.token1);
  const displayLabel0 = flip ? baseLabel1 : baseLabel0;
  const displayLabel1 = flip ? baseLabel0 : baseLabel1;
  const displayPair = `${displayLabel0}/${displayLabel1}`;
  const displayPrice = price0Human
    ? flip
      ? fmt(1 / Number(price0Human))
      : price0Human
    : "";

  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  // 涨跌判定（考虑翻转）：tick 上移 → 原始价格（1 token0=? token1）上涨
  //   未翻转：展示口径 = 原始价格 → tick 上移 = 上涨
  //   已翻转：展示口径 = 1/原始价格 → tick 上移 = 下跌
  const tickUp = currMarginLower > prevMarginLower;
  const displayDirection = tickUp === !flip ? "上涨" : "下跌";
  const title = `📈 LP 波动 ${tag} ${displayPair} · ${chainName}/${dexName}`;
  const body =
    `仓位 #${dp.tokenId} 区间内位置: ${pct(prevMarginLower)} → ${pct(currMarginLower)}（变动 ${pct(delta)}，${displayDirection}）\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    `价格(1 ${displayLabel0} ≈ x ${displayLabel1}): ${displayPrice}\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

// 避免未用导入告警
void listChains;

// ===== CEX 报价对比辅助函数 =====

/** 对外传递的 DEX↔CEX 对比结果（payload 即写入 last_cex_price 的 JSON）。 */
/** CEX 价差告警结果。 */
export interface CexPriceInfo {
  /** 是否超过告警阈值 */
  exceedsThreshold: boolean;
  /** 供持久化 + 展示 + 文案共用的结构化数据 */
  payload: CexPricePayload;
}

/** 写入 positions.last_cex_price 的 JSON 结构（前端按相同结构解析展示）。 */
export interface CexPricePayload {
  /** 对比的口径：始终是「1 token0 = ? token1」的汇率（与 DEX 池价同口径）。 */
  pairLabel: string; // 如 'W0G/WETH'，仅展示用
  /** token0 的币安 symbol（计价币种可能与 token1 不同，但能换算成汇率） */
  token0CexSymbol: string; // 如 '0GUSDT'
  /** token1 的币安 symbol */
  token1CexSymbol: string; // 如 'ETHUSDT'
  /** 展示用：两侧计价币种，如 'USDT' 或 'USDT/USDC'（不再参与汇率判定） */
  quote: string;
  /** DEX 池价：1 token0 = dexRate token1（整币单位，已按 decimals 换算） */
  dexRate: number;
  /** CEX 推算汇率：1 token0 = cexRate token1（= token0CexPrice / token1CexPrice） */
  cexRate: number;
  /** (dexRate - cexRate) / cexRate，带符号 */
  diff: number;
  /** diff 的绝对值（0~1），用于和阈值比较 */
  absDiff: number;
}

/**
 * 计算单仓位 token0/token1 在 DEX 与 CEX 之间的汇率差价。
 *
 * 核心逻辑（以 W0G/WETH 为例）：
 *   DEX 池价: 1 W0G = 0.00014678250 WETH          ← r.status.price 经 decimals 换算后
 *   CEX 汇率: 1 0G  = 0.24 USDT, 1 ETH = 1652 USDT
 *            → 1 0G = 0.24/1652 = 0.0001452784504 ETH   ← 即 CEX 上的 0G/ETH 汇率
 *   对比: 0.00014678250 vs 0.0001452784504 的差价
 *
 * 两个关键点：
 *  1) decimals 换算：r.status.price = 1.0001^tick 是 **raw 单位** 的 token1/token0
 *     （最小单位 wei 之间的比），而 CEX 报价是 **整币单位**。两者差 10^(dec1−dec0) 倍。
 *     必须把 raw 价 × 10^(dec0−dec1) 换算成「1 整币 token0 = ? 整币 token1」，
 *     才能与 CEX 汇率同口径对比。例：USDC.e(6dec)/SOL(9dec) 不换算会差 1000 倍。
 *  2) quote 不强校验：用户手动配的映射即认可读数，token0/token1 的计价币种不同
 *     （如 USDT vs USDC）也直接用 q0.price/q1.price 算汇率。这样既不误伤
 *     USDT/USDC 这种两边都是稳定币的池子，也能让跨计价币种的对比（如
 *     WBTC(USDT)↔W0G(USDC)）正常工作。
 *
 * 只要 token0、token1 都有映射且报价有效即可计算；任一缺失/非法 → 返回 null。
 *
 * 注意：CEX 报的是裸币种（如 0G），链上是 wrapped 版本（如 W0G），用户配置映射时
 * 假定 1:1 等价。这是该功能成立的前提，模块不做地址↔币种的自动猜测。
 */
export function computeCexPriceDiff(
  token0Lower: string,
  token1Lower: string,
  dexRateStr: string, // r.status.price: raw 单位的 token1/token0（1.0001^tick）
  quoteByAddr: Map<string, CexQuote>,
  fee: number, // 池子 fee（百万分比，如 3000 = 0.3%，10000 = 1%）
  sym0: string,
  sym1: string,
  dec0: number, // token0 decimals，raw→整币换算用
  dec1: number // token1 decimals，raw→整币换算用
): CexPriceInfo | null {
  const rawRate = Number(dexRateStr); // raw: 1 raw-token0 = rawRate raw-token1
  const q0 = quoteByAddr.get(token0Lower);
  const q1 = quoteByAddr.get(token1Lower);

  // 两边都必须有报价、raw 价合法
  if (!q0 || !q1 || !Number.isFinite(rawRate) || rawRate <= 0 || q1.price <= 0) return null;

  // decimals 换算：1 整币 token0 = rawRate × 10^(dec0−dec1) 整币 token1
  const dexRate = rawRate * Math.pow(10, dec0 - dec1);
  if (!Number.isFinite(dexRate) || dexRate <= 0) return null;

  // CEX 上 1 token0 = (q0.price / q1.price) 个 token1（整币单位，天然同口径）
  // 例：0G=0.24 USDT, ETH=1652 USDT → 1 0G = 0.24/1652 ETH
  const cexRate = q0.price / q1.price;
  if (!Number.isFinite(cexRate) || cexRate <= 0) return null;

  const diff = (dexRate - cexRate) / cexRate;
  const absDiff = Math.abs(diff);

  // 动态阈值：池子 fee 的 2 倍。fee 为百万分比（如 10000 = 1%），换算成 0~1 的小数后 × 2。
  // 例：1% fee → 阈值 2%，0.3% fee → 阈值 0.6%，0.05% fee → 阈值 0.1%。
  const threshold = (fee / 1_000_000) * 2;

  // quote 仅展示用：两侧计价币种相同时取其一，不同时拼成 'USDT/USDC'
  const quote = q0.quote === q1.quote ? q0.quote || "USD" : `${q0.quote}/${q1.quote}`;

  const payload: CexPricePayload = {
    pairLabel: `${sym0}/${sym1}`,
    token0CexSymbol: q0.symbol,
    token1CexSymbol: q1.symbol,
    quote,
    dexRate,
    cexRate,
    diff,
    absDiff,
  };

  return { exceedsThreshold: absDiff >= threshold, payload };
}

/** CEX 价差告警文案。 */
export function buildCexPriceNotification(
  w: WalletRow,
  chainName: string,
  dexName: string,
  dp: DiscoveredPosition,
  r: any,
  sym0: string,
  sym1: string,
  p: CexPricePayload,
  pair_flip?: number
) {
  const tag = w.label ? `[${w.label}]` : "";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const flip = pair_flip === 1;

  // 翻转后展示口径变为「1 token1 = ? token0」：汇率取倒数，符号/标签交换
  const baseLabel0 = sym0 || short(r.token0);
  const baseLabel1 = sym1 || short(r.token1);
  const label0 = flip ? baseLabel1 : baseLabel0;
  const label1 = flip ? baseLabel0 : baseLabel1;
  const pairLabel = `${label0}/${label1}`;
  const dexRate = flip ? 1 / p.dexRate : p.dexRate;
  const cexRate = flip ? 1 / p.cexRate : p.cexRate;
  const token0CexSymbol = flip ? p.token1CexSymbol : p.token0CexSymbol;
  const token1CexSymbol = flip ? p.token0CexSymbol : p.token1CexSymbol;

  const pctSigned = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  const title = `💱 CEX 价差 ${tag} ${pairLabel} · ${chainName}/${dexName}`;
  const body =
    `仓位 #${dp.tokenId}（${pairLabel}）DEX 池价与 CEX 汇率偏差较大\n` +
    `DEX 池价: 1 ${label0} = ${fmt(dexRate)} ${label1}\n` +
    `CEX 汇率: 1 ${label0} = ${fmt(cexRate)} ${label1}（${token0CexSymbol} ÷ ${token1CexSymbol}，均以 ${p.quote} 计价）\n` +
    `价差: ${pctSigned(p.diff)}（阈值 ${(Math.abs(p.absDiff) * 100).toFixed(2)}%）\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

/**
 * 价格展示：完全展开小数，绝不使用科学计数法。
 * 如 2.3815542e+15 → 2381554200000000；0.00000123 → 0.00000123。
 * 告警文案里出现科学计数法很难读，统一展开。
 */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  let s = Math.abs(n) < 1 ? n.toFixed(18) : n.toFixed(8);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  // 防御性：万一仍含 e/E，手动按小数点移位展开
  if (/[eE]/.test(s)) s = numberToFullString(n);
  return s === "" || s === "-" ? "0" : s;
}

/**
 * 把 raw 单位的价格（1.0001^tick，wei/wei 比）换算成整币单位（1 token0 = ? token1），
 * 并展开成无科学计数法的字符串。
 *
 * 与 computeCexPriceDiff 里的 dexRate 同口径：rawRate × 10^(dec0−dec1)。
 * 用于 last_price0 持久化 + 越界/波动告警文案，确保与 CEX 对比口径一致、可直接展示。
 * 解析失败或非法时返回原始字符串（兜底，不致空值）。
 */
export function rawToHumanPrice(rawStr: string, dec0: number, dec1: number): string {
  const raw = Number(rawStr);
  if (!Number.isFinite(raw) || raw <= 0) return rawStr;
  const human = raw * Math.pow(10, dec0 - dec1);
  if (!Number.isFinite(human) || human <= 0) return rawStr;
  return fmt(human);
}

/** 任意 number 转成不含科学计数法的字符串（大数/极小数都展开）。 */
function numberToFullString(num: number): string {
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return "0";
  const sign = num < 0 ? "-" : "";
  const str = Math.abs(num).toString();
  if (!/[eE]/.test(str)) return sign + str;
  const [mantissa, expStr] = str.split(/[eE]/);
  const exp = Number(expStr);
  const [intPart, decPart = ""] = mantissa.split(".");
  const digits = intPart + decPart;
  const point = intPart.length + exp;
  if (point <= 0) {
    return sign + "0." + "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    return sign + digits + "0".repeat(point - digits.length);
  } else {
    return sign + digits.slice(0, point) + "." + digits.slice(point);
  }
}
