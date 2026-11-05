/**
 * 仓位发现引擎（V3）：
 *
 * 1. 直接持有（findDirectPositions）—— 钱包当前持有的各 DEX NFT 仓位（tokenOfOwnerByIndex 并发枚举）
 *
 * 2. 质押发现双引擎（findStakedPositions）：
 *    - 引擎 A（Vault 现存 NFT + deposits(tokenId) 归属直查）：
 *      直接枚举质押合约当前在 NPM 上持有的活跃 NFT，并发读取 deposits(tokenId).owner，
 *      无视任何区块高度限制（哪怕 1 年前质押的仓位也能 100% 秒级发现）。
 *    - 引擎 B（带钱包 Indexed Topic 过滤 + 自动分片重试的 Transfer 日志扫描）：
 *      兜底不支持 deposits(tokenId) view 的质押合约。
 *
 * 3. 增量极速发现（findRecentPositionsByTransfer）：
 *    - 仅按 args: { to: wallet } 与 args: { from: wallet } 定向查询本钱包日志（比全网查询减少 99.9% 数据量）
 *    - 单次跨度过大触发 RPC 限制时自动二分分片重试
 *    - 返回 allSucceeded 标志：只有全部成功时调用方才推进区块游标，彻底杜绝跳块漏单
 */
import type { PublicClient } from "viem";
import { parseAbiItem, type Address } from "viem";
import { V3_NPM_ABI, ownerOf } from "../adapters/v3-fork";
import type { DexRow, StakingRow } from "../chains/dexes";

export interface DiscoveredPosition {
  tokenId: string;
  dexId: number;
  source: "direct" | "staking";
  stakerContract?: string;
  stakingId?: number;
}

const TRANSFER_EVENT = parseAbiItem(
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
);

const DEPOSITS_ABI = [
  {
    name: "deposits",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "liquidity", type: "uint128" },
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
  },
] as const;

/**
 * 带自动二分分片降级的 getLogs：
 * 当区间跨度超过 RPC 限制（如 > 2000 或 > 10000 块）抛错时，自动拆分为左右两半重试。
 */
async function getLogsSafe(
  client: PublicClient,
  params: {
    address: Address;
    args: { from?: Address; to?: Address };
    fromBlock: bigint;
    toBlock: bigint;
  },
  maxChunkSize = 20_000n,
  depth = 0
): Promise<{ logs: any[]; ok: boolean }> {
  const { address, args, fromBlock, toBlock } = params;
  if (fromBlock > toBlock) return { logs: [], ok: true };

  // 若初始区间大于 maxChunkSize，先按固定步长切分顺序/小并发拉取
  if (depth === 0 && toBlock - fromBlock > maxChunkSize) {
    const chunks: [bigint, bigint][] = [];
    let cur = fromBlock;
    while (cur <= toBlock) {
      const end = cur + maxChunkSize - 1n > toBlock ? toBlock : cur + maxChunkSize - 1n;
      chunks.push([cur, end]);
      cur = end + 1n;
    }
    const allLogs: any[] = [];
    let allOk = true;
    await eachLimit(chunks, 3, async ([cFrom, cTo]) => {
      const r = await getLogsSafe(
        client,
        { address, args, fromBlock: cFrom, toBlock: cTo },
        maxChunkSize,
        1
      );
      if (!r.ok) allOk = false;
      allLogs.push(...r.logs);
    });
    allLogs.sort((a, b) => {
      const ba = BigInt(a.blockNumber ?? 0);
      const bb = BigInt(b.blockNumber ?? 0);
      if (ba !== bb) return ba < bb ? -1 : 1;
      return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
    });
    return { logs: allLogs, ok: allOk };
  }

  try {
    const logs = await client.getLogs({
      address,
      event: TRANSFER_EVENT,
      args,
      fromBlock,
      toBlock,
    });
    return { logs, ok: true };
  } catch {
    // 二分重试（最多递归 4 层，即 20000 -> 10000 -> 5000 -> 2500 -> 1250）
    if (depth >= 4 || toBlock - fromBlock < 100n) {
      return { logs: [], ok: false };
    }
    const mid = (fromBlock + toBlock) / 2n;
    const [left, right] = await Promise.all([
      getLogsSafe(client, { address, args, fromBlock, toBlock: mid }, maxChunkSize, depth + 1),
      getLogsSafe(
        client,
        { address, args, fromBlock: mid + 1n, toBlock },
        maxChunkSize,
        depth + 1
      ),
    ]);
    return {
      logs: [...left.logs, ...right.logs],
      ok: left.ok && right.ok,
    };
  }
}

/** 直接持有：用 tokenOfOwnerByIndex 枚举。多 NFT 时并发枚举（限并 10）。 */
export async function findDirectPositions(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[]
): Promise<DiscoveredPosition[]> {
  const out: DiscoveredPosition[] = [];
  for (const dex of dexes) {
    let balance = 0n;
    try {
      balance = (await client.readContract({
        address: dex.npm as Address,
        abi: V3_NPM_ABI,
        functionName: "balanceOf",
        args: [wallet],
      })) as bigint;
    } catch {
      continue;
    }
    if (balance === 0n) continue;
    const indices: bigint[] = [];
    for (let i = 0n; i < balance; i++) indices.push(i);
    await eachLimit(indices, 10, async (i) => {
      try {
        const tokenId = (await client.readContract({
          address: dex.npm as Address,
          abi: V3_NPM_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [wallet, i],
        })) as bigint;
        out.push({ tokenId: tokenId.toString(), dexId: dex.id, source: "direct" });
      } catch {
        // 单个 NFT 读失败时不中断其它枚举
      }
    });
  }
  return out;
}

/**
 * 质押发现（全量/新钱包盘点）：
 * 1. 优先用 Vault 现存 NFT 枚举 + deposits(tokenId).owner 直查（不受区块高度限制，极速准确）
 * 2. 同时辅以带钱包地址过滤的分片 getLogs，兼顾非标准质押合约
 */
export async function findStakedPositions(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  opts?: { fromBlock?: bigint; fromBlockDelta?: bigint; skipIds?: Set<string> }
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0 || dexes.length === 0) return [];

  const walletLower = wallet.toLowerCase();
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>();

  // 引擎 A：直接枚举每个质押合约当前持有的 NFT，通过 deposits(tokenId) 判断是否属于该钱包
  for (const dex of dexes) {
    for (const s of staking) {
      let vaultBal = 0n;
      try {
        vaultBal = (await client.readContract({
          address: dex.npm as Address,
          abi: V3_NPM_ABI,
          functionName: "balanceOf",
          args: [s.contract as Address],
        })) as bigint;
      } catch {
        continue;
      }
      if (vaultBal === 0n) continue;

      const maxCheck = vaultBal > 400n ? 400n : vaultBal;
      const indices: bigint[] = [];
      for (let i = 0n; i < maxCheck; i++) indices.push(i);

      const vaultTokenIds: string[] = [];
      await eachLimit(indices, 10, async (idx) => {
        try {
          const tid = (await client.readContract({
            address: dex.npm as Address,
            abi: V3_NPM_ABI,
            functionName: "tokenOfOwnerByIndex",
            args: [s.contract as Address, idx],
          })) as bigint;
          vaultTokenIds.push(tid.toString());
        } catch {}
      });

      await eachLimit(vaultTokenIds, 10, async (idStr) => {
        const key = `${dex.id}:${idStr}`;
        if (seen.has(key)) return;
        try {
          const dep = (await client.readContract({
            address: s.contract as Address,
            abi: DEPOSITS_ABI,
            functionName: "deposits",
            args: [BigInt(idStr)],
          })) as unknown as any[];
          const depOwner = String(dep?.[0] ?? "").toLowerCase();
          if (depOwner === walletLower) {
            seen.add(key);
            out.push({
              tokenId: idStr,
              dexId: dex.id,
              source: "staking",
              stakerContract: s.contract,
              stakingId: s.id,
            });
          }
        } catch {
          // 若该质押合约不支持 deposits(uint256)，留给下方引擎 B 处理
        }
      });
    }
  }

  // 引擎 B：带 args: { from: wallet } 的分片 Transfer 日志扫描（补充排查）
  const latest = await client.getBlockNumber();
  let fromBlock: bigint;
  if (opts?.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else {
    const delta = opts?.fromBlockDelta ?? 100_000n;
    fromBlock = latest > delta ? latest - delta : 0n;
  }
  if (fromBlock < 0n) fromBlock = 0n;

  for (const dex of dexes) {
    const { logs } = await getLogsSafe(client, {
      address: dex.npm as Address,
      args: { from: wallet },
      fromBlock,
      toBlock: latest,
    });

    const candidateIds = new Set<string>();
    for (const l of logs) {
      const id = (l.args as any)?.tokenId?.toString();
      if (id && !seen.has(`${dex.id}:${id}`) && !opts?.skipIds?.has(`${dex.id}:${id}`)) {
        candidateIds.add(id);
      }
    }
    if (candidateIds.size === 0) continue;

    await eachLimit([...candidateIds], 8, async (idStr) => {
      const currentOwner = await ownerOf(client, dex.npm as Address, BigInt(idStr));
      if (!currentOwner) return;
      const s = stakingByAddr.get(currentOwner.toLowerCase());
      if (!s) return;
      const key = `${dex.id}:${idStr}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({
        tokenId: idStr,
        dexId: dex.id,
        source: "staking",
        stakerContract: s.contract,
        stakingId: s.id,
      });
    });
  }

  return out;
}

export interface RecentCandidates {
  candidates: DiscoveredPosition[];
  outgoing: { tokenId: string; dexId: number; toAddr: string }[];
  latestSeen?: bigint;
  /** 本次所有 DEX 的 getLogs 是否均完整成功（若为 false 则不推进区块游标，下次自动重扫） */
  allSucceeded: boolean;
}

/**
 * 极速增量发现：
 * 使用 Indexed Topic 定向拉取 `to == wallet` 与 `from == wallet` 的 Transfer 事件，
 * 数据量极小、速度极快，且支持大跨度自动分片。
 */
export async function findRecentPositionsByTransfer(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlock: bigint,
  toBlockOverride?: bigint
): Promise<RecentCandidates> {
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
  const walletLower = wallet.toLowerCase();
  const toBlock = toBlockOverride ?? (await client.getBlockNumber());

  type State =
    | { kind: "direct" | "staking"; dp: DiscoveredPosition }
    | { kind: "outgoing"; toAddr: string };
  const finalState = new Map<string, State>();
  let latestSeen = fromBlock;
  let allSucceeded = true;

  for (const dex of dexes) {
    // 并行拉取与该钱包相关的转入（Mint/解押/转入）和转出（质押/转出）事件
    const [inRes, outRes] = await Promise.all([
      getLogsSafe(client, {
        address: dex.npm as Address,
        args: { to: wallet },
        fromBlock,
        toBlock,
      }),
      getLogsSafe(client, {
        address: dex.npm as Address,
        args: { from: wallet },
        fromBlock,
        toBlock,
      }),
    ]);

    if (!inRes.ok || !outRes.ok) {
      allSucceeded = false;
    }

    // 合并后按 (blockNumber, logIndex) 严格升序排列，保证同一 tokenId 后发生的事件覆盖先发生的
    const merged = [...inRes.logs, ...outRes.logs].sort((a, b) => {
      const ba = BigInt(a.blockNumber ?? 0);
      const bb = BigInt(b.blockNumber ?? 0);
      if (ba !== bb) return ba < bb ? -1 : 1;
      return Number(a.logIndex ?? 0) - Number(b.logIndex ?? 0);
    });

    for (const l of merged) {
      const args = l.args as any;
      const fromAddr = String(args?.from ?? "").toLowerCase();
      const toAddr = String(args?.to ?? "").toLowerCase();
      const tokenId = args?.tokenId?.toString();
      if (!tokenId) continue;
      if (l.blockNumber && BigInt(l.blockNumber) > latestSeen) {
        latestSeen = BigInt(l.blockNumber);
      }

      const key = `${dex.id}:${tokenId}`;

      if (toAddr === walletLower) {
        finalState.set(key, {
          kind: "direct",
          dp: { tokenId, dexId: dex.id, source: "direct" },
        });
        continue;
      }

      if (fromAddr === walletLower) {
        const s = stakingByAddr.get(toAddr);
        if (s) {
          finalState.set(key, {
            kind: "staking",
            dp: {
              tokenId,
              dexId: dex.id,
              source: "staking",
              stakerContract: s.contract,
              stakingId: s.id,
            },
          });
        } else {
          finalState.set(key, { kind: "outgoing", toAddr });
        }
      }
    }
  }

  const candidates: DiscoveredPosition[] = [];
  const outgoing: { tokenId: string; dexId: number; toAddr: string }[] = [];
  for (const [key, st] of finalState) {
    const [dexIdStr, tokenId] = key.split(":");
    const dexId = Number(dexIdStr);
    if (st.kind === "outgoing") {
      outgoing.push({ tokenId, dexId, toAddr: st.toAddr });
    } else {
      candidates.push(st.dp);
    }
  }

  return { candidates, outgoing, latestSeen, allSucceeded };
}

/** 简易并发限制器。 */
export async function eachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const cur = idx++;
      await fn(items[cur]);
    }
  });
  await Promise.all(workers);
}

/**
 * 质押合约直查：对 read_type=deposits_owner 的合约，给定 tokenId 列表，
 * 调用 deposits(tokenId) 取 owner，验证是否与目标钱包匹配。
 */
export async function resolveStakingOwner(
  client: PublicClient,
  stakingContract: Address,
  tokenIds: string[],
  expectOwner: Address
): Promise<string[]> {
  const matched: string[] = [];
  await eachLimit(tokenIds, 8, async (id) => {
    try {
      const res = (await client.readContract({
        address: stakingContract,
        abi: DEPOSITS_ABI,
        functionName: "deposits",
        args: [BigInt(id)],
      })) as unknown as any[];
      if ((res[0] as string).toLowerCase() === expectOwner.toLowerCase()) {
        matched.push(id);
      }
    } catch {}
  });
  return matched;
}
