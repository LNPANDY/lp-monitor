/**
 * 测试ABI编码是否正确
 * 
 * 这个脚本用于验证移除功能中的calldata编码是否正确
 */

import { encodeFunctionData } from "viem";
import { NPM_WRITE_ABI } from "./src/lib/wallet/write-abi";

// 测试参数
const testCases = [
  {
    name: "ZIA质押仓位",
    tokenId: 4288n,
    liquidity: 280411860669566n,
    recipient: "0x4988d104d6d0902812fa3b6bc66b2ff5a6fce409",
    npm: "0x5143ba6007c197b4cf66c20601b9db97e0f98c6a"
  },
  {
    name: "测试用例1",
    tokenId: 1234n,
    liquidity: 1000000000000000000n,
    recipient: "0x742d35Cc6634C0532925a3b8D5c2B4b2e8a13c9",
    npm: "0x743e03cceb4af2efa3cc76838f6e8b50b63f184c"
  }
];

console.log("=== 测试ABI编码 ===\n");

// 测试decreaseLiquidity编码
console.log("1. 测试 decreaseLiquidity 编码:");
for (const testCase of testCases) {
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    
    const decreaseData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: testCase.tokenId,
          liquidity: testCase.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        },
      ],
    });
    
    console.log(`\n${testCase.name}:`);
    console.log(`  - Token ID: ${testCase.tokenId}`);
    console.log(`  - Liquidity: ${testCase.liquidity}`);
    console.log(`  - Deadline: ${deadline}`);
    console.log(`  - Calldata: ${decreaseData}`);
    console.log(`  - Length: ${decreaseData.length} chars`);
  } catch (error) {
    console.log(`❌ ${testCase.name} 编码失败:`, error);
  }
}

// 测试collect编码
console.log("\n2. 测试 collect 编码:");
const UINT128_MAX = (1n << 128n) - 1n;

for (const testCase of testCases) {
  try {
    const collectData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "collect",
      args: [
        {
          tokenId: testCase.tokenId,
          recipient: testCase.recipient as `0x${string}`,
          amount0Max: UINT128_MAX,
          amount1Max: UINT128_MAX,
        },
      ],
    });
    
    console.log(`\n${testCase.name}:`);
    console.log(`  - Token ID: ${testCase.tokenId}`);
    console.log(`  - Recipient: ${testCase.recipient}`);
    console.log(`  - Calldata: ${collectData}`);
    console.log(`  - Length: ${collectData.length} chars`);
  } catch (error) {
    console.log(`❌ ${testCase.name} 编码失败:`, error);
  }
}

// 测试burn编码
console.log("\n3. 测试 burn 编码:");
for (const testCase of testCases) {
  try {
    const burnData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "burn",
      args: [testCase.tokenId],
    });
    
    console.log(`\n${testCase.name}:`);
    console.log(`  - Token ID: ${testCase.tokenId}`);
    console.log(`  - Calldata: ${burnData}`);
    console.log(`  - Length: ${burnData.length} chars`);
  } catch (error) {
    console.log(`❌ ${testCase.name} 编码失败:`, error);
  }
}

// 测试multicall组合
console.log("\n4. 测试 multicall 组合:");
for (const testCase of testCases) {
  try {
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    
    const decreaseData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "decreaseLiquidity",
      args: [
        {
          tokenId: testCase.tokenId,
          liquidity: testCase.liquidity,
          amount0Min: 0n,
          amount1Min: 0n,
          deadline,
        },
      ],
    });
    
    const collectData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "collect",
      args: [
        {
          tokenId: testCase.tokenId,
          recipient: testCase.recipient as `0x${string}`,
          amount0Max: UINT128_MAX,
          amount1Max: UINT128_MAX,
        },
      ],
    });
    
    const burnData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "burn",
      args: [testCase.tokenId],
    });
    
    const multicallData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "multicall",
      args: [[decreaseData, collectData, burnData]],
    });
    
    console.log(`\n${testCase.name}:`);
    console.log(`  - NPM: ${testCase.npm}`);
    console.log(`  - Multicall calldata: ${multicallData}`);
    console.log(`  - Length: ${multicallData.length} chars`);
    console.log(`  - Number of calls: 3`);
  } catch (error) {
    console.log(`❌ ${testCase.name} multicall 编码失败:`, error);
  }
}

console.log("\n=== 测试完成 ===");