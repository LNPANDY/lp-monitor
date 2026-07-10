import { encodeFunctionData } from 'viem';
import { NPM_WRITE_ABI } from './src/lib/wallet/write-abi';

async function testMulticallDetection() {
  console.log('测试 NPM multicall 支持...');
  
  // 测试参数
  const testNpm = '0x5143ba6007c197b4cf66c20601b9db97e0f98c6a'; // ZIA NPM
  
  try {
    // 尝试构建 multicall 数据
    const multicallData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "multicall",
      args: [[]],
    });
    
    console.log('Multicall data:', multicallData);
    console.log('✅ multicall 数据构建成功');
    
    // 检查 ZIA NPM ABI 是否包含 multicall
    const multicallAbi = NPM_WRITE_ABI.find(fn => fn.name === "multicall");
    if (multicallAbi) {
      console.log('✅ NPM ABI 包含 multicall 函数');
      console.log('Multicall ABI:', JSON.stringify(multicallAbi, null, 2));
    } else {
      console.log('❌ NPM ABI 不包含 multicall 函数');
    }
    
    // 检查 ZIA NPM ABI 是否包含 decreaseLiquidity
    const decreaseAbi = NPM_WRITE_ABI.find(fn => fn.name === "decreaseLiquidity");
    if (decreaseAbi) {
      console.log('✅ NPM ABI 包含 decreaseLiquidity 函数');
      console.log('Decrease ABI:', JSON.stringify(decreaseAbi, null, 2));
    } else {
      console.log('❌ NPM ABI 不包含 decreaseLiquidity 函数');
    }
    
    // 检查 ZIA NPM ABI 是否包含 collect
    const collectAbi = NPM_WRITE_ABI.find(fn => fn.name === "collect");
    if (collectAbi) {
      console.log('✅ NPM ABI 包含 collect 函数');
      console.log('Collect ABI:', JSON.stringify(collectAbi, null, 2));
    } else {
      console.log('❌ NPM ABI 不包含 collect 函数');
    }
    
    // 测试构建 decreaseLiquidity 数据
    const decreaseData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "decreaseLiquidity",
      args: [{
        tokenId: 4288n,
        liquidity: 1000000000000000000n,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
      }],
    });
    
    console.log('Decrease liquidity data:', decreaseData);
    console.log('✅ decreaseLiquidity 数据构建成功');
    
    // 测试构建 collect 数据
    const collectData = encodeFunctionData({
      abi: NPM_WRITE_ABI,
      functionName: "collect",
      args: [{
        tokenId: 4288n,
        recipient: '0x4988d104d6d0902812fa3b6bc66b2ff5a6fce409',
        amount0Max: (1n << 128n) - 1n,
        amount1Max: (1n << 128n) - 1n,
      }],
    });
    
    console.log('Collect data:', collectData);
    console.log('✅ collect 数据构建成功');
    
  } catch (error) {
    console.error('测试失败:', error);
  }
}

testMulticallDetection();