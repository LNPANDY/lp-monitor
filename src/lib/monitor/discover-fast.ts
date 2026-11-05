/**
 * 极速全能发现引擎（discover-fast）：
 *
 * 1. 多钱包合并 Topic 扫描（`findRecentPositionsForWallets`）：
 *    同一条链上所有启用钱包合并为单次 `eth_getLogs(to: wallets)` + `eth_getLogs(from: wallets)`，
 *    单窗口控制在 950 块以内（单次 RPC 直接返回，不触发节点 1000 块限制与二分重试）。
 * 2. SQLite 持久化区块游标（`last_scanned_block_<chainId>`）：
 *    每次扫描后更新游标，日常 30 秒增量仅扫几十个块，耗时 ~150ms。
 * 3. 已监控钱包零冗余盘点：
 *    若钱包在 DB 中已有仓位记录，直接标记初始化完成；仅全新空钱包首次添加时检查尾部最新 15 个直持 NFT。
 */
import { getDb, isPairFlipped } from "../db";
import { getClient } from "../chains";
import { listDexes, listStaking } from "../chains/dexes";
import {
  findDirectPositions,
  findRecentPositionsForWallets,
  eachLimit,
  type DiscoveredPosition,
} from "../staking/discover";
import { ownerOf } from "../adapters/v3-fork";
import { getAdapter } from "../adapters";
import { estimateBlockTimeSec, secondsToBlocks } from "../chains/blocktime";
import {
  getFullScanPaddingSec,
  getSetting,
  setSetting,
} from "../db/settings";
import { resolveTokens } from "../chains/tokens";
import type { Address } from "viem";

/** 单次增量日志回溯的最大区块数（小于 0G 等 RPC 节点的 1000 块单次上限，确保 1 次请求直接返回） */
const MAX_LOOKBACK_BLOCKS = 950n;

export interface FastDiscoverSummary {
  windows: { chainId: number; from: string; to: string; blocks: number }[];
  candidatesCount: number;
  directCount: number;
  stakingCount: number;
  outgoingCount: number;
  newInserted: number;
  sourceChanged: number;
  closed: number;
  durationMs: number;
  errors: string[];
}

export async function runFastDiscover(opts: {
  lastBlockByChain: Record<number, bigint>;
  blockTimeByChain: Record<number, number>;
  isFirstScan: boolean;
  /** 若为 true，对尚无任何仓位的钱包检查尾部最新直持 NFT */
  forceFullInventory?: boolean;
}): Promise<FastDiscoverSummary> {
  const startedAt = Date.now();
  const errors: string[] = [];
  const db = getDb();

  let candidatesCount = 0;
  let directCount = 0;
  let stakingCount = 0;
  let outgoingCount = 0;
  let newInserted = 0;
  let sourceChanged = 0;
  let closedCount = 0;
  const windows: FastDiscoverSummary["windows"] = [];

  const chains = db
    .prepare(`SELECT DISTINCT w.chain_id_ref FROM wallets w WHERE w.enabled=1`)
    .all() as { chain_id_ref: number }[];

  const paddingSec = getFullScanPaddingSec();

  for (const { chain_id_ref: chainIdRef } of chains) {
    try {
      const tChain0 = Date.now();
      const { client, chain } = getClient(chainIdRef);
      const dexes = listDexes(chainIdRef, true);
      const staking = listStaking(chainIdRef, true);
      if (dexes.length === 0) continue;

      const latest = await client.getBlockNumber();

      let blockTime = opts.blockTimeByChain[chainIdRef];
      if (!blockTime) {
        blockTime = await estimateBlockTimeSec(client);
        opts.blockTimeByChain[chainIdRef] = blockTime;
      }

      // 优先从内存或 SQLite 读取上次扫描区块号
      const dbBlockKey = `last_scanned_block_${chainIdRef}`;
      let savedBlock = opts.lastBlockByChain[chainIdRef];
      if (!savedBlock) {
        const rawSaved = getSetting(dbBlockKey, "");
        if (rawSaved && /^\d+$/.test(rawSaved)) {
          savedBlock = BigInt(rawSaved);
          opts.lastBlockByChain[chainIdRef] = savedBlock;
        }
      }

      let fromBlock: bigint;
      const minAllowedFrom =
        latest > MAX_LOOKBACK_BLOCKS ? latest - MAX_LOOKBACK_BLOCKS : 0n;

      if (!savedBlock) {
        fromBlock = minAllowedFrom;
      } else {
        const paddingBlocks = secondsToBlocks(paddingSec, blockTime);
        fromBlock = savedBlock > paddingBlocks ? savedBlock - paddingBlocks : 0n;
        if (fromBlock < minAllowedFrom) fromBlock = minAllowedFrom;
        if (fromBlock > latest) fromBlock = latest;
      }

      windows.push({
        chainId: chainIdRef,
        from: fromBlock.toString(),
        to: latest.toString(),
        blocks: Number(latest - fromBlock),
      });

      const wallets = db
        .prepare("SELECT id, address FROM wallets WHERE chain_id_ref=? AND enabled=1")
        .all(chainIdRef) as { id: number; address: string }[];
      if (wallets.length === 0) continue;

      // 预加载本链在 DB 中已知的所有仓位（含 closed 空壳，避免重复链上读取）
      const existingRows = db
        .prepare(
          "SELECT id, wallet_id, dex_name, token_id, notify_state, source, pool FROM positions WHERE chain_id_ref=?"
        )
        .all(chainIdRef) as {
        id: number;
        wallet_id: number;
        dex_name: string;
        token_id: string;
        notify_state: string;
        source: string;
        pool: string;
      }[];
      const existingByKey = new Map<
        string,
        { id: number; wallet_id: number; notify_state: string; source: string; pool: string }
      >();
      const positionCountByWallet = new Map<number, number>();
      for (const r of existingRows) {
        existingByKey.set(`${r.dex_name}:${r.token_id}`, r);
        positionCountByWallet.set(
          r.wallet_id,
          (positionCountByWallet.get(r.wallet_id) ?? 0) + 1
        );
      }

      const stakingByAddr = new Map(
        staking.map((s) => [s.contract.toLowerCase(), s])
      );
      const nowIso = new Date().toISOString();

      // 1. 一次性批量扫描本链所有启用钱包的 Transfer 事件（每个 DEX 仅 2 次 getLogs RPC）
      const batchLogs = await findRecentPositionsForWallets(
        client,
        wallets.map((w) => w.address as Address),
        dexes,
        staking,
        fromBlock,
        latest
      );

      for (const w of wallets) {
        try {
          const tWallet0 = Date.now();
          const walletLower = w.address.toLowerCase();
          const walletInitKey = `wallet_init_done_${w.id}`;
          const existingWalletPosCount = positionCountByWallet.get(w.id) ?? 0;

          // 如果该钱包在 DB 中已有仓位，直接标记已初始化，绝不执行耗时全量枚举
          if (existingWalletPosCount > 0 && getSetting(walletInitKey, "") !== "1") {
            setSetting(walletInitKey, "1");
          }

          const needsInitialInventory =
            existingWalletPosCount === 0 &&
            (opts.forceFullInventory || getSetting(walletInitKey, "") !== "1");

          const cands = batchLogs.byWallet.get(walletLower) ?? {
            candidates: [],
            outgoing: [],
          };

          const mergedMap = new Map<string, DiscoveredPosition>();
          for (const c of cands.candidates) {
            mergedMap.set(`${c.dexId}:${c.tokenId}`, c);
          }

          // 2. 仅当全新钱包（DB 尚无任何仓位）首次接入时，快速拉取尾部最新 15 个直持 NFT
          if (needsInitialInventory) {
            const directList = await findDirectPositions(
              client,
              w.address as Address,
              dexes,
              15
            );
            for (const d of directList) {
              const k = `${d.dexId}:${d.tokenId}`;
              if (!mergedMap.has(k)) {
                mergedMap.set(k, d);
              }
            }
            setSetting(walletInitKey, "1");
          }

          const finalCandidates = [...mergedMap.values()];
          const stakingCnt = finalCandidates.filter(
            (c) => c.source === "staking"
          ).length;
          const dCnt = finalCandidates.length - stakingCnt;
          candidatesCount += finalCandidates.length;
          directCount += dCnt;
          stakingCount += stakingCnt;
          outgoingCount += cands.outgoing.length;

          // 3. outgoing: 转出到非质押合约 → 反查 ownerOf 标 closed
          let walletClosed = 0;
          await eachLimit(cands.outgoing, 8, async (out) => {
            const dex = dexes.find((d) => d.id === out.dexId);
            if (!dex) return;
            const existing = existingByKey.get(`${dex.name}:${out.tokenId}`);
            if (!existing || existing.notify_state === "closed") return;
            let currentOwner: string | null = null;
            try {
              currentOwner = await ownerOf(
                client,
                dex.npm as Address,
                BigInt(out.tokenId)
              );
            } catch {
              return;
            }
            if (!currentOwner) return;
            const ownerLower = currentOwner.toLowerCase();
            if (ownerLower === walletLower) return;
            if (stakingByAddr.has(ownerLower)) return;
            db.prepare(
              `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0 WHERE id=?`
            ).run(nowIso, existing.id);
            existing.notify_state = "closed";
            closedCount++;
            walletClosed++;
          });

          // 4. 处理候选列表
          let walletNew = 0;
          let walletSourceChanged = 0;
          const unknownCandidates: DiscoveredPosition[] = [];

          for (const dp of finalCandidates) {
            const dex = dexes.find((d) => d.id === dp.dexId);
            if (!dex) continue;
            const existing = existingByKey.get(`${dex.name}:${dp.tokenId}`);
            if (existing) {
              if (existing.notify_state === "closed") {
                continue;
              }
              if (existing.source !== dp.source || existing.wallet_id !== w.id) {
                db.prepare(
                  `UPDATE positions SET wallet_id=?, source=?, staker_contract=?, staking_id=?, last_checked_at=? WHERE id=?`
                ).run(
                  w.id,
                  dp.source,
                  dp.stakerContract ?? "",
                  dp.stakingId ?? null,
                  nowIso,
                  existing.id
                );
                existing.source = dp.source;
                existing.wallet_id = w.id;
                sourceChanged++;
                walletSourceChanged++;
              }
              continue;
            }
            unknownCandidates.push(dp);
          }

          // 并发读取新发现的候选 tokenId
          await eachLimit(unknownCandidates, 8, async (dp) => {
            const dex = dexes.find((d) => d.id === dp.dexId);
            if (!dex) return;
            const adapter = getAdapter(dex.type);
            const r = await adapter.readRange(
              client,
              {
                factory: dex.factory,
                npm: dex.npm,
                stateview: dex.stateview,
              },
              BigInt(dp.tokenId)
            );
            if (r.kind === "unreadable") return;
            if (r.kind === "closed") {
              try {
                db.prepare(
                  `INSERT OR IGNORE INTO positions
                    (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, fee, pool,
                     tick_lower, tick_upper, source, staker_contract, staking_id,
                     last_current_tick, last_in_range, last_checked_at, notify_state)
                   VALUES (?,?,?,?,?,'','',0,'',0,0,?,?,?,0,0,?,'closed')`
                ).run(
                  w.id,
                  chainIdRef,
                  dex.id,
                  dex.name,
                  dp.tokenId,
                  dp.source,
                  dp.stakerContract ?? "",
                  dp.stakingId ?? null,
                  nowIso
                );
                existingByKey.set(`${dex.name}:${dp.tokenId}`, {
                  id: 0,
                  wallet_id: w.id,
                  notify_state: "closed",
                  source: dp.source,
                  pool: "",
                });
              } catch {}
              return;
            }

            const tokenMap = await resolveTokens(client, chainIdRef, [
              r.token0,
              r.token1,
            ]);
            const sym0 = tokenMap.get(r.token0.toLowerCase())?.symbol ?? "";
            const sym1 = tokenMap.get(r.token1.toLowerCase())?.symbol ?? "";
            const dec0 = tokenMap.get(r.token0.toLowerCase())?.decimals ?? 18;
            const dec1 = tokenMap.get(r.token1.toLowerCase())?.decimals ?? 18;

            const inRange = r.status.inRange;
            const span = Math.max(r.tickUpper - r.tickLower, 1);
            const marginLower = (r.status.currentTick - r.tickLower) / span;
            const marginUpper = (r.tickUpper - r.status.currentTick) / span;
            const price0HumanStr = rawToHumanPrice(r.status.price, dec0, dec1);
            const prevPairFlip = isPairFlipped(chainIdRef, r.token0, r.token1)
              ? 1
              : 0;

            db.prepare(
              `INSERT INTO positions
                (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, token0_symbol, token1_symbol, fee, pool,
                 tick_lower, tick_upper, source, staker_contract, staking_id,
                 last_current_tick, last_in_range, last_price0, last_liquidity,
                 last_margin_lower, last_margin_upper, last_cex_price,
                 last_checked_at, notify_state, last_notified_at, pair_flip)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(chain_id_ref, dex_name, token_id) DO UPDATE SET
                 wallet_id=excluded.wallet_id,
                 source=excluded.source,
                 staker_contract=excluded.staker_contract,
                 staking_id=excluded.staking_id,
                 last_current_tick=excluded.last_current_tick,
                 last_in_range=excluded.last_in_range,
                 last_price0=excluded.last_price0,
                 last_liquidity=excluded.last_liquidity,
                 last_margin_lower=excluded.last_margin_lower,
                 last_margin_upper=excluded.last_margin_upper,
                 last_checked_at=excluded.last_checked_at,
                 notify_state=excluded.notify_state,
                 pair_flip=excluded.pair_flip`
            ).run(
              w.id,
              chainIdRef,
              dex.id,
              dex.name,
              dp.tokenId,
              r.token0,
              r.token1,
              sym0,
              sym1,
              r.fee,
              r.status.pool,
              r.tickLower,
              r.tickUpper,
              dp.source,
              dp.stakerContract ?? "",
              dp.stakingId ?? null,
              r.status.currentTick,
              inRange ? 1 : 0,
              price0HumanStr,
              r.liquidity?.toString() ?? "",
              marginLower,
              marginUpper,
              "",
              nowIso,
              inRange ? "in_range" : "out_of_range",
              "",
              prevPairFlip
            );
            newInserted++;
            walletNew++;
          });

          if (walletNew > 0 || walletSourceChanged > 0 || walletClosed > 0) {
            console.log(
              `[fast-discover] wallet ${w.address} chain ${chain.name}: new=${walletNew} source_changed=${walletSourceChanged} closed=${walletClosed} (${
                Date.now() - tWallet0
              }ms)`
            );
          }
        } catch (e: any) {
          errors.push(
            `[fast-discover] wallet ${w.address} chain ${chain.name}: ${
              e?.message ?? e
            }`
          );
        }
      }

      // 推进区块游标并持久化到 SQLite
      opts.lastBlockByChain[chainIdRef] = latest;
      setSetting(dbBlockKey, latest.toString());
      console.log(
        `[fast-discover] chain ${chain.name} (${wallets.length} wallets, ${Number(
          latest - fromBlock
        )} blocks): done in ${Date.now() - tChain0}ms`
      );
    } catch (e: any) {
      errors.push(`[fast-discover] chain ${chainIdRef}: ${e?.message ?? e}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  return {
    windows,
    candidatesCount,
    directCount,
    stakingCount,
    outgoingCount,
    newInserted,
    sourceChanged,
    closed: closedCount,
    durationMs,
    errors,
  };
}

function rawToHumanPrice(rawStr: string, dec0: number, dec1: number): string {
  try {
    const raw = Number(rawStr);
    if (!Number.isFinite(raw) || raw <= 0) return "";
    const human = raw * Math.pow(10, dec0 - dec1);
    if (!Number.isFinite(human)) return String(raw);
    return String(human);
  } catch {
    return "";
  }
}