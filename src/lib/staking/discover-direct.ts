/**
 * 质押扫描 - 合约直查方式
 * 
 * 核心逻辑：
 * 1. 对每个启用的质押合约，在对应的 DEX NPM 上枚举该质押合约持有的 NFT
 * 2. 用 deposits(tokenId) 验证每个 NFT 是否属于目标钱包
 * 
 * 关键：balanceOf / tokenOfOwnerByIndex 必须在 DEX 的 NPM 地址上调用，
 * 而不是在质押合约地址上调用——质押合约是 NFT 的持有者，不是 ERC721 合约本身。
 */

import type { PublicClient } from "viem";
import type { DexRow, StakingRow } from "../chains/dexes";
import { getStakingConcurrentLimit, getContractBatchSize } from "../settings";

export interface DiscoveredPosition {
  tokenId: string;
  dexId: number;
  source: "direct" | "staking";
  stakerContract?: string;
  stakingId?: number;
}

/**
 * 合约直查方式：在 DEX NPM 上枚举质押合约持有的 NFT，然后验证 owner
 */
export async function findStakedPositionsDirect(
  client: PublicClient,
  wallet: `0x${string}`,
  dexes: DexRow[],
  staking: StakingRow[]
): Promise<DiscoveredPosition[]> {
  if (staking.length === 0 || dexes.length === 0) return [];

  const out: DiscoveredPosition[] = [];
  const seen = new Set<string>();

  for (const stake of staking) {
    if (!stake.contract || stake.read_type !== "deposits_owner") continue;

    // 优先用质押合约显式关联的 DEX，未关联时回退到同链第一个 DEX
    const dex = stake.dex_id != null
      ? dexes.find(d => d.id === stake.dex_id)
      : dexes.find(d => d.chain_id_ref === stake.chain_id_ref);
    if (!dex) continue;

    try {
      const positions = await scanContractPositions(
        client,
        dex.npm as `0x${string}`,  // NPM 地址：NFT 合约
        stake.contract as `0x${string}`, // 质押合约地址：NFT 持有者
        wallet,
        stake.id,
        dex.id,
        getContractBatchSize()
      );

      for (const pos of positions) {
        const key = `${pos.dexId}:${pos.tokenId}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(pos);
        }
      }
    } catch (error) {
      console.warn(`扫描质押合约 ${stake.contract} 失败:`, error);
    }
  }

  return out;
}

/**
 * 扫描单个质押合约的NFT
 * @param npmAddr   DEX 的 NonfungiblePositionManager 地址（ERC721 合约）
 * @param stakerAddr 质押合约地址（NFT 的持有者）
 */
async function scanContractPositions(
  client: PublicClient,
  npmAddr: `0x${string}`,
  stakerAddr: `0x${string}`,
  targetWallet: `0x${string}`,
  stakingId: number,
  dexId: number,
  batchSize: number
): Promise<DiscoveredPosition[]> {
  const positions: DiscoveredPosition[] = [];

  try {
    // 在 NPM 上查质押合约持有的 NFT 数量
    const balance = await client.readContract({
      address: npmAddr,
      abi: [
        {
          name: "balanceOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "owner", type: "address" }],
          outputs: [{ name: "balance", type: "uint256" }],
        }
      ],
      functionName: "balanceOf",
      args: [stakerAddr]
    }) as bigint;

    if (balance === 0n) return positions;

    // 在 NPM 上枚举质押合约持有的所有 NFT
    const allTokenIds: string[] = [];
    for (let i = 0n; i < balance; i++) {
      try {
        const tokenId = await client.readContract({
          address: npmAddr,
          abi: [
            {
              name: "tokenOfOwnerByIndex",
              type: "function",
              stateMutability: "view",
              inputs: [
                { name: "owner", type: "address" },
                { name: "index", type: "uint256" }
              ],
              outputs: [{ name: "tokenId", type: "uint256" }],
            }
          ],
          functionName: "tokenOfOwnerByIndex",
          args: [stakerAddr, i]
        }) as bigint;

        allTokenIds.push(tokenId.toString());
      } catch (error) {
        break; // 可能到达合约NFT边界
      }
    }

    // 分批验证 tokenId 是否属于目标钱包
    const batches = [];
    for (let i = 0; i < allTokenIds.length; i += batchSize) {
      batches.push(allTokenIds.slice(i, i + batchSize));
    }

    await Promise.all(
      batches.map(batch =>
        verifyTokenBatch(client, stakerAddr, batch, targetWallet, dexId, stakingId, positions)
      )
    );

  } catch (error) {
    console.warn(`扫描合约 ${stakerAddr} 时出错:`, error);
  }

  return positions;
}

/**
 * 验证一批 tokenId 是否属于目标钱包（通过 deposits(tokenId) 查 owner）
 */
async function verifyTokenBatch(
  client: PublicClient,
  contract: `0x${string}`,
  tokenIds: string[],
  targetWallet: `0x${string}`,
  dexId: number,
  stakingId: number,
  result: DiscoveredPosition[]
): Promise<void> {
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

  const concurrentLimit = getStakingConcurrentLimit();
  const chunks = [];
  for (let i = 0; i < tokenIds.length; i += concurrentLimit) {
    chunks.push(tokenIds.slice(i, i + concurrentLimit));
  }

  for (const chunk of chunks) {
    const promises = chunk.map(async (idStr) => {
      try {
        const res = await client.readContract({
          address: contract,
          abi,
          functionName: "deposits",
          args: [BigInt(idStr)],
        }) as unknown as any[];

        if ((res[0] as string).toLowerCase() === targetWallet.toLowerCase()) {
          result.push({
            tokenId: idStr,
            dexId,
            source: "staking",
            stakerContract: contract,
            stakingId,
          });
        }
      } catch (error) {
        // 该合约可能不支持 deposits(uint256) 签名，忽略
      }
    });

    await Promise.all(promises);
  }
}
