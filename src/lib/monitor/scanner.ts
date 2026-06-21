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
import { resolveTokens } from "../chains/tokens";
import { listDexes, listStaking, type DexRow, type StakingRow } from "../chains/dexes";
import { getAdapter } from "../adapters";
import {
  findDirectPositions,
  findStakedPositionsByEvents,
  findStakedPositionsByTransfer,
  type DiscoveredPosition,
} from "../staking/discover";
import { notifyAll } from "../notify";

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

  const wallets = db.prepare("SELECT * FROM wallets WHERE enabled=1").all() as WalletRow[];
  if (wallets.length === 0) {
    return { wallets: 0, positions: 0, outOfRange: 0, alertsSent: 0, errors, startedAt: new Date(startedAt).toISOString(), durationMs: Date.now() - startedAt };
  }

  for (const w of wallets) {
    try {
      const { client, chain } = getClient(w.chain_id_ref);
      const dexes = listDexes(w.chain_id_ref, true);
      const staking = listStaking(w.chain_id_ref, true);

      // 发现仓位（三种方式合并去重）
      const direct = await findDirectPositions(client, w.address as `0x${string}`, dexes);
      const stakedByEvents = await findStakedPositionsByEvents(
        client,
        w.address as `0x${string}`,
        dexes,
        staking
      );
      const stakedByTransfer = await findStakedPositionsByTransfer(
        client,
        w.address as `0x${string}`,
        dexes,
        staking
      );
      const discovered = dedupeDiscovered([...direct, ...stakedByEvents, ...stakedByTransfer]);

      for (const dp of discovered) {
        try {
          const dex = dexes.find((d) => d.id === dp.dexId);
          if (!dex) continue;
          const adapter = getAdapter(dex.type);
          const r = await adapter.readRange(client, { factory: dex.factory, npm: dex.npm }, BigInt(dp.tokenId));

          const nowIso = new Date().toISOString();

          // 仓位读不到或 liquidity=0（已关闭）：若库里已存在该仓位，标记为 closed，
          // 前端会过滤掉 closed 仓位。不再 upsert 最新状态、不告警。
          if (!r) {
            db.prepare(
              `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0
               WHERE chain_id_ref=? AND dex_name=? AND token_id=?`
            ).run(nowIso, w.chain_id_ref, dex.name, dp.tokenId);
            continue;
          }
          positions++;

          // 解析 token0/token1 的 symbol（带缓存），用于展示和告警文案
          const tokenMap = await resolveTokens(client, w.chain_id_ref, [r.token0, r.token1]);
          const sym0 = tokenMap.get(r.token0.toLowerCase())?.symbol ?? "";
          const sym1 = tokenMap.get(r.token1.toLowerCase())?.symbol ?? "";

          const inRange = r.status.inRange;
          if (!inRange) outOfRange++;

          const prev = db
            .prepare("SELECT * FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
            .get(w.chain_id_ref, dex.name, dp.tokenId) as any;

          const prevState = prev?.notify_state ?? "unknown";

          // upsert 仓位最新状态
          db.prepare(
            `INSERT INTO positions
              (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, token0_symbol, token1_symbol, fee, pool,
               tick_lower, tick_upper, source, staker_contract, staking_id,
               last_current_tick, last_in_range, last_price0, last_liquidity,
               last_checked_at, notify_state, last_notified_at)
             VALUES (@wallet_id,@chain_id_ref,@dex_id,@dex_name,@token_id,@token0,@token1,@token0_symbol,@token1_symbol,@fee,@pool,
                     @tick_lower,@tick_upper,@source,@staker_contract,@staking_id,
                     @last_current_tick,@last_in_range,@last_price0,@last_liquidity,
                     @last_checked_at,@notify_state,@last_notified_at)
             ON CONFLICT(chain_id_ref, dex_name, token_id) DO UPDATE SET
               last_current_tick=excluded.last_current_tick,
               last_in_range=excluded.last_in_range,
               last_price0=excluded.last_price0,
               last_liquidity=excluded.last_liquidity,
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
            last_checked_at: nowIso,
            notify_state: inRange ? "in_range" : "out_of_range",
            last_notified_at: prev?.last_notified_at ?? "",
          });

          const positionRow = db
            .prepare("SELECT id, last_notified_at FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
            .get(w.chain_id_ref, dex.name, dp.tokenId) as { id: number; last_notified_at: string };

          // ===== 告警触发判定（清晰版） =====
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

          const trigger = enteredOutOfRange || reEnteredRange || stillOutOfRangeAndExpired;
          if (!trigger) continue;

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

// 避免未用导入告警
void listChains;
