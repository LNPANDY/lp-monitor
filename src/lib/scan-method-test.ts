/**
 * 质押扫描方式对比测试
 * 
 * 1. 转账扫描方式（当前使用）：扫描历史Transfer事件，再反查owner
 * 2. 合约直查方式：直接扫描合约NFT，再用deposits(tokenId)验证
 */

import { getDb } from "./db";
import { getClient } from "./chains";
import { listDexes, listStaking, type DexRow, type StakingRow } from "./chains/dexes";
import { findDirectPositions, findStakedPositions, type DiscoveredPosition } from "./staking/discover";
import { findStakedPositionsDirect } from "./staking/discover-direct";
import type { PublicClient } from "viem";

export interface ScanMethodResult {
  method: "transfer_scan" | "contract_direct";
  timeMs: number;
  positions: number;
  errors: string[];
  walletAddress: string;
  chainId: number;
}

/**
 * 测试转账扫描方式
 */
export async function testTransferScan(
  client: PublicClient,
  walletAddress: string,
  chainId: number,
  dexes: DexRow[],
  staking: StakingRow[]
): Promise<ScanMethodResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  
  try {
    const direct = await findDirectPositions(client, walletAddress as `0x${string}`, dexes);
    const staked = await findStakedPositions(
      client,
      walletAddress as `0x${string}`,
      dexes,
      staking,
      100_000n
    );
    
    const allPositions = [...direct, ...staked];
    const uniquePositions = dedupeDiscovered(allPositions);
    
    const endTime = Date.now();
    
    return {
      method: "transfer_scan",
      timeMs: endTime - startTime,
      positions: uniquePositions.length,
      errors,
      walletAddress,
      chainId
    };
  } catch (error) {
    const endTime = Date.now();
    return {
      method: "transfer_scan",
      timeMs: endTime - startTime,
      positions: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      walletAddress,
      chainId
    };
  }
}

/**
 * 测试合约直查方式
 */
export async function testContractDirectScan(
  client: PublicClient,
  walletAddress: string,
  chainId: number,
  dexes: DexRow[],
  staking: StakingRow[]
): Promise<ScanMethodResult> {
  const startTime = Date.now();
  const errors: string[] = [];

  try {
    // 1. 扫描钱包直接持有的NFT
    const direct = await findDirectPositions(client, walletAddress as `0x${string}`, dexes);
    // 2. 用 findStakedPositionsDirect 扫描质押合约（已包含 dex_id 关联逻辑）
    const staked = await findStakedPositionsDirect(
      client,
      walletAddress as `0x${string}`,
      dexes,
      staking
    );

    const allPositions = [...direct, ...staked];
    const uniquePositions = dedupeDiscovered(allPositions);

    const endTime = Date.now();

    return {
      method: "contract_direct",
      timeMs: endTime - startTime,
      positions: uniquePositions.length,
      errors,
      walletAddress,
      chainId
    };
  } catch (error) {
    const endTime = Date.now();
    return {
      method: "contract_direct",
      timeMs: endTime - startTime,
      positions: 0,
      errors: [error instanceof Error ? error.message : String(error)],
      walletAddress,
      chainId
    };
  }
}

/**
 * 运行对比测试
 */
export async function runScanMethodComparison(
  walletAddress?: string,
  chainId?: number
): Promise<{ transferScan: ScanMethodResult; contractDirect: ScanMethodResult }> {
  const db = getDb();
  
  // 获取钱包
  let walletRow: any;
  if (walletAddress) {
    walletRow = db.prepare("SELECT * FROM wallets WHERE address=? AND enabled=1").get(walletAddress);
  } else {
    const wallets = db.prepare("SELECT * FROM wallets WHERE enabled=1").all();
    if (wallets.length === 0) {
      throw new Error("没有启用的钱包");
    }
    walletRow = wallets[0];
  }
  
  if (!walletRow) {
    throw new Error(`未找到钱包: ${walletAddress}`);
  }
  
  // 获取链信息
  const targetChainId = chainId || walletRow.chain_id_ref;
  const { client, chain } = getClient(targetChainId);
  const dexes = listDexes(targetChainId, true);
  const staking = listStaking(targetChainId, true);
  
  console.log(`🔍 测试钱包: ${walletRow.address}`);
  console.log(`🔗 链: ${chain.name} (ID: ${targetChainId})`);
  console.log(`💰 DEX数量: ${dexes.length}`);
  console.log(`🔒 质押合约数量: ${staking.length}`);
  
  // 先运行转账扫描
  console.log("📡 开始转账扫描测试...");
  const transferScan = await testTransferScan(client, walletRow.address, targetChainId, dexes, staking);
  
  // 再运行合约直查
  console.log("🎯 开始合约直查测试...");
  const contractDirect = await testContractDirectScan(client, walletRow.address, targetChainId, dexes, staking);
  
  return { transferScan, contractDirect };
}

/**
 * 打印对比结果
 */
export function printComparisonResult(transferScan: ScanMethodResult, contractDirect: ScanMethodResult) {
  const speedup = transferScan.timeMs / contractDirect.timeMs;
  const improvement = ((transferScan.timeMs - contractDirect.timeMs) / transferScan.timeMs * 100).toFixed(1);
  
  console.log("\n" + "=" .repeat(60));
  console.log("📊 扫描方式对比结果");
  console.log("=" .repeat(60));
  
  console.log(`\n📡 转账扫描方式:`);
  console.log(`   ⏱️  时间: ${transferScan.timeMs}ms`);
  console.log(`   🔍 发现仓位: ${transferScan.positions}`);
  console.log(`   ❌ 错误: ${transferScan.errors.length}`);
  transferScan.errors.forEach(err => console.log(`      - ${err}`));
  
  console.log(`\n🎯 合约直查方式:`);
  console.log(`   ⏱️  时间: ${contractDirect.timeMs}ms`);
  console.log(`   🔍 发现仓位: ${contractDirect.positions}`);
  console.log(`   ❌ 错误: ${contractDirect.errors.length}`);
  contractDirect.errors.forEach(err => console.log(`      - ${err}`));
  
  console.log(`\n🚀 性能对比:`);
  console.log(`   ⚡ 速度提升: ${speedup.toFixed(2)}x (${improvement}% 更快)`);
  console.log(`   📈 仓位发现一致性: ${transferScan.positions === contractDirect.positions ? '✅ 完全一致' : '❌ 存在差异'}`);
  
  if (transferScan.positions !== contractDirect.positions) {
    console.log(`   📊 转账扫描发现: ${transferScan.positions} vs 合约直查发现: ${contractDirect.positions}`);
  }
}

// 去重函数
function dedupeDiscovered(list: DiscoveredPosition[]): DiscoveredPosition[] {
  const map = new Map<string, DiscoveredPosition>();
  for (const d of list) {
    const key = `${d.dexId}:${d.tokenId}`;
    if (!map.has(key) || d.source === "direct") map.set(key, d);
  }
  return [...map.values()];
}

// 如果需要直接运行测试
async function main() {
  try {
    console.log("🚀 开始扫描方式对比测试...");
    
    const { transferScan, contractDirect } = await runScanMethodComparison();
    printComparisonResult(transferScan, contractDirect);
    
  } catch (error) {
    console.error("❌ 测试失败:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

// 如果直接运行此文件
if (require.main === module) {
  main();
}