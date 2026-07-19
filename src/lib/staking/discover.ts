/**
 * 仓位发现（v3）：
 *
 * 1. 直接持有 —— 钱包当前持有的各 DEX NFT 仓位（tokenOfOwnerByIndex 枚举）
 *
 * 2. 质押溯源 —— 单一可靠方式：转账扫描
 *    扫该钱包历史上「作为转出方」的 ERC721 Transfer 事件，拿到所有曾经流出的 tokenId，
 *    反查每个 tokenId 的当前 owner；若当前 owner 命中「已知质押合约」，则视为该钱包的质押仓位。
 *
 *    这种方式不依赖质押合约的事件签名（各协议签名千差万别，猜测极易失败），
 *    只依赖 ERC721 标准 Transfer 事件（所有 NFT 必然实现），可靠性最高。
 *
 *    为覆盖「很久前质押」的场景：从该仓位首次被发现的区块起，或默认扫最近 N 个块；
 *    若用户知道具体 tokenId，可在前端「手动登记」直接监控（v2 待做）。
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
    // 构造索引数组，用并发限并枚举 tokenId
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
        // 单个 NFT 读失败时不中断其它枚举（balance 与实际 token 数可能出现暂时不一致）
      }
    });
  }
  return out;
}

/**
 * 质押溯源：转账扫描。
 * 并发限制：对每个 DEX 一次 getLogs，再对命中的 tokenId 并发反查 owner（限制并发数）。
 *
 * @param fromBlock 显式指定起始区块（优先使用），用于快速扫描动态窗口
 * @param fromBlockDelta 当未指定 fromBlock 时，从 latest 往前回溯多少块（深度模式默认 100_000）
 */
export async function findStakedPositions(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  opts?: { fromBlock?: bigint; fromBlockDelta?: bigint }
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0 || dexes.length === 0) return [];

  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));

  const latest = await client.getBlockNumber();
  let fromBlock: bigint;
  if (opts?.fromBlock !== undefined) {
    fromBlock = opts.fromBlock;
  } else {
    const delta = opts?.fromBlockDelta ?? 100_000n;
    fromBlock = latest > delta ? latest - delta : 0n;
  }
  if (fromBlock < 0n) fromBlock = 0n;

  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  );

  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>();

  // 每个 DEX 一次 getLogs（按 from=wallet 过滤）
  for (const dex of dexes) {
    let logs: any[] = [];
    try {
      logs = await client.getLogs({
        address: dex.npm as Address,
        event: transferEvent,
        args: { from: wallet },
        fromBlock,
        toBlock: "latest",
      });
    } catch {
      // RPC 可能限制 fromBlock 范围或日志数量，跳过该 DEX
      continue;
    }

    // 收集候选 tokenId（去重）
    const candidateIds = new Set<string>();
    for (const l of logs) {
      const id = (l.args as any).tokenId?.toString();
      if (id) candidateIds.add(id);
    }
    if (candidateIds.size === 0) continue;

    // 反查每个 tokenId 的当前 owner，判断是否质押合约
    const ids = [...candidateIds];
    await eachLimit(ids, 6, async (idStr) => {
      const currentOwner = await ownerOf(client, dex.npm as Address, BigInt(idStr));
      if (!currentOwner) return; // 仓位已销毁
      const s = stakingByAddr.get(currentOwner.toLowerCase());
      if (!s) return; // 不在任何已知质押合约里
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

/** 零地址（Mint 的 from） */
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

export interface RecentCandidates {
  /** 新进钱包的候选：Mint(from=0→钱包) 或 转入(其他→钱包) */
  incoming: DiscoveredPosition[];
  /** 质押转出候选：from=钱包 → to 命中已知质押合约 */
  staking: DiscoveredPosition[];
  /** 转出场景：from=钱包 → to 非质押合约（可能 burn/转移，需标 closed 检查） */
  outgoing: { tokenId: string; dexId: number; toAddr: string }[];
  /** 本次扫描的真实区块范围（最后一个事件所在块，用于下次窗口起点） */
  latestSeen?: bigint;
}

/**
 * 快速扫描：基于 transfer 事件的最近窗口发现新仓位。
 *
 * 对每个 DEX 的 NPM 合约，一次 getLogs 拉窗口内所有 Transfer 事件，
 * 然后在客户端过滤出与本钱包有关的（包括 Mint 的 from=0x0 → to=钱包）：
 *
 *   to==钱包,  from==0x0        → Mint 新建 LP（归类 incoming）
 *   to==钱包,  from!=0x0         → 转入（归类 incoming）
 *   from==钱包, to==质押合约     → 质押（归类 staking，存留监控）
 *   from==钱包, to==其它         → 转出/销毁（归类 outgoing，需 ownerOf 反查确认标 closed）
 *
 * 不再 balanceOf 枚举全部 NFT（避免对历史 NFT 也 readRange）。
 * 不返回 latest 区块以避免多余 RPC：调用方用检出的事件里最大的 blockNumber 即可。
 */
export async function findRecentPositionsByTransfer(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlock: bigint
): Promise<RecentCandidates> {
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));
  const walletLower = wallet.toLowerCase();
  const ZERO_LOWER = ZERO_ADDR.toLowerCase();

  const transferEvent = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  );

  const incoming: DiscoveredPosition[] = [];
  const stakingOut: DiscoveredPosition[] = [];
  const outgoing: { tokenId: string; dexId: number; toAddr: string }[] = [];
  let latestSeen = fromBlock;

  for (const dex of dexes) {
    let logs: any[] = [];
    try {
      logs = await client.getLogs({
        address: dex.npm as Address,
        event: transferEvent,
        fromBlock,
        toBlock: "latest",
      });
    } catch {
      continue; // RPC 限制窗口/数量，跳过该 DEX
    }

    for (const l of logs) {
      const args = l.args as any;
      const fromAddr = String(args.from ?? "").toLowerCase();
      const toAddr = String(args.to ?? "").toLowerCase();
      const tokenId = args.tokenId?.toString();
      if (!tokenId) continue;
      if (l.blockNumber && BigInt(l.blockNumber) > latestSeen) latestSeen = BigInt(l.blockNumber);

      // 与本钱包相关的四种情形
      const walletInvolved = fromAddr === walletLower || toAddr === walletLower;
      if (!walletInvolved) continue;

      if (toAddr === walletLower) {
        // Mint（from=0）或转入：都是 incoming 候选
        incoming.push({ tokenId, dexId: dex.id, source: "direct" });
        continue;
      }
      // fromAddr === walletLower：转出场景
      const s = stakingByAddr.get(toAddr);
      if (s) {
        stakingOut.push({
          tokenId, dexId: dex.id, source: "staking",
          stakerContract: s.contract, stakingId: s.id,
        });
      } else {
        outgoing.push({ tokenId, dexId: dex.id, toAddr: toAddr });
      }
    }
  }

  return { incoming, staking: stakingOut, outgoing, latestSeen };
}

/** 简易并发限制器。 */
async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
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
  const abi = [
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
  const matched: string[] = [];
  for (const id of tokenIds) {
    try {
      const res = (await client.readContract({
        address: stakingContract,
        abi,
        functionName: "deposits",
        args: [BigInt(id)],
      })) as unknown as any[];
      if ((res[0] as string).toLowerCase() === expectOwner.toLowerCase()) {
        matched.push(id);
      }
    } catch {
      // 该合约可能不支持 deposits(uint256) 签名，忽略
    }
  }
  return matched;
}
