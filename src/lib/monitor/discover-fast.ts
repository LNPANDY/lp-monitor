/**
 * 快速发现（fast discover）—— 只负责"发现新仓位 + 标 closed 转出的"。
 *
 * 与 known-positions-scanner 配合：
 *   1. fast discover 扫窗口内 Transfer 事件 → 调 adapter.readRange 拿完整状态 + 加 resolveTokens 拿 symbol
 *      → INSERT 完整字段（token0/token1/symbol/fee/pool/tickLower/Upper/liquidity/margin/notify_state）
 *      首次直接写入真实状态（last_margin_lower/upper 用 readRange 计算值），避免 known 下次扫到 baseline=0 触发假 tick_move 告警
 *   2. DB 已有的仓位 source 变化（direct ↔ staking）→ UPDATE source/staker_contract/staking_id
 *   3. outgoing 转出场景 → ownerOf 反查 → 标 closed
 *
 * 之后 known 扫描会扫到新 INSERT 的占位行（notify_state 已是 in_range/out_of_range 而非 unknown），
 * 但因为 prev.last_margin_lower 已经有真实值，tick_move 不会因为 0→真实值 触发假告警。
 *
 * 配合调度器维护 lastBlockByChain（窗口推进）+ blockTimeByChain（首次窗口换算）状态。
 */
import { getDb } from "../db";
import { getClient } from "../chains";
import { listDexes, listStaking, type DexRow, type StakingRow } from "../chains/dexes";
import { findRecentPositionsByTransfer, type DiscoveredPosition } from "../staking/discover";
import { ownerOf } from "../adapters/v3-fork";
import { getAdapter } from "../adapters";
import { estimateBlockTimeSec, secondsToBlocks } from "../chains/blocktime";
import { getFullScanFirstHours, getFullScanPaddingSec } from "../db/settings";
import { resolveTokens } from "../chains/tokens";
import type { Address, PublicClient } from "viem";

export interface FastDiscoverSummary {
  /** 本次窗口区块区间（按链） */
  windows: { chainId: number; from: string; to: string; blocks: number }[];
  /** 候选列表分类计数 */
  candidatesCount: number;
  directCount: number;
  stakingCount: number;
  outgoingCount: number;
  /** DB 新增占位行数 */
  newInserted: number;
  /** source 变更数（direct ↔ staking）*/
  sourceChanged: number;
  /** 标 closed 数 */
  closed: number;
  durationMs: number;
  errors: string[];
}

/**
 * 执行一次 fast discover。状态 lastBlockByChain / blockTimeByChain / isFirstScan
 * 由调用方（调度器）维护并传入；本函数会在内部直接更新这两个对象。
 */
export async function runFastDiscover(opts: {
  lastBlockByChain: Record<number, bigint>;
  blockTimeByChain: Record<number, number>;
  isFirstScan: boolean;
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

  // 取所有需要扫描的链（有 enabled 钱包的链）
  const chains = db
    .prepare(
      `SELECT DISTINCT w.chain_id_ref FROM wallets w WHERE w.enabled=1`
    )
    .all() as { chain_id_ref: number }[];

  const firstHours = getFullScanFirstHours();
  const paddingSec = getFullScanPaddingSec();

  for (const { chain_id_ref: chainIdRef } of chains) {
    try {
      const { client, chain } = getClient(chainIdRef);
      const dexes = listDexes(chainIdRef, true);
      const staking = listStaking(chainIdRef, true);

      // 取最新块
      const latest = await client.getBlockNumber();

      // 出块时间缓存（首次探测）
      let blockTime = opts.blockTimeByChain[chainIdRef];
      if (!blockTime) {
        blockTime = await estimateBlockTimeSec(client);
        opts.blockTimeByChain[chainIdRef] = blockTime;
      }

      // 算 fromBlock
      let fromBlock: bigint;
      if (opts.isFirstScan) {
        const firstBlocks = secondsToBlocks(firstHours * 3600, blockTime);
        fromBlock = latest > firstBlocks ? latest - firstBlocks : 0n;
        const fromSec = Number(firstBlocks) * blockTime;
        console.log(`[fast-discover] chain ${chain.name} (id=${chainIdRef}) first scan: from=${fromBlock} to=${latest} (~${firstBlocks} blocks, ~${fromSec.toFixed(0)}s = ${firstHours}h, blockTime=${blockTime.toFixed(2)}s)`);
      } else {
        const lastBlock = opts.lastBlockByChain[chainIdRef] ?? latest;
        const paddingBlocks = secondsToBlocks(paddingSec, blockTime);
        fromBlock = lastBlock > paddingBlocks ? lastBlock - paddingBlocks : 0n;
        const windowBlocks = latest - fromBlock;
        console.log(`[fast-discover] chain ${chain.name} (id=${chainIdRef}): from=${fromBlock} to=${latest} (~${windowBlocks} blocks, padding=${paddingSec}s, blockTime=${blockTime.toFixed(2)}s)`);
      }
      windows.push({ chainId: chainIdRef, from: fromBlock.toString(), to: latest.toString(), blocks: Number(latest - fromBlock) });

      // 取该链所有钱包
      const wallets = db
        .prepare("SELECT id, address FROM wallets WHERE chain_id_ref=? AND enabled=1")
        .all(chainIdRef) as { id: number; address: string }[];

      const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
      const nowIso = new Date().toISOString();

      for (const w of wallets) {
        try {
          const tWallet0 = Date.now();
          const walletLower = w.address.toLowerCase();

          // 1. transfer 扫描
          const cands = await findRecentPositionsByTransfer(
            client, w.address as Address, dexes, staking, fromBlock
          );

          const stakingCnt = cands.candidates.filter(c => c.source === "staking").length;
          const dCnt = cands.candidates.length - stakingCnt;
          candidatesCount += cands.candidates.length;
          directCount += dCnt;
          stakingCount += stakingCnt;
          outgoingCount += cands.outgoing.length;

          // 2. outgoing: from=钱包 转出 → DB 已存在则 ownerOf 反查标 closed
          let walletClosed = 0;
          for (const out of cands.outgoing) {
            const dex = dexes.find((d) => d.id === out.dexId);
            if (!dex) continue;
            const existing = db
              .prepare("SELECT id, notify_state FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
              .get(chainIdRef, dex.name, out.tokenId) as { id: number; notify_state: string } | undefined;
            if (!existing) continue;
            if (existing.notify_state === "closed") continue;
            let currentOwner: string | null = null;
            try {
              currentOwner = await ownerOf(client, dex.npm as Address, BigInt(out.tokenId));
            } catch {
              continue;
            }
            if (!currentOwner) continue;
            const ownerLower = currentOwner.toLowerCase();
            if (ownerLower === walletLower) continue;
            if (stakingByAddr.has(ownerLower)) continue;
            db.prepare(
              `UPDATE positions SET notify_state='closed', last_checked_at=?, last_in_range=0 WHERE id=?`
            ).run(nowIso, existing.id);
            closedCount++;
            walletClosed++;
          }

          // 3. candidates: DB 不存在的新仓位 → 调 readRange + resolveTokens 拿完整状态 → INSERT 完整字段
          //    DB 已有但 source 变了（direct ↔ staking） → UPDATE source/staker_contract/staking_id
          let walletNew = 0;
          let walletSourceChanged = 0;
          for (const dp of cands.candidates) {
            const dex = dexes.find((d) => d.id === dp.dexId);
            if (!dex) continue;
            const existing = db
              .prepare("SELECT id, notify_state, source FROM positions WHERE chain_id_ref=? AND dex_name=? AND token_id=?")
              .get(chainIdRef, dex.name, dp.tokenId) as { id: number; notify_state: string; source: string } | undefined;
            if (existing) {
              if (existing.source !== dp.source) {
                db.prepare(
                  `UPDATE positions SET source=?, staker_contract=?, staking_id=?, last_checked_at=? WHERE id=?`
                ).run(dp.source, dp.stakerContract ?? "", dp.stakingId ?? null, nowIso, existing.id);
                sourceChanged++;
                walletSourceChanged++;
              }
              continue;
            }
            // DB 不存在 → 用 adapter.readRange 拿完整状态
            const adapter = getAdapter(dex.type);
            const r = await adapter.readRange(client, { factory: dex.factory, npm: dex.npm }, BigInt(dp.tokenId));
            if (r.kind === "unreadable") {
              // 只更新 last_checked_at 留给以后 readRange 成功时 INSERT；DB 没记录时不写
              continue;
            }
            if (r.kind === "closed") {
              // 仓位已无流动性，不 INSERT 进 positions 表（INSERT 会在每次发现都重复，
              // 而流动性为 0 的仓位没有监控意义）。只记录日志。
              console.log(`[fast-discover] chain ${chain.name} ${dex.name} #${dp.tokenId}: closed (skip INSERT)`);
              continue;
            }

            // r.kind === "ok"，拿 symbol
            const tokenMap = await resolveTokens(client, chainIdRef, [r.token0, r.token1]);
            const sym0 = tokenMap.get(r.token0.toLowerCase())?.symbol ?? "";
            const sym1 = tokenMap.get(r.token1.toLowerCase())?.symbol ?? "";
            const dec0 = tokenMap.get(r.token0.toLowerCase())?.decimals ?? 18;
            const dec1 = tokenMap.get(r.token1.toLowerCase())?.decimals ?? 18;

            const inRange = r.status.inRange;
            const span = Math.max(r.tickUpper - r.tickLower, 1);
            const marginLower = (r.status.currentTick - r.tickLower) / span;
            const marginUpper = (r.tickUpper - r.status.currentTick) / span;

            // 把 raw price 换算成整币单位价格（与 scanner.ts 的 rawToHumanPrice 等价）
            const price0HumanStr = rawToHumanPrice(r.status.price, dec0, dec1);

            // INSERT 完整字段。新仓位首次录入直接用真实 margin 作 baseline（避免 known 触发假 tick_move）
            db.prepare(
              `INSERT INTO positions
                (wallet_id, chain_id_ref, dex_id, dex_name, token_id, token0, token1, token0_symbol, token1_symbol, fee, pool,
                 tick_lower, tick_upper, source, staker_contract, staking_id,
                 last_current_tick, last_in_range, last_price0, last_liquidity,
                 last_margin_lower, last_margin_upper, last_cex_price,
                 last_checked_at, notify_state, last_notified_at, pair_flip)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
            ).run(
              w.id, chainIdRef, dex.id, dex.name, dp.tokenId,
              r.token0, r.token1, sym0, sym1, r.fee, r.status.pool,
              r.tickLower, r.tickUpper, dp.source, dp.stakerContract ?? "", dp.stakingId ?? null,
              r.status.currentTick, inRange ? 1 : 0, price0HumanStr, r.liquidity?.toString() ?? "",
              marginLower, marginUpper, "",
              nowIso, inRange ? "in_range" : "out_of_range", "", 0
            );
            newInserted++;
            walletNew++;
          }

          console.log(`[fast-discover] wallet ${w.address} chain ${chain.name}: new=${walletNew} source_changed=${walletSourceChanged} closed=${walletClosed} (${Date.now()-tWallet0}ms)`);
        } catch (e: any) {
          errors.push(`[fast-discover] wallet ${w.address} chain ${chain.name}: ${e?.message ?? e}`);
        }
      }

      // 更新 lastBlockByChain（本次窗口扫描已完成，下次从 latest 起）
      opts.lastBlockByChain[chainIdRef] = latest;
    } catch (e: any) {
      errors.push(`[fast-discover] chain ${chainIdRef}: ${e?.message ?? e}`);
    }
  }

  const durationMs = Date.now() - startedAt;
  console.log(`[fast-discover] done: candidates=${candidatesCount} (direct=${directCount}, staking=${stakingCount}), outgoing=${outgoingCount}, new=${newInserted}, source_changed=${sourceChanged}, closed=${closedCount}, ${durationMs}ms`);
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

/**
 * raw 价（1 raw token0 = N raw token1）→ 整币单位价（1 整币 token0 = N 整币 token1）。
 * 与 scanner.ts 的 rawToHumanPrice 完全等价，复制避免跨模块依赖。
 */
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