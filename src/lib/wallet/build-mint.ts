/**
 * 创建流动性（mint）相关的 calldata 构造与计算工具。
 *
 * 支持：
 *   - NPM.mint：创建新仓位
 *   - ERC20 approve：授权 token0/token1
 *   - 质押合约 deposit：把 mint 出的 NFT 存入 ZIA 质押合约
 *
 * 金额反算思路（只输入单侧金额时）：
 *   给定目标区间 [tickLower, tickUpper] 和当前 tick，计算在该区间内
 *   投入 amount0（或 amount1）时对应的 liquidity，再反算另一侧金额。
 */
import { encodeFunctionData } from "viem";
import { tickToSqrtPriceX96 as tickToSqrtPriceX96Impl } from "../v3/math";

const UINT128_MAX = (1n << 128n) - 1n;
const Q96 = 1n << 96n;

/** NPM.mint 的 ABI 片段 */
const NPM_MINT_ABI = [
  {
    name: "mint",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "amount0Desired", type: "uint256" },
          { name: "amount1Desired", type: "uint256" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "tokenId", type: "uint256" },
      { name: "liquidity", type: "uint128" },
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
] as const;

/** ERC20 approve ABI 片段 */
const ERC20_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    name: "allowance",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** ZIA 质押合约 deposit(uint256) ABI 片段 */
const STAKER_DEPOSIT_ABI = [
  {
    name: "deposit",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
] as const;

export interface MintParams {
  token0: string;
  token1: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  amount0Min?: bigint;
  amount1Min?: bigint;
  recipient: string;
  /** 滑点容忍百分比（如 0.5 表示 0.5%），用于计算 amountMin */
  slippagePct?: number;
}

/** 构造 NPM.mint 的 calldata */
export function buildMintCalldata(npm: string, p: MintParams): { to: string; data: string } {
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 分钟
  // 滑点保护：默认 0.5%
  const slip = BigInt(Math.floor((p.slippagePct ?? 0.5) * 100));
  const amount0Min = p.amount0Min ?? (p.amount0Desired * (10000n - slip)) / 10000n;
  const amount1Min = p.amount1Min ?? (p.amount1Desired * (10000n - slip)) / 10000n;

  const data = encodeFunctionData({
    abi: NPM_MINT_ABI,
    functionName: "mint",
    args: [
      {
        token0: p.token0 as `0x${string}`,
        token1: p.token1 as `0x${string}`,
        fee: p.fee,
        tickLower: p.tickLower,
        tickUpper: p.tickUpper,
        amount0Desired: p.amount0Desired,
        amount1Desired: p.amount1Desired,
        amount0Min,
        amount1Min,
        recipient: p.recipient as `0x${string}`,
        deadline,
      },
    ],
  });
  return { to: npm, data };
}

/** 构造 ERC20 approve 的 calldata */
export function buildApproveCalldata(token: string, spender: string, amount: bigint): { to: string; data: string } {
  const data = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [spender as `0x${string}`, amount],
  });
  return { to: token, data };
}

/** 构造质押合约 deposit 的 calldata */
export function buildStakeDepositCalldata(stakerContract: string, tokenId: bigint): { to: string; data: string } {
  const data = encodeFunctionData({
    abi: STAKER_DEPOSIT_ABI,
    functionName: "deposit",
    args: [tokenId],
  });
  return { to: stakerContract, data };
}

/** ERC721 approve 的 ABI 片段（NFT 授权给质押合约用） */
const ERC721_APPROVE_ABI = [
  {
    name: "approve",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

/** 构造 ERC721 approve 的 calldata（把 NFT 授权给质押合约） */
export function buildNftApproveCalldata(npm: string, to: string, tokenId: bigint): { to: string; data: string } {
  const data = encodeFunctionData({
    abi: ERC721_APPROVE_ABI,
    functionName: "approve",
    args: [to as `0x${string}`, tokenId],
  });
  return { to: npm, data };
}

/** 无限授权用的最大值（避免每次都 approve） */
export const MAX_UINT256 = (1n << 256n) - 1n;

/**
 * tick → sqrtPriceX96（BigInt 精确计算，避免浮点误差）
 * sqrtPrice = 1.0001^(tick/2) × 2^96
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  return tickToSqrtPriceX96Impl(tick);
}

/**
 * 只输入单侧金额时，反算流动性 L 和另一侧金额。
 *
 * 公式（Uniswap v3 whitepaper）：
 *   价格低于区间（current <= lower）：全部 token0
 *     L = amount0 × (sqrtA × sqrtB) / (sqrtB - sqrtA) / 2^96... 见下方实现
 *   价格高于区间（current >= upper）：全部 token1
 *   价格在区间内：两侧按比例
 *
 * @param sqrtPriceX96 当前价格
 * @param sqrtLower    tickLower 对应 sqrtPrice
 * @param sqrtUpper    tickUpper 对应 sqrtPrice
 * @param side         输入的是哪一侧：'token0' | 'token1'
 * @param amountRaw    输入的原始金额（已含 decimals）
 * @returns { liquidity, amount0, amount1 } —— liquidity 为 uint128 内的 BigInt，amount0/1 为原始单位
 */
export function computeLiquidityFromAmount(
  sqrtPriceX96: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
  side: "token0" | "token1",
  amountRaw: bigint
): { liquidity: bigint; amount0: bigint; amount1: bigint } {
  if (amountRaw <= 0n || sqrtLower >= sqrtUpper) {
    return { liquidity: 0n, amount0: 0n, amount1: 0n };
  }

  let liquidity = 0n;

  if (sqrtPriceX96 <= sqrtLower) {
    // 价格低于区间：只用 token0
    if (side === "token0") {
      // L = amount0 × (sqrtA × sqrtB / 2^96) / (sqrtB - sqrtA)
      liquidity = (amountRaw * ((sqrtLower * sqrtUpper) / Q96)) / (sqrtUpper - sqrtLower);
    } else {
      // 输入 token1 但当前价格在区间下方 → 实际只需要 token0，token1 用量为 0
      liquidity = 0n;
    }
  } else if (sqrtPriceX96 >= sqrtUpper) {
    // 价格高于区间：只用 token1
    if (side === "token1") {
      // L = amount1 / (sqrtB - sqrtA) × 2^96
      liquidity = (amountRaw * Q96) / (sqrtUpper - sqrtLower);
    } else {
      liquidity = 0n;
    }
  } else {
    // 价格在区间内
    if (side === "token0") {
      // L = amount0 × (sqrtP × sqrtB / 2^96) / (sqrtB - sqrtP)
      liquidity = (amountRaw * ((sqrtPriceX96 * sqrtUpper) / Q96)) / (sqrtUpper - sqrtPriceX96);
    } else {
      // L = amount1 / (sqrtP - sqrtA) × 2^96
      liquidity = (amountRaw * Q96) / (sqrtPriceX96 - sqrtLower);
    }
  }

  // 上限保护（uint128）
  if (liquidity > UINT128_MAX) liquidity = UINT128_MAX;

  const { amount0, amount1 } = amountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
  return { liquidity, amount0, amount1 };
}

/** 给定 L 和价格区间，算两侧金额（原始单位，BigInt） */
export function amountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtLower: bigint,
  sqrtUpper: bigint,
  liquidity: bigint
): { amount0: bigint; amount1: bigint } {
  if (liquidity === 0n) return { amount0: 0n, amount1: 0n };

  let amount0 = 0n;
  let amount1 = 0n;

  if (sqrtPriceX96 <= sqrtLower) {
    // 全 token0
    amount0 = (liquidity * Q96 * (sqrtUpper - sqrtLower)) / sqrtUpper / sqrtLower;
  } else if (sqrtPriceX96 >= sqrtUpper) {
    // 全 token1
    amount1 = (liquidity * (sqrtUpper - sqrtLower)) / Q96;
  } else {
    amount0 = (liquidity * Q96 * (sqrtUpper - sqrtPriceX96)) / sqrtUpper / sqrtPriceX96;
    amount1 = (liquidity * (sqrtPriceX96 - sqrtLower)) / Q96;
  }

  return { amount0, amount1 };
}
