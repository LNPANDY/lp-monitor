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
 * 注意：output 是 wrapped 代币（W0G 等），本实现不做自动 unwrap。
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

/** unwrapWETH9(uint256,recipient)：把 Router 持有的 WETH 提成 native 发给 recipient */
const UNWRAP_WETH_ABI = [
  {
    name: "unwrapWETH9",
    type: "function",
    stateMutability: "payable",
    inputs: [
      { name: "amountMinimum", type: "uint256" },
      { name: "recipient", type: "address" },
    ],
    outputs: [],
  },
] as const;

/** multicall(bytes[])：Router02 的批量执行 */
const MULTICALL_ABI = [
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
] as const;

/**
 * 构造「swap + 自动 unwrap」的 calldata。
 *
 * 输出为 wrapped 原生币（如 W0G）且 router 是 Router02（支持 multicall）时：
 *   calldata = multicall([exactInputSingle, unwrapWETH9(amountMin, recipient)])
 *   swap 得到的 wrapped 立即在 Router 内 withdraw 成 native 发到钱包。
 * 其他情况退化为单笔 exactInputSingle。
 *
 * @param routerAddr router 地址
 * @param routerKind 'router02'（struct）| 'swaprouter'（平铺）
 * @param isNativeIn 输入是否为原生币（true 时返回 value 字段）
 * @param unwrap 输出是 wrapped native 时传 true（自动提现）
 */
export function buildSwapCalldata(
  routerAddr: string,
  routerKind: "router02" | "swaprouter",
  p: SwapParams,
  isNativeIn: boolean,
  unwrap: boolean = false
): { to: string; data: string; value?: string } {
  const deadline = p.deadline > 0n ? p.deadline : BigInt(Math.floor(Date.now() / 1000) + 1200);
  const abi = routerKind === "router02" ? ROUTER02_ABI : SWAPROUTER_V1_ABI;
  // unwrap 路径：swap 的 recipient 必须是 Router 自己（address(this)），
  // 让换得的 WETH 留在 Router 里，随后 unwrapWETH9 才有 WETH 可提现给用户。
  // （否则 WETH 直发用户，Router 余额为 0 → unwrap 时 revert "Insufficient WETH9"）
  const swapRecipient = unwrap ? routerAddr : p.recipient;
  const args = {
    tokenIn: p.tokenIn as `0x${string}`,
    tokenOut: p.tokenOut as `0x${string}`,
    fee: p.fee,
    recipient: swapRecipient as `0x${string}`,
    deadline,
    amountIn: p.amountIn,
    amountOutMinimum: p.amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  };
  const swapData = encodeFunctionData({
    abi,
    functionName: "exactInputSingle",
    args: routerKind === "router02"
      ? [args]
      : [args.tokenIn, args.tokenOut, args.fee, args.recipient, args.deadline, args.amountIn, args.amountOutMinimum, args.sqrtPriceLimitX96],
  });

  // unwrap：swap 得到的 wrapped native 在同一交易里 withdraw 成 native（Router02 multicall）
  if (unwrap && routerKind === "router02") {
    const unwrapData = encodeFunctionData({
      abi: UNWRAP_WETH_ABI,
      functionName: "unwrapWETH9",
      args: [p.amountOutMinimum, p.recipient as `0x${string}`],
    });
    const data = encodeFunctionData({
      abi: MULTICALL_ABI,
      functionName: "multicall",
      args: [[swapData, unwrapData]],
    });
    return {
      to: routerAddr,
      data,
      ...(isNativeIn ? { value: "0x" + p.amountIn.toString(16) } : {}),
    };
  }

  return {
    to: routerAddr,
    data: swapData,
    ...(isNativeIn ? { value: "0x" + p.amountIn.toString(16) } : {}),
  };
}
