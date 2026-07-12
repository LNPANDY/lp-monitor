/**
 * 构造「移除仓位」Step2 的 NPM.multicall calldata。
 *
 * 一步完成：decreaseLiquidity(全量) → collect(全量) → burn
 *
 * 编码用 viem 的 encodeFunctionData，与 NPM_WRITE_ABI 对齐。
 * Min 值传 0（紧急移除，接受任意滑点）；deadline 传一个足够大的值（~1小时后），
 * 避免因签名/打包延迟导致过期。
 */
import { encodeFunctionData } from "viem";
import { NPM_WRITE_ABI } from "./write-abi";

/** uint128 最大值，用于 collect 的 amountMax（收取全部累积费用）。 */
const UINT128_MAX = (1n << 128n) - 1n;

/**
 * 构造 multicall 的 calldata（直接发给 NPM 合约的 data 字段）。
 *
 * @param npm         NPM 合约地址（multicall 调用目标）
 * @param tokenId     LP NFT tokenId
 * @param liquidity   当前流动性（positions.liquidity，全部移除）
 * @param recipient   收取代币的钱包地址（连接的钱包）
 * @param amount0Min  token0 最小接收量（默认 0，传其他值启用滑点保护）
 * @param amount1Min  token1 最小接收量（默认 0，传其他值启用滑点保护）
 * @returns { to, data } —— 直接作为 sendTx 的参数
 */
export function buildRemoveLiquidityCalldata(
  npm: string,
  tokenId: bigint,
  liquidity: bigint,
  recipient: string,
  amount0Min: bigint = 0n,
  amount1Min: bigint = 0n
): { to: string; data: string } {
  // deadline：当前时间 + 1 小时（秒）。用 Math.floor 避免 encodeFunctionData 收到小数。
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  // 1. decreaseLiquidity：把全部 liquidity 退回成 token0/token1（尚未到账，需 collect）
  const decreaseData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min: 0n, // 紧急移除，不设下限
        amount1Min: 0n,
        deadline,
      },
    ],
  });

  // 2. collect：把 decreaseLiquidity 退出的 token + 累积的手续费全部收走
  const collectData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "collect",
    args: [
      {
        tokenId,
        recipient: recipient as `0x${string}`,
        amount0Max: UINT128_MAX,
        amount1Max: UINT128_MAX,
      },
    ],
  });

  // 3. burn：流动性归零后销毁 NFT（回收）
  const burnData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "burn",
    args: [tokenId],
  });

  // 打包进 multicall 一次提交
  const multicallData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "multicall",
    args: [[decreaseData, collectData, burnData]],
  });

  return { to: npm, data: multicallData };
}

/**
 * 构造 Step1（质押仓位移除 LP）的 withdraw calldata。
 * @param stakerContract 质押合约地址（调用目标）
 * @param tokenId LP NFT tokenId
 */
export function buildWithdrawCalldata(tokenId: bigint): string {
  // 用 viem 内联 ABI 编码，避免依赖 write-abi 里的 const 断言导致类型不匹配
  return encodeFunctionData({
    abi: [
      {
        name: "withdraw",
        type: "function",
        stateMutability: "nonpayable",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [],
      },
    ],
    functionName: "withdraw",
    args: [tokenId],
  });
}
