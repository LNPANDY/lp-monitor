/**
 * 极速全能发现引擎（discover-fast）：
 *
 * 1. SQLite 持久化区块游标（`last_scanned_block_<chainId>`）：
 *    服务重启后直接从上次成功的区块高度继续，不再断档漏块。
 * 2. 新钱包首次自动全盘点（`wallet_init_done_<walletId>`）：
 *    对尚未初始化盘点过的钱包，自动执行一次 `findDirectPositions` + `findStakedPositions`（含 Vault 现存 NFT 直查），
 *    无视区块高度限制捞出所有历史直持/质押仓位，同时跳过已知 closed 空壳 NFT。
 * 3. 定向 Topic + 自动分片 `findRecentPositionsByTransfer`：
 *    仅在 `allSucceeded === true` 时推进区块游标，RPC 抖动时下次自动重扫。
 */
import { getDb, isPairFlipped } from "../db";
import { getClient } from "../chains";
import { listDexes, listStaking } from "../chains/dexes";
import {
  findDirectPositions,
  findStakedPositions,
  findRecentPositionsByTransfer,
  eachLimit,
  type DiscoveredPosition,
} from "../staking/discover";
import { ownerOf, batchReadPoolTicks } from "../adapters/v3-fork";
import { getAdapter } from "../adapters";
import { estimateBlockTimeSec, secondsToBlocks } from "../chains/blocktime";
import {
  getFullScanFirstHours,
  getFullScanPaddingSec,
  getSetting,
  setSetting,
} from "../db/settings";
import { resolveTokens } from "../chains/tokens";
import type { Address } from "viem";

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
  /** 若为 true，强制对所有启用钱包做一次直持 + Vault 质押全盘点 */
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

  const firstHours = getFullScanFirstHours();
  const paddingSec = getFullScanPaddingSec();

  for (const { chain_id_ref: chainIdRef } of chains) {
    try {
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

      // 优先从内存或 SQLite 读取上次成功扫描的区块号
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
      if (!savedBlock) {
        const firstBlocks = secondsToBlocks(firstHours * 3600, blockTime);
        fromBlock = latest > firstBlocks ? latest - firstBlocks : 0n;
      } else {
        const paddingBlocks = secondsToBlocks(paddingSec, blockTime);
        fromBlock = savedBlock > paddingBlocks ? savedBlock - paddingBlocks : 0n;
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

      // 预加载本链在 DB 中已知的所有仓位（含 closed 空壳，避免重复链上读取）
      const existingRows = db
        .prepare(
          "SELECT id, dex_name, token_id, notify_state, source, pool FROM positions WHERE chain_id_ref=?"
        )
        .all(chainIdRef) as {
        id: number;
        dex_name: string;
        token_id: string;
        notify_state: string;
        source: string;
        pool: string;
      }[];
      const existingByKey = new Map<
        string,
        { id: number; notify_state: string; source: string; pool: string }
      >();
      const skipIdsForStaking = new Set<string>();
      for (const r of existingRows) {
        existingByKey.set(`${r.dex_name}:${r.token_id}`, r);
        const matchedDex = dexes.find((d) => d.name === r.dex_name);
        if (matchedDex && r.notify_state === "closed") {
          skipIdsForStaking.add(`${matchedDex.id}:${r.token_id}`);
        }
      }

      const stakingByAddr = new Map(
        staking.map((s) => [s.contract.toLowerCase(), s])
      );
      const nowIso = new Date().toISOString();
      let chainAllLogsSucceeded = true;

      for (const w of wallets) {
        try {
          const tWallet0 = Date.now();
          const walletLower = w.address.toLowerCase();
          const walletInitKey = `wallet_init_done_${w.id}`;
          const needsInitialInventory =
            opts.forceFullInventory || getSetting(walletInitKey, "") !== "1";

          // 1. 增量 Transfer 事件扫描（带钱包 Topic 过滤 + 自动分片）
          const cands = await findRecentPositionsByTransfer(
            client,
            w.address as Address,
            dexes,
            staking,
            fromBlock,
            latest
          );
          if (!cands.allSucceeded) {
            chainAllLogsSucceeded = false;
          }

          const mergedMap = new Map<string, DiscoveredPosition>();
          for (const c of cands.candidates) {
            mergedMap.set(`${c.dexId}:${c.tokenId}`, c);
          }

          // 2. 若该钱包是首次加入或手动触发全盘点：用 balanceOf + Vault 枚举补齐所有历史仓位（不受区块窗口限制）
          if (needsInitialInventory) {
            const [directList, stakedList] = await Promise.all([
              findDirectPositions(client, w.address as Address, dexes),
              findStakedPositions(client, w.address as Address, dexes, staking, {
                fromBlock,
                skipIds: skipIdsForStaking,
              }),
            ]);
            for (const d of [...directList, ...stakedList]) {
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

          // 4. 处理候选列表：
          //    - DB 已存在且已 closed 的历史空壳 NFT → 直接跳过（0 RPC！）
          //    - DB 已存在但 source 改变（direct ↔ staking）或 wallet_id 更新 → 直接 UPDATE
          //    - DB 不存在的新 tokenId → 并发调 readRange 读取状态，若活跃则 INSERT，若 liquidity=0 则记入 closed 缓存避免下次重读
          let walletNew = 0;
          let walletSourceChanged = 0;
          const unknownCandidates: DiscoveredPosition[] = [];

          for (const dp of finalCandidates) {
            const dex = dexes.find((d) => d.id === dp.dexId);
            if (!dex) continue;
            const existing = existingByKey.get(`${dex.name}:${dp.tokenId}`);
            if (existing) {
              if (existing.notify_state === "closed") {
                // 已知历史空壳 NFT，不再重复发链上请求
                continue;
              }
              if (existing.source !== dp.source) {
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
              // 写入一条 closed 记录，防止后续全盘点时每次都对这个空壳 NFT 发 RPC！
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

          console.log(
            `[fast-discover] wallet ${w.address} chain ${chain.name}: new=${walletNew} source_changed=${walletSourceChanged} closed=${walletClosed} (${
              Date.now() - tWallet0
            }ms)`
          );
        } catch (e: any) {
          chainAllLogsSucceeded = false;
          errors.push(
            `[fast-discover] wallet ${w.address} chain ${chain.name}: ${
              e?.message ?? e
            }`
          );
        }
      }

      // 仅当本链所有 getLogs 均成功时才推进区块游标并持久化到 SQLite
      if (chainAllLogsSucceeded) {
        opts.lastBlockByChain[chainIdRef] = latest;
        setSetting(dbBlockKey, latest.toString());
      }
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