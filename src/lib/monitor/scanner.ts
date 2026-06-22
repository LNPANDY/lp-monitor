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
  findDirectPositions,
  findStakedPositions,
  type DiscoveredPosition,
} from "../staking/discover";
import { ownerOf } from "../adapters/v3-fork";
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

      for (const dp of [...discovered, ...recovered]) {
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

// 避免未用导入告警
void listChains;
