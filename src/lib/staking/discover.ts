/**
 * 仓位发现（v2）：
 * 1. 直接持有 —— 钱包当前持有的各 DEX NFT 仓位
 * 2. 质押溯源 —— 三种互补方式：
 *    a) 反向查询（最可靠）：遍历质押合约中记录的仓位，
 *       用 deposits(tokenId).owner 反向匹配钱包地址。
 *       适用于：已知质押合约 + 知道 tokenId 范围的场景。
 *    b) 事件扫描：扫质押合约的 Deposit 事件，筛选出 owner=wallet 的记录。
 *    c) Transfer 扫描兜底：扫钱包历史转出的 NFT，查当前 owner 是否命中质押合约。
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

/** 直接持有：用 tokenOfOwnerByIndex 枚举（标准 ERC721Enumerable，Uniswap NPM 支持）。 */
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
    for (let i = 0n; i < balance; i++) {
      try {
        const tokenId = (await client.readContract({
          address: dex.npm as Address,
          abi: V3_NPM_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [wallet, i],
        })) as bigint;
        out.push({ tokenId: tokenId.toString(), dexId: dex.id, source: "direct" });
      } catch {
        break;
      }
    }
  }
  return out;
}

/**
 * 方式 a)：从质押合约的事件中发现属于该钱包的仓位。
 * 查质押合约发出的 Deposit 事件（tokenDeposited / staked），筛选 owner = wallet。
 * 同时查 Withdraw 事件排除已取出的。
 *
 * 这种方式不依赖 DEX NPM 合约，直接从质押合约本身发现仓位。
 * 适用性：Uniswap V3 Staker、大部分 V3-fork 质押合约都会 emit Deposit/Withdraw 事件。
 */
export async function findStakedPositionsByEvents(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlockDelta = 100_000n
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0 || dexes.length === 0) return [];

  const latest = await client.getBlockNumber();
  const fromBlock = latest > fromBlockDelta ? latest - fromBlockDelta : 0n;

  // 建立 npm 地址 → dexId 映射
  const npmToDex = new Map(dexes.map((d) => [d.npm.toLowerCase(), d]));
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));

  // 尝试多种事件签名（不同质押合约可能用不同事件名）
  const eventSigs = [
    // Uniswap V3 Staker: Deposit(tokenId, owner, ...)
    parseAbiItem("event Deposit(uint256 indexed tokenId, address indexed owner, uint256 liquidity)"),
    // 通用 Staked 事件
    parseAbiItem("event Staked(uint256 indexed tokenId, address indexed user, uint256 amount)"),
    // Uniswap V3 Staker 另一种签名
    parseAbiItem("event Deposit(address indexed sender, uint256 indexed tokenId, uint256 liquidity)"),
  ];

  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>(); // dedup: "stakingId:tokenId"

  for (const s of staking) {
    let found = false;

    for (const sig of eventSigs) {
      // 尝试识别哪个 indexed 参数是 tokenId / owner
      const inputNames = (sig as any).inputs?.map((i: any) => i.name) ?? [];

      let logs: any[] = [];
      try {
        logs = await client.getLogs({
          address: s.contract as Address,
          event: sig,
          fromBlock,
          toBlock: "latest",
        });
      } catch {
        // 该事件签名不匹配此合约，试下一个
        continue;
      }

      for (const log of logs) {
        const args = log.args as any;
        // 尝试从不同位置提取 tokenId 和 owner
        const tokenId = args.tokenId ?? args.id ?? null;
        const owner = args.owner ?? args.user ?? args.sender ?? null;

        if (!tokenId || !owner) continue;
        if ((owner as string).toLowerCase() !== wallet.toLowerCase()) continue;

        // 反查该 tokenId 当前 owner 是否仍是质押合约
        // 找到对应的 DEX
        let matchedDex: DexRow | undefined;
        let currentOwner: string | null = null;

        for (const dex of dexes) {
          const own = await ownerOf(client, dex.npm as Address, BigInt(tokenId));
          if (own) {
            currentOwner = own;
            if (own.toLowerCase() === s.contract.toLowerCase()) {
              matchedDex = dex;
              break;
            }
          }
        }

        if (!matchedDex) continue; // 该 NFT 不属于任何已知 DEX

        const key = `${s.id}:${tokenId.toString()}`;
        if (seen.has(key)) continue;
        seen.add(key);

        out.push({
          tokenId: tokenId.toString(),
          dexId: matchedDex.id,
          source: "staking",
          stakerContract: s.contract,
          stakingId: s.id,
        });
        found = true;
        break; // 该 staking 合约已找到匹配
      }

      if (found) break;
    }
  }

  return out;
}

/**
 * 方式 c)：转账扫描兜底。
 * 扫钱包历史上从自己转出的 ERC721 Transfer 事件，
 * 查这些 tokenId 现在的 owner，若命中「已知质押合约」则建立溯源。
 */
export async function findStakedPositionsByTransfer(
  client: PublicClient,
  wallet: Address,
  dexes: DexRow[],
  staking: StakingRow[],
  fromBlockDelta = 100_000n
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0) return [];
  const stakingByAddr = new Map(staking.map((s) => [s.contract.toLowerCase(), s]));

  const latest = await client.getBlockNumber();
  const fromBlock = latest > fromBlockDelta ? latest - fromBlockDelta : 0n;

  const transferSig = parseAbiItem(
    "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)"
  );

  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>();

  for (const dex of dexes) {
    let logs: any[] = [];
    try {
      logs = await client.getLogs({
        address: dex.npm as Address,
        event: transferSig,
        args: { from: wallet },
        fromBlock,
        toBlock: "latest",
      });
    } catch {
      continue;
    }
    for (const l of logs) {
      const idStr = (l.args as any).tokenId?.toString();
      if (!idStr) continue;
      const currentOwner = await ownerOf(client, dex.npm as Address, BigInt(idStr));
      if (!currentOwner) continue;
      const s = stakingByAddr.get(currentOwner.toLowerCase());
      if (s) {
        const key = `${s.id}:${idStr}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          tokenId: idStr,
          dexId: dex.id,
          source: "staking",
          stakerContract: s.contract,
          stakingId: s.id,
        });
      }
    }
  }
  return out;
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
