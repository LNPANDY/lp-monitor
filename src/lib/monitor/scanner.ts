/**
 * 扫描编排：
 *  1. 加载启用的钱包
 *  2. 对每个钱包：发现仓位（直接持有 + 质押溯源）
 *  3. 读取每个仓位的区间状态
 *  4. 与上次状态对比 → 状态翻转才告警；同状态用 cooldown 去重
 *  5. 写回 positions / alerts
 */
import { getDb } from "../db";
import { appEnv } from "../db/config";
import { getClient, listChains } from "../chains";
import type { PublicClient } from "viem";
import { resolveTokens } from "../chains/tokens";
import { listDexes, listStaking, type DexRow, type StakingRow } from "../chains/dexes";
import { getAdapter } from "../adapters";
import {
  getTickMoveThreshold,
  isTickMoveEnabled,
  isCexPriceEnabled,
  getCexPriceThreshold,
} from "../db/settings";
import {
  findDirectPositions,
  findStakedPositions,
  type DiscoveredPosition,
} from "../staking/discover";
import { ownerOf } from "../adapters/v3-fork";
import { notifyAll } from "../notify";
import {
  loadAllMappings,
  fetchQuotes,
  splitSymbol,
  type CexMapping,
  type CexQuote,
} from "../cex/binance";

export interface ScanSummary {
  wallets: number;
  positions: number;
  outOfRange: number;
  alertsSent: number;
  errors: string[];
  startedAt: string;
  durationMs: number;
}

interface WalletRow {
  id: number;
  chain_id_ref: number;
  address: string;
  label: string;
}

export async function runScan(): Promise<ScanSummary> {
  const startedAt = Date.now();
  const errors: string[] = [];
  let positions = 0;
  let outOfRange = 0;
  let alertsSent = 0;
  const db = getDb();

  // CEX 对比开关 + 阈值：整次扫描共用一份。关闭时跳过所有报价拉取。
  const cexEnabled = isCexPriceEnabled();
  const cexThreshold = getCexPriceThreshold() / 100; // 百分比 → 0~1
  // 所有链上的 token→CEX 映射（按 chain_id_ref 分组）。关闭时不需要加载。
  const cexMappingsByChain = cexEnabled ? loadAllMappings() : new Map<number, CexMapping[]>();
  // 报价缓存（本次扫描内复用）：(tokenAddrLower) → CexQuote
  const cexQuoteByAddr = new Map<string, CexQuote>();

  const wallets = db.prepare("SELECT * FROM wallets WHERE enabled=1").all() as WalletRow[];
  if (wallets.length === 0) {
    return { wallets: 0, positions: 0, outOfRange: 0, alertsSent: 0, errors, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt };
  }

  for (const w of wallets) {
    try {
      const { client, chain } = getClient(w.chain_id_ref);
      const dexes = listDexes(w.chain_id_ref, true);
      const staking = listStaking(w.chain_id_ref, true);

      // 发现仓位：直接持有 + 质押溯源（转账扫描），合并去重
      const direct = await findDirectPositions(client, w.address as `0x${string}`, dexes);
      const staked = await findStakedPositions(
        client,
        w.address as `0x${string}`,
        dexes,
        staking
      );
      const discovered = dedupeDiscovered([...direct, ...staked]);

      // 兜底恢复：库里有但本次未发现的仓位（尤其质押仓位：转账发生在扫描窗口外）。
      // 反查 ownerOf，仍命中钱包或已知质押合约 → 纳入本次扫描；否则视为已转移/已平仓 → 标记 closed。
      const recovered = await recoverMissedPositions(client, w, dexes, staking, discovered);

      // ===== 预取本链 CEX 报价（开启 CEX 对比时）=====
      // 本钱包本链上所有 token0/token1 命中 token_symbols 表的，一次性把需要的币安 symbol 去重批量拉价，
      // 存进 cexQuoteByAddr 供后续仓位循环按地址查。已拉过的（跨钱包/跨仓位重复 symbol）直接复用缓存。
      const pending = collectPendingCexSymbols(cexMappingsByChain, w.chain_id_ref);
      if (cexEnabled && pending.length > 0) {
        const fresh = await fetchQuotes(pending);
        // 把刚拉到的报价回填进 byAddr（一个 cexSymbol 可能对应多个 token 地址）
        for (const [sym, quote] of fresh) {
          for (const m of cexMappingsByChain.get(w.chain_id_ref) ?? []) {
            if (m.cexSymbol === sym) cexQuoteByAddr.set(m.tokenAddr, quote);
          }
        }
      }

      for (const dp of [...discovered, ...recovered]) {
        try {
          const dex = dexes.find((d) => d.id === dp.dexId);
          if (!dex) continue;
          const adapter = getAdapter(dex.type);
          const r = await adapter.readRange(client, { factory: dex.factory, npm: dex.npm }, BigInt(dp.tokenId));

          const nowIso = new Date().toISOString();

          // ===== 三态处理 =====
          if (r.kind === "unreadable") {
            // RPC 读不到 meta / pool / tick —— 不确定仓位是否还活跃。
            // 只更新 last_checked_at，保留旧的 notify_state / tick 等字段，不标 closed、不告警。
            db.prepare(
              `UPDATE positions SET last_checked_at=? WHERE chain_id_ref=? AND dex_name=? AND token_id=?`
            ).run(nowIso, w.chain_id_ref, dex.name, dp.tokenId);
            continue;
          }
          if (r.kind === "closed") {
            // liquidity=0，确认仓位已平仓（NFT 可能还在钱包/质押合约里，但流动性已全部取出）。
            db.prepare(
              `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0
               WHERE chain_id_ref=? AND dex_name=? AND token_id=?`
            ).run(nowIso, w.chain_id_ref, dex.name, dp.tokenId);
            continue;
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
          // prev 里存的是上次扫描时的 margin（首次扫描 prev 为 null，跳过）
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
              // 方向：marginLower 变大 = tick 上移 = 靠近上界
              tickMoveDirection = currMarginLower > prev.last_margin_lower ? "靠近上界" : "靠近下界";
            }
          }

          // ===== CEX 价差判定 =====
          // DEX 池价（token1/token0）按本链 token→CEX 映射换算成「token0 的 CEX 参考价」，
          // 再与币安报价对比。仅当 token0 与 token1 中至少一个在 token_symbols 表里有映射、
          // 且映射出的币安报价本次能拉到时才计算；否则 cexPriceInfo 为 null（不对比、不告警）。
          const cexPriceInfo = cexEnabled
            ? computeCexPriceDiff(
                r.token0.toLowerCase(),
                r.token1.toLowerCase(),
                r.status.price,
                cexQuoteByAddr,
                cexThreshold
              )
            : null;

          // upsert 仓位最新状态
          db.prepare(
            `INSERT INTO positions
              (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, token0_symbol, token1_symbol, fee, pool,
               tick_lower, tick_upper, source, staker_contract, staking_id,
               last_current_tick, last_in_range, last_price0, last_liquidity,
               last_margin_lower, last_margin_upper, last_cex_price,
               last_checked_at, notify_state, last_notified_at)
             VALUES (@wallet_id,@chain_id_ref,@dex_id,@dex_name,@token_id,@token0,@token1,@token0_symbol,@token1_symbol,@fee,@pool,
                     @tick_lower,@tick_upper,@source,@staker_contract,@staking_id,
                     @last_current_tick,@last_in_range,@last_price0,@last_liquidity,
                     @last_margin_lower,@last_margin_upper,@last_cex_price,
                     @last_checked_at,@notify_state,@last_notified_at)
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
               staking_id=excluded.staking_id`
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
            last_price0: r.status.price,
            last_liquidity: r.liquidity?.toString() ?? "",
            last_margin_lower: currMarginLower,
            last_margin_upper: currMarginUpper,
            last_cex_price: cexPriceInfo ? JSON.stringify(cexPriceInfo.payload) : "",
            last_checked_at: nowIso,
            notify_state: inRange ? "in_range" : "out_of_range",
            last_notified_at: prev?.last_notified_at ?? "",
          });

          const positionRow = db
            .prepare("SELECT id, last_notified_at FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
            .get(w.chain_id_ref, dex.name, dp.tokenId) as { id: number; last_notified_at: string };

          // ===== 越界告警触发判定 =====
          // 1) 首次发现且越界 → 告警
          // 2) 从「在区间内」翻转为「越界」→ 告警
          // 3) 从「越界」翻回「在区间内」→ 告警（恢复通知）
          // 4) 持续越界且超过 cooldown（上次告警距今 ≥ 冷却时间）→ 重复告警
          const enteredOutOfRange =
            !inRange && (prevState === "in_range" || prevState === "unknown");
          const reEnteredRange =
            inRange && prevState === "out_of_range";
          const stillOutOfRangeAndExpired =
            !inRange && prevState === "out_of_range" && !withinCooldown(prev?.last_notified_at);

          const rangeTrigger = enteredOutOfRange || reEnteredRange || stillOutOfRangeAndExpired;

          // ===== 发送告警（越界 + 波动各自独立发送）=====
          if (rangeTrigger) {
            const alertType = !inRange ? "out_of_range" : "re_in_range";
            const n = buildNotification(w, chain.name, dex.name, dp, r, sym0, sym1);
            const sendRes = await notifyAll(n);
            alertsSent++;

            db.prepare(
              `INSERT INTO alerts (position_id, type, tick_at, message, channels)
               VALUES (?, ?, ?, ?, ?)`
            ).run(
              positionRow.id,
              alertType,
              r.status.currentTick,
              n.body,
              JSON.stringify(sendRes.sent)
            );
            db.prepare("UPDATE positions SET last_notified_at=? WHERE id=?").run(nowIso, positionRow.id);
          }

          // 波动告警（独立于越界告警，每次超过阈值都发，不设冷却）
          if (tickMoveTriggered) {
            const n = buildTickMoveNotification(
              w, chain.name, dex.name, dp, r, sym0, sym1,
              prev.last_margin_lower, currMarginLower,
              tickMoveDelta, tickMoveDirection
            );
            const sendRes = await notifyAll(n);
            alertsSent++;

            db.prepare(
              `INSERT INTO alerts (position_id, type, tick_at, message, channels)
               VALUES (?, ?, ?, ?, ?)`
            ).run(
              positionRow.id,
              "tick_move",
              r.status.currentTick,
              n.body,
              JSON.stringify(sendRes.sent)
            );
          }

          // CEX 价差告警（独立发送，每次超过阈值都发，不设冷却）
          if (cexPriceInfo && cexPriceInfo.exceedsThreshold) {
            const n = buildCexPriceNotification(
              w, chain.name, dex.name, dp, r, sym0, sym1,
              cexPriceInfo.payload
            );
            const sendRes = await notifyAll(n);
            alertsSent++;

            db.prepare(
              `INSERT INTO alerts (position_id, type, tick_at, message, channels)
               VALUES (?, ?, ?, ?, ?)`
            ).run(
              positionRow.id,
              "cex_price",
              r.status.currentTick,
              n.body,
              JSON.stringify(sendRes.sent)
            );
          }
        } catch (e: any) {
          errors.push(`position ${dp.tokenId} on chain ${w.chain_id_ref}: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      errors.push(`wallet ${w.address}: ${e?.message ?? e}`);
    }
  }

  return {
    wallets: wallets.length,
    positions,
    outOfRange,
    alertsSent,
    errors,
    startedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
  };
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

function withinCooldown(lastNotifiedIso: string | undefined): boolean {
  if (!lastNotifiedIso) return false; // 没发过，不在冷却
  const last = Date.parse(lastNotifiedIso);
  if (Number.isNaN(last)) return false;
  return Date.now() - last < appEnv.monitor.cooldownMs;
}

function buildNotification(
  w: WalletRow,
  chainName: string,
  dexName: string,
  dp: DiscoveredPosition,
  r: any,
  sym0: string,
  sym1: string
) {
  const tag = w.label ? `[${w.label}]` : "";
  // token 对标签：优先用 symbol，没有则回退到地址缩写
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const label0 = sym0 || short(r.token0);
  const label1 = sym1 || short(r.token1);
  const pair = `${label0}/${label1}`;
  const title = `⚠️ LP 越界 ${tag} ${pair} · ${chainName}/${dexName}`;
  const dir = r.status.currentTick < r.tickLower ? "低于下界" : "高于上界";
  const body =
    `仓位 #${dp.tokenId}（${pair}）已 ${dir}！\n` +
    `token0: ${label0} (${short(r.token0)})\n` +
    `token1: ${label1} (${short(r.token1)})\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    `价格(1 ${label0} ≈ x ${label1}): ${r.status.price}\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

/** tick 波动告警文案。margin 用 0~1 的相对位置，展示时转成百分比。 */
function buildTickMoveNotification(
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
  direction: string
) {
  const tag = w.label ? `[${w.label}]` : "";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const label0 = sym0 || short(r.token0);
  const label1 = sym1 || short(r.token1);
  const pair = `${label0}/${label1}`;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const title = `📈 LP 波动 ${tag} ${pair} · ${chainName}/${dexName}`;
  const body =
    `仓位 #${dp.tokenId}（${pair}）价格波动较大，${direction}\n` +
    `区间内位置: ${pct(prevMarginLower)} → ${pct(currMarginLower)}（变动 ${pct(delta)}）\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    `价格(1 ${label0} ≈ x ${label1}): ${r.status.price}\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

// 避免未用导入告警
void listChains;

// ===== CEX 报价对比辅助函数 =====

/** 对外传递的 DEX↔CEX 对比结果（payload 即写入 last_cex_price 的 JSON）。 */
interface CexPriceInfo {
  /** 是否超过告警阈值 */
  exceedsThreshold: boolean;
  /** 供持久化 + 展示 + 文案共用的结构化数据 */
  payload: CexPricePayload;
}

/** 写入 positions.last_cex_price 的 JSON 结构（前端按相同结构解析展示）。 */
export interface CexPricePayload {
  /** 用作定价基准的 base token 地址（小写）：token0 或 token1 中有币安映射的那个 */
  baseTokenAddr: string;
  /** base 的链上 symbol（展示用，可能为空） */
  baseSymbol: string;
  /** 币安交易对 symbol，如 '0GUSDT' */
  cexSymbol: string;
  /** 计价币种，如 'USDT' */
  quote: string;
  /** DEX 池里 1 base = ? quote（由 token1/token0 池价 + 两边 CEX 报价换算得出） */
  dexPrice: number;
  /** 币安 1 base = ? quote */
  cexPrice: number;
  /** (dexPrice - cexPrice) / cexPrice，带符号 */
  diff: number;
  /** diff 的绝对值（0~1），用于和阈值比较 */
  absDiff: number;
}

/**
 * 计算单仓位 token0/token1 与币安报价的价差。
 *
 * 思路：池价是 token1/token0（1 token0 = price0 token1）。
 * 若 token0 有币安映射（如 0GUSDT），则「1 token0 的 CEX 价」= 币安报价（直接，币种对齐）；
 * 若只有 token1 有映射，则用 token1 的币安报价 × 池价反推出「1 token0 = ? quote」。
 * 任一 token 都没映射、或本次拉不到对应币安价 → 返回 null（不对比、不告警、写空）。
 *
 * 注意：CEX 上报的是裸币种（如 0G），链上多为 wrapped/桥接版本（同价近似成立才合理）。
 * 这是用户在配置页手动建立映射的前提条件，模块本身不做地址↔币种的自动猜测。
 */
function computeCexPriceDiff(
  token0Lower: string,
  token1Lower: string,
  dexPrice0Str: string, // r.status.price: 1 token0 = ? token1
  quoteByAddr: Map<string, CexQuote>,
  threshold: number
): CexPriceInfo | null {
  const dexPrice0 = Number(dexPrice0Str); // 1 token0 = dexPrice0 token1
  const q0 = quoteByAddr.get(token0Lower);
  const q1 = quoteByAddr.get(token1Lower);

  let baseTokenAddr = "";
  let baseSymbol = "";
  let cexSymbol = "";
  let quote = "";
  let dexPrice = NaN; // 1 base = ? quote（同计价口径）
  let cexPrice = NaN;

  if (q0 && Number.isFinite(dexPrice0)) {
    // token0 直接有币安报价：DEX 价口径需统一成 token0 的计价币种。
    // 池里是 1 token0 = dexPrice0 token1；若 token1 也有币安报价 q1，可把 token1 换算成 quote，
    // 得到「1 token0 = dexPrice0 × q1.price  quote」（计价币种与 q1.quote 一致）。
    if (q1 && Number.isFinite(dexPrice0)) {
      baseTokenAddr = token0Lower;
      baseSymbol = splitSymbol(q0.symbol).base;
      cexSymbol = q0.symbol;
      quote = q1.quote;
      dexPrice = dexPrice0 * q1.price;
      cexPrice = q0.price;
    } else {
      // 只有 token0 有报价：直接用币安价当 DEX 参考近似（口径不完全一致，仅作粗略提示）
      baseTokenAddr = token0Lower;
      baseSymbol = splitSymbol(q0.symbol).base;
      cexSymbol = q0.symbol;
      quote = q0.quote;
      dexPrice = dexPrice0; // 口径不一致，仅粗略
      cexPrice = q0.price;
    }
  } else if (q1) {
    // 只有 token1 有报价：以 token1 为 base。
    // 池里 1 token0 = dexPrice0 token1，即 1 token1 = 1/dexPrice0 token0；
    // DEX「1 token1 的 quote 价」需要 token0 的币安价，但 token0 无映射 → 只能用币安价近似 DEX 价。
    baseTokenAddr = token1Lower;
    baseSymbol = splitSymbol(q1.symbol).base;
    cexSymbol = q1.symbol;
    quote = q1.quote;
    dexPrice = dexPrice0 > 0 ? 1 / dexPrice0 : NaN; // token1 相对 token0 的池价（口径不齐，粗略）
    cexPrice = q1.price;
  }

  if (!baseTokenAddr || !Number.isFinite(dexPrice) || !Number.isFinite(cexPrice) || cexPrice <= 0) {
    return null;
  }

  const diff = (dexPrice - cexPrice) / cexPrice;
  const absDiff = Math.abs(diff);

  const payload: CexPricePayload = {
    baseTokenAddr,
    baseSymbol,
    cexSymbol,
    quote,
    dexPrice,
    cexPrice,
    diff,
    absDiff,
  };

  return { exceedsThreshold: absDiff >= threshold, payload };
}

/**
 * 收集本链本批仓位里需要的币安 symbol（去重）。
 * 本链所有启用映射的 symbol 都纳入——真正的去重与短期复用在 binance.ts 内部完成
 * （同次扫描跨钱包/跨仓位复用进程缓存，避免重复打接口）。
 */
function collectPendingCexSymbols(
  mappingsByChain: Map<number, CexMapping[]>,
  chainIdRef: number
): string[] {
  const mappings = mappingsByChain.get(chainIdRef);
  if (!mappings || mappings.length === 0) return [];
  const symbols = new Set<string>();
  for (const m of mappings) symbols.add(m.cexSymbol);
  return [...symbols];
}

/** CEX 价差告警文案。 */
function buildCexPriceNotification(
  w: WalletRow,
  chainName: string,
  dexName: string,
  dp: DiscoveredPosition,
  r: any,
  sym0: string,
  sym1: string,
  p: CexPricePayload
) {
  const tag = w.label ? `[${w.label}]` : "";
  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
  const label0 = sym0 || short(r.token0);
  const label1 = sym1 || short(r.token1);
  const pair = `${label0}/${label1}`;
  const pctSigned = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(2)}%`;
  const baseLabel = p.baseSymbol || short(p.baseTokenAddr);
  const title = `💱 CEX 价差 ${tag} ${pair} · ${chainName}/${dexName}`;
  const body =
    `仓位 #${dp.tokenId}（${pair}）${baseLabel} 的 DEX 池价与币安报价偏差较大\n` +
    `对比基准: ${baseLabel}（${p.cexSymbol}）\n` +
    `DEX 价: 1 ${baseLabel} ≈ ${fmt(p.dexPrice)} ${p.quote}\n` +
    `币安价: 1 ${baseLabel} ≈ ${fmt(p.cexPrice)} ${p.quote}\n` +
    `价差: ${pctSigned(p.diff)}（阈值 ${(Math.abs(p.absDiff) * 100).toFixed(2)}%）\n` +
    `当前 tick: ${r.status.currentTick}\n` +
    `区间: [${r.tickLower}, ${r.tickUpper}]\n` +
    (dp.source === "staking" ? `来源: 质押 @ ${short(dp.stakerContract ?? "")}\n` : `来源: 直接持有\n`) +
    `钱包: ${w.address}`;
  return { title, body };
}

/** 价格展示：去掉无意义尾零。 */
function fmt(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // 极小价格用更多小数位，普通价格 6 位足够
  if (n !== 0 && Math.abs(n) < 1) return n.toPrecision(6);
  return n.toLocaleString("en-US", { maximumFractionDigits: 6 });
}
