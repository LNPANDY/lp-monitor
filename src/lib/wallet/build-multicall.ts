/**
 * 构造「移除仓位」相关的 NPM calldata 与质押合约 withdraw calldata。
 *
 * 支持两种模式：
 *   1. NPM.multicall([decreaseLiquidity, collect, burn]) —— 支持 multicall 的标准 V3 DEX 一步完成
 *   2. 分步模式（针对不支持 multicall 的 ZIA DEX 等）：
 *      Step A: decreaseLiquidity(全量)
 *      Step B: collect(全量)
 */
import { encodeFunctionData } from "viem";
import { NPM_WRITE_ABI } from "./write-abi";
import { getInjectedProvider } from "./provider";

/** uint128 最大值，用于 collect 的 amountMax（收取全部累积费用）。 */
const UINT128_MAX = (1n << 128n) - 1n;

export function buildRemoveLiquidityCalldata(
  npm: string,
  tokenId: bigint,
  liquidity: bigint,
  recipient: string,
  amount0Min: bigint = 0n,
  amount1Min: bigint = 0n
): { to: string; data: string } {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

  const decreaseData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min,
        amount1Min,
        deadline,
      },
    ],
  });

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

  const burnData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "burn",
    args: [tokenId],
  });

  const multicallData = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "multicall",
    args: [[decreaseData, collectData, burnData]],
  });

  return { to: npm, data: multicallData };
}

/** 构造单独的 decreaseLiquidity calldata（用于不支持 multicall 的 ZIA DEX） */
export function buildDecreaseLiquidityCalldata(
  npm: string,
  tokenId: bigint,
  liquidity: bigint
): { to: string; data: string } {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const data = encodeFunctionData({
    abi: NPM_WRITE_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId,
        liquidity,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline,
      },
    ],
  });
  return { to: npm, data };
}

/** 构造单独的 collect calldata（用于不支持 multicall 的 ZIA DEX） */
export function buildCollectCalldata(
  npm: string,
  tokenId: bigint,
  recipient: string
): { to: string; data: string } {
  const data = encodeFunctionData({
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
  return { to: npm, data };
}

/** 构造质押仓位解质押的 withdraw(tokenId) calldata */
export function buildWithdrawCalldata(tokenId: bigint): string {
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

/** 预探测该 NPM 合约是否支持 multicall（通过 eth_call 静态模拟） */
export async function checkMulticallSupport(
  npm: string,
  tokenId: bigint,
  liquidity: bigint,
  recipient: string
): Promise<boolean> {
  const p = getInjectedProvider();
  if (!p) return false;
  try {
    const { data } = buildRemoveLiquidityCalldata(npm, tokenId, liquidity, recipient);
    await p.request({
      method: "eth_call",
      params: [{ from: recipient, to: npm, data }, "latest"],
    });
    return true;
  } catch {
    return false;
  }
}
