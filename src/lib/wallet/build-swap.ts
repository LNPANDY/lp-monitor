/**
 * 代币兑换（swap）的 calldata 构造。
 *
 * 支持两种 Router 签名（由后端报价返回的 router.kind 决定）：
 *   - router02：SwapRouter02.exactInputSingle(ExactInputSingleParams struct)
 *     params = { tokenIn, tokenOut, fee, recipient, deadline, amountIn, amountOutMinimum, sqrtPriceLimitX96 }
 *   - swaprouter：SwapRouter V1.exactInputSingle(平铺参数，同字段)
 *
 * 原生币输入：tokenIn 为原生币时（isNative=true），calldata 里的 tokenIn 用
 * wrapped 合约地址（报价已按 wrapped 池子算），交易附 value=amountIn，
 * 由 Router 代为 wrap（标准行为：Router 收 native 后 wrap 成 WETH 再进池）。
 *
 * 注意：输出直接发到 recipient（用户钱包），不做自动 unwrap：
 *   1. 0G 链没有 native ETH 需求，用户要的就是 WETH 本身；
 *   2. 自建链 Router 的内置 WETH9（immutable）可能与链上 WETH 代币不是同一合约，
 *      unwrapWETH9 提不到 swap 输出 → revert "Insufficient WETH9"。
 */
import { encodeFunctionData } from "viem";

/** Router02 的 struct 签名 */
const ROUTER02_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

/** SwapRouter V1 的平铺签名（字段相同，非 struct） */
const SWAPROUTER_V1_ABI = [
  {
    name: "exactInputSingle",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "recipient", type: "address" },
      { name: "deadline", type: "uint256" },
      { name: "amountIn", type: "uint256" },
      { name: "amountOutMinimum", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
] as const;

export interface SwapParams {
  /** 输入代币的 wrapped 合约地址（native 已由调用方映射） */
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  /** deadline 秒级时间戳 */
  deadline: bigint;
}

/**
 * 构造单笔 exactInputSingle 的 calldata，输出直接发到 recipient。
 *
 * @param routerAddr router 地址
 * @param routerKind 'router02'（struct）| 'swaprouter'（平铺）
 * @param isNativeIn 输入是否为原生币（true 时返回 value 字段，由 Router 代 wrap）
 */
export function buildSwapCalldata(
  routerAddr: string,
  routerKind: "router02" | "swaprouter",
  p: SwapParams,
  isNativeIn: boolean
): { to: string; data: string; value?: string } {
  const deadline = p.deadline > 0n ? p.deadline : BigInt(Math.floor(Date.now() / 1000) + 1200);
  const abi = routerKind === "router02" ? ROUTER02_ABI : SWAPROUTER_V1_ABI;
  const args = {
    tokenIn: p.tokenIn as `0x${string}`,
    tokenOut: p.tokenOut as `0x${string}`,
    fee: p.fee,
    recipient: p.recipient as `0x${string}`,
    deadline,
    amountIn: p.amountIn,
    amountOutMinimum: p.amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };
  const data = encodeFunctionData({
    abi,
    functionName: "exactInputSingle",
    args: routerKind === "router02"
      ? [args]
      : [args.tokenIn, args.tokenOut, args.fee, args.recipient, args.deadline, args.amountIn, args.amountOutMinimum, args.sqrtPriceLimitX96],
  });

  return {
    to: routerAddr,
    data,
    ...(isNativeIn ? { value: "0x" + p.amountIn.toString(16) } : {}),
  };
}
