/**
 * 仓位发现引擎（V3）：
 *
 * 1. 批量增量极速发现（findRecentPositionsForWallets）：
 *    - 同一条链上的所有启用钱包合并为一次 `args: { to: wallets }` + `args: { from: wallets }` Topic 过滤查询
 *    - 单次窗口默认仅几秒~几十秒（几十个区块），1 次 RPC 即可完成整条链所有钱包的新增/质押/解押/转出检测
 *    - `maxChunkSize = 1000n` 适配 0G Mainnet 等严苛公共 RPC 的 getLogs 区块跨度限制，零报错重试开销
 *
 * 2. 直接持有（findDirectPositions）：
 *    - 仅用于新钱包首次入库时检查尾部最新最多 15 个 NFT（避免 ZIA DEX 等不销毁历史空壳 NFT 导致枚举上百次）
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
 * 带小步长分片（默认 1000 块）与二分降级的 getLogs：
 * 0G Mainnet 等节点的 eth_getLogs 单次最大跨度通常为 1000~2000 块，
 * 直接按 1000 块切分可避免大跨度请求先报错再递归重试浪费数秒等待时间。
 */
export async function getLogsSafe(
  client: PublicClient,
  params: {
    address: Address;
    args: { from?: Address | Address[]; to?: Address | Address[] };
    fromBlock: bigint;
    toBlock: bigint;
  },
  maxChunkSize = 1_000n,
  depth = 0
): Promise<{ logs: any[]; ok: boolean }> {
  const { address, args, fromBlock, toBlock } = params;
  if (fromBlock > toBlock) return { logs: [], ok: true };

  if (depth === 0 && toBlock - fromBlock > maxChunkSize) {
    const chunks: [bigint, bigint][] = [];
    let cur = fromBlock;
    while (cur <= toBlock) {
      const end =
        cur + maxChunkSize - 1n > toBlock ? toBlock : cur + maxChunkSize - 1n;
      chunks.push([cur, end]);
      cur = end + 1n;
    }
    const allLogs: any[] = [];
    let allOk = true;
    await eachLimit(chunks, 4, async ([cFrom, cTo]) => {
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
      args: args as any,
      fromBlock,
      toBlock,
    });
    return { logs, ok: true };
  } catch {
    if (depth >= 3 || toBlock - fromBlock < 50n) {
      return { logs: [], ok: false };
    }
    const mid = (fromBlock + toBlock) / 2n;
    const [left, right] = await Promise.all([
      getLogsSafe(
        client,
        { address, args, fromBlock, toBlock: mid },
        maxChunkSize,
        depth + 1
      ),
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

/**
 * 直接持有：用 tokenOfOwnerByIndex 枚举。
 * 注意：在 ZIA DEX 等不 burn 已平仓 NFT 的合约上，老钱包可能有上百个历史空壳 NFT，
 * 而新 Mint 的 NFT 永远追加在尾部（index 最大的位置），因此默认只取尾部最新 maxTail 个（默认 20）。
 */
export async function findDirectPositions(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  maxTail = 20
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
    const startIdx =
      balance > BigInt(maxTail) ? balance - BigInt(maxTail) : 0n;
    const indices: bigint[] = [];
    for (let i = startIdx; i < balance; i++) indices.push(i);
    await eachLimit(indices, 8, async (i) => {
      try {
        const tokenId = (await client.readContract({
          address: dex.npm as Address,
          abi: V3_NPM_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [wallet, i],
        })) as bigint;
        out.push({
          tokenId: tokenId.toString(),
          dexId: dex.id,
          source: "direct",
        });
      } catch {
        // 单个 NFT 读失败时不中断其它枚举
      }
    });
  }
  return out;
}

/**
 * 质押发现（兼容 scanner.ts 调用）：基于带钱包过滤的 Transfer 日志 + ownerOf 确认。
 */
export async function findStakedPositions(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  opts?: { fromBlock?: bigint; fromBlockDelta?: bigint; skipIds?: Set<string> }
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0 || dexes.length === 0) return [];

  const stakingByAddr = new Map(
    staking.map((s) => [s.contract.toLowerCase(), s])
  );
  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>();

  const latest = await client.getBlockNumber();
  let fromBlock: bigint;
  if (opts?.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else {
    const delta = opts?.fromBlockDelta ?? 2_000n;
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
      if (
        id &&
        !seen.has(`${dex.id}:${id}`) &&
        !opts?.skipIds?.has(`${dex.id}:${id}`)
      ) {
        candidateIds.add(id);
      }
    }
    if (candidateIds.size === 0) continue;

    await eachLimit([...candidateIds], 8, async (idStr) => {
      const currentOwner = await ownerOf(
        client,
        dex.npm as Address,
        BigInt(idStr)
      );
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
  allSucceeded: boolean;
}

/**
 * 整条链多钱包一次性批量增量发现：
 * 对每个 DEX 仅发起 2 次 getLogs（`to: wallets` 与 `from: wallets`），
 * 无论该链配置了 1 个还是 10 个监控钱包，都只需 1 个 RTT！
 */
export async function findRecentPositionsForWallets(
  client: PublicClient,
  wallets: Address[],
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlock: bigint,
  toBlock: bigint
): Promise<{
  byWallet: Map<string, RecentCandidates>;
  allSucceeded: boolean;
}> {
  const byWallet = new Map<string, RecentCandidates>();
  const walletSet = new Set(wallets.map((w) => w.toLowerCase()));
  for (const w of walletSet) {
    byWallet.set(w, {
      candidates: [],
      outgoing: [],
      latestSeen: fromBlock,
      allSucceeded: true,
    });
  }
  if (wallets.length === 0 || dexes.length === 0) {
    return { byWallet, allSucceeded: true };
  }

  const stakingByAddr = new Map(
    staking.map((s) => [s.contract.toLowerCase(), s])
  );

  type State =
    | { kind: "direct" | "staking"; dp: DiscoveredPosition }
    | { kind: "outgoing"; toAddr: string };
  const stateByWallet = new Map<string, Map<string, State>>();
  for (const w of walletSet) {
    stateByWallet.set(w, new Map());
  }

  let allSucceeded = true;
  const walletArg = wallets.length === 1 ? wallets[0] : wallets;

  for (const dex of dexes) {
    const [inRes, outRes] = await Promise.all([
      getLogsSafe(client, {
        address: dex.npm as Address,
        args: { to: walletArg },
        fromBlock,
        toBlock,
      }),
      getLogsSafe(client, {
        address: dex.npm as Address,
        args: { from: walletArg },
        fromBlock,
        toBlock,
      }),
    ]);

    if (!inRes.ok || !outRes.ok) {
      allSucceeded = false;
    }

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

      const key = `${dex.id}:${tokenId}`;

      // 若转入某个监控钱包
      if (walletSet.has(toAddr)) {
        const wState = stateByWallet.get(toAddr)!;
        wState.set(key, {
          kind: "direct",
          dp: { tokenId, dexId: dex.id, source: "direct" },
        });
      }

      // 若从某个监控钱包转出
      if (walletSet.has(fromAddr)) {
        const wState = stateByWallet.get(fromAddr)!;
        const s = stakingByAddr.get(toAddr);
        if (s) {
          wState.set(key, {
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
          wState.set(key, { kind: "outgoing", toAddr });
        }
      }
    }
  }

  for (const [wLower, wMap] of stateByWallet) {
    const entry = byWallet.get(wLower)!;
    entry.allSucceeded = allSucceeded;
    for (const [key, st] of wMap) {
      const [dexIdStr, tokenId] = key.split(":");
      const dexId = Number(dexIdStr);
      if (st.kind === "outgoing") {
        entry.outgoing.push({ tokenId, dexId, toAddr: st.toAddr });
      } else {
        entry.candidates.push(st.dp);
      }
    }
  }

  return { byWallet, allSucceeded };
}

/** 单钱包包装（供外部兼容调用） */
export async function findRecentPositionsByTransfer(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlock: bigint,
  toBlockOverride?: bigint
): Promise<RecentCandidates> {
  const toBlock = toBlockOverride ?? (await client.getBlockNumber());
  const { byWallet } = await findRecentPositionsForWallets(
    client,
    [wallet],
    dexes,
    staking,
    fromBlock,
    toBlock
  );
  return (
    byWallet.get(wallet.toLowerCase()) ?? {
      candidates: [],
      outgoing: [],
      latestSeen: fromBlock,
      allSucceeded: true,
    }
  );
}

/** 简易并发限制器。 */
export async function eachLimit<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) return;
  let idx = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (idx < items.length) {
        const cur = idx++;
        await fn(items[cur]);
      }
    }
  );
  await Promise.all(workers);
}

/**
 * ZIA Vault 1-RPC 极速质押发现：
 * ZiaVault 合约在 Slot 9 维护了 `mapping(address user => uint256[] tokenIds)`，
 * 并暴露只读选择器 `0xa4d5e1ff(address)` 直接返回该钱包当前质押的所有 tokenId 数组。
 * 无需 eth_getLogs 扫块，不受区块跨度限制，1 个并发 RTT 即可100%精确获取所有质押仓位。
 */
export async function findZiaVaultStakedPositions(
  client: PublicClient,
  wallets: Address[],
  dexes: DexRow[],
  staking: StakingRow[]
): Promise<Map<string, DiscoveredPosition[]>> {
  const byWallet = new Map<string, DiscoveredPosition[]>();
  for (const w of wallets) {
    byWallet.set(w.toLowerCase(), []);
  }
  if (wallets.length === 0 || staking.length === 0 || dexes.length === 0) {
    return byWallet;
  }

  const defaultDexId = dexes[0].id;
  const tasks: { walletLower: string; s: StakingRow; dexId: number }[] = [];
  for (const w of wallets) {
    const walletLower = w.toLowerCase();
    for (const s of staking) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(s.contract)) continue;
      const dexId =
        s.dex_id && dexes.some((d) => d.id === s.dex_id)
          ? s.dex_id
          : defaultDexId;
      tasks.push({ walletLower, s, dexId });
    }
  }

  await eachLimit(tasks, 12, async ({ walletLower, s, dexId }) => {
    try {
      const paddedWallet = walletLower.replace(/^0x/, "").padStart(64, "0");
      const data = `0xa4d5e1ff${paddedWallet}` as `0x${string}`;
      const res = await client.call({
        to: s.contract as Address,
        data,
      });
      const hex = res.data;
      if (!hex || hex.length < 130) return;
      const raw = hex.slice(2);
      const count = parseInt(raw.slice(64, 128), 16);
      if (!Number.isFinite(count) || count <= 0 || count > 500) return;
      const list = byWallet.get(walletLower);
      if (!list) return;
      for (let i = 0; i < count; i++) {
        const start = 128 + i * 64;
        const chunk = raw.slice(start, start + 64);
        if (chunk.length < 64) break;
        const tokenId = BigInt("0x" + chunk).toString();
        if (tokenId !== "0") {
          list.push({
            tokenId,
            dexId,
            source: "staking",
            stakerContract: s.contract,
            stakingId: s.id,
          });
        }
      }
    } catch {
      // 非 ZiaVault 合约忽略
    }
  });

  return byWallet;
}

export async function resolveStakingOwner(
  client: PublicClient,
  stakingContract: Address,
  tokenIds: string[],
  expectOwner: Address
): Promise<string[]> {
  const matched: string[] = [];
  const expectLower = expectOwner.toLowerCase();
  await eachLimit(tokenIds, 8, async (id) => {
    // 1. 优先尝试 ZiaVault Slot 7 owner getter: 0x67ba6b53(uint256 tokenId) -> address
    try {
      const paddedId = BigInt(id).toString(16).padStart(64, "0");
      const res = await client.call({
        to: stakingContract,
        data: `0x67ba6b53${paddedId}` as `0x${string}`,
      });
      if (res.data && res.data.length >= 66) {
        const ownerAddr = ("0x" + res.data.slice(-40)).toLowerCase();
        if (ownerAddr === expectLower) {
          matched.push(id);
          return;
        }
        if (ownerAddr !== "0x0000000000000000000000000000000000000000") {
          return;
        }
      }
    } catch {}

    // 2. 降级尝试标准 Uniswap V3 Staker deposits(uint256)
    try {
      const res = (await client.readContract({
        address: stakingContract,
        abi: DEPOSITS_ABI,
        functionName: "deposits",
        args: [BigInt(id)],
      })) as unknown as any[];
      if ((res[0] as string).toLowerCase() === expectLower) {
        matched.push(id);
      }
    } catch {}
  });
  return matched;
}
