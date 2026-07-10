/**
 * V3 NonfungiblePositionManager（NPM）写交易 ABI + 质押合约 withdraw ABI。
 *
 * 用于「移除仓位」功能：
 *   - 质押仓位 Step1: staker.withdraw(tokenId) —— 把 LP NFT 从质押合约取回钱包
 *   - 所有仓位 Step2: NPM.multicall([decreaseLiquidity, collect, burn]) —— 解除流动性 + 收取 + 销毁
 *
 * NPM ABI 与 Uniswap V3 官方 NonfungiblePositionManager 完全一致，
 * 兼容所有 V3-fork DEX（ZIA / Pancake V3 / QuickSwap V3 等）。
 */

/** NPM 写方法 ABI（移除流动性用到的子集）。 */
export const NPM_WRITE_ABI = [
  {
    name: "decreaseLiquidity",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "liquidity", type: "uint128" },
          { name: "amount0Min", type: "uint256" },
          { name: "amount1Min", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "collect",
    type: "function",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenId", type: "uint256" },
          { name: "recipient", type: "address" },
          { name: "amount0Max", type: "uint128" },
          { name: "amount1Max", type: "uint128" },
        ],
      },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    name: "burn",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
  {
    name: "multicall",
    type: "function",
    stateMutability: "payable",
    inputs: [{ name: "data", type: "bytes[]" }],
    outputs: [{ name: "results", type: "bytes[]" }],
  },
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
] as const;

/** 质押合约 withdraw ABI（ZIA 风格 vault：把 LP NFT 还给 depositor）。 */
export const STAKER_WITHDRAW_ABI = [
  {
    name: "withdraw",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [],
  },
] as const;
