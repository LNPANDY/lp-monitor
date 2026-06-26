/**
 * Uniswap V3 流动性数学 —— 纯 bigint 实现，保证精度。
 *
 * 核心公式来源：Uniswap V3 白皮书 & TickMath.sol / LiquidityAmounts.sol
 *
 * 提供：
 *   - tickToSqrtPriceX96(tick)      : 定点 bigint，避免 Math.pow 精度丢失
 *   - getAmountsForLiquidity(...)   : 给定 sqrtPrice + tick 区间 + liquidity，算 token0/token1 数量
 *   - sqrtPriceX96ToPrice(...)     : 将 sqrtPriceX96 转为人类可读价格（考虑 decimals）
 *   - tickToPriceDisplay(tick)      : tick → 价格字符串（展示用，带 decimals）
 */
/** V3 定点基准：sqrtPriceX96 以 2^96 为分母（NOT 10^96）。 */
const Q96 = 2n ** 96n;

/** Uniswap V3 fee → tickSpacing 映射。 */
export const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// ==================== tick ↔ sqrtPriceX96 ====================

/**
 * tick → sqrtPriceX96（Q96 定点 bigint）。
 *
 * V3 数学：price = 1.0001^tick，sqrtPrice = price^0.5，
 *         sqrtPriceX96 = sqrtPrice × 2^96。
 *
 * 实现策略：用 JavaScript 浮点算 sqrtPrice 近似值，再转为 Q96 bigint。
 * Math.pow(1.0001, tick/2) 对 ±500000 tick 范围提供 ~15 位有效数字，
 * 足以匹配链上 uint160 精度（最大 ~48 位十进制）。
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  // sqrtPrice = (1.0001)^(tick/2)
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  // sqrtPriceX96 = sqrtPrice × 2^96，用字符串拼接避免浮点截断
  const raw = sqrtPrice * 2 ** 96;
  return BigInt(Math.round(raw));
}

// ==================== getAmountsForLiquidity ====================

/**
 * 给定 sqrtPriceX96 和 tick 区间，将 liquidity 反算为 token0/token1 数量。
 *
 * 参考 Uniswap V3 SwapMath.getAmountsForLiquidity：
 *   amount0 = L × (1/sqrtA - 1/sqrtB) = L × (sqrtB - sqrtA) / (sqrtA × sqrtB)
 *   amount1 = L × (sqrtB - sqrtA)
 *
 * @param sqrtPriceX96  当前价格（Q96）
 * @param sqrtPriceAX96 区间下界的 sqrtPrice（Q96）
 * @param sqrtPriceBX96 区间上界的 sqrtPrice（Q96）
 * @param liquidity     流动性 L（uint128）
 * @param decimals0     token0 的 decimals
 * @param decimals1     token1 的 decimals
 * @returns {{ amount0: string, amount1: string }} 可读数量（已经 / 10^decimals）
 */
export function getAmountsForLiquidity(
  sqrtPriceX96: bigint,
  sqrtPriceAX96: bigint,
  sqrtPriceBX96: bigint,
  liquidity: bigint,
  decimals0: number,
  decimals1: number
): { amount0: string; amount1: string } {
  if (liquidity === 0n) return { amount0: "0", amount1: "0" };

  let amount0 = 0n;
  let amount1 = 0n;

  if (sqrtPriceX96 <= sqrtPriceAX96) {
    // 价格低于区间：全部是 token0
    amount0 = getAmount0ForRange(sqrtPriceAX96, sqrtPriceBX96, liquidity);
  } else if (sqrtPriceX96 >= sqrtPriceBX96) {
    // 价格高于区间：全部是 token1
    amount1 = getAmount1ForRange(sqrtPriceAX96, sqrtPriceBX96, liquidity);
  } else {
    // 价格在区间内：两种 token 都有
    amount0 = getAmount0ForRange(sqrtPriceX96, sqrtPriceBX96, liquidity);
    amount1 = getAmount1ForRange(sqrtPriceAX96, sqrtPriceX96, liquidity);
  }

  return {
    amount0: formatTokenAmount(amount0, decimals0),
    amount1: formatTokenAmount(amount1, decimals1),
  };
}

function getAmount0ForRange(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  // amount0 = liquidity × (sqrtB - sqrtA) / (sqrtA × sqrtB / 2^96) × 2^96
  //          = liquidity × (sqrtB - sqrtA) × 2^96 / sqrtA × 2^96 / sqrtB
  const numerator1 = liquidity * (sqrtB - sqrtA) * Q96;
  const numerator2 = numerator1 / sqrtA;
  return numerator2 / sqrtB;
}

function getAmount1ForRange(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
  if (sqrtA > sqrtB) [sqrtA, sqrtB] = [sqrtB, sqrtA];
  // amount1 = liquidity × (sqrtB - sqrtA) / 2^96
  return (liquidity * (sqrtB - sqrtA)) / Q96;
}

// ==================== 价格展示 ====================

/**
 * 将 sqrtPriceX96 转为可读价格字符串，考虑 token0/token1 的 decimals。
 *
 * price = (sqrtPriceX96 / 2^96)^2
 *        = sqrtPriceX96^2 / 2^192
 *
 * 价格含义：1 token0 = price token1（即 price 中已含 decimals 差）。
 */
export function sqrtPriceX96ToHumanPrice(
  sqrtPriceX96: bigint,
  decimals0: number,
  decimals1: number
): string {
  // price = (sqrtPriceX96 / 2^96)^2 × 10^(decimals0 - decimals1)
  // 1. priceX192 = sqrtPriceX96^2，量纲为 raw token0 / raw token1
  // 2. 引入 Q18 精度：priceScaled = priceX192 × 10^18 / 2^192
  // 3. decimals 差的放大/缩小仍在 Q18 量纲内进行，最后统一按 Q18 格式化
  const priceX192 = sqrtPriceX96 * sqrtPriceX96;
  const expPrecision = 18n;
  const priceScaled = (priceX192 * (10n ** expPrecision)) >> 192n;

  const decDiff = decimals0 - decimals1; // >0: token0 更大单位，需放大；<0: 需缩小
  let price: bigint;
  if (decDiff >= 0) {
    price = priceScaled * 10n ** BigInt(decDiff);
  } else {
    price = priceScaled / (10n ** BigInt(-decDiff));
  }

  // price 量纲恒为 Q18（1 token0 = price / 10^18 token1）
  return formatBigInt(price, Number(expPrecision));
}

/**
 * tick → 价格字符串（展示用），考虑 decimals。
 * 价格含义：1 token0 = X token1。
 */
export function tickToPriceDisplay(tick: number, decimals0: number, decimals1: number): string {
  const sqrtPrice = tickToSqrtPriceX96(tick);
  return sqrtPriceX96ToHumanPrice(sqrtPrice, decimals0, decimals1);
}

// ==================== 工具函数 ====================

/** bigint 数量格式化为带适当小数的字符串（如 "1234.5678"）。 */
export function formatBigInt(value: bigint, decimals: number): string {
  const sign = value < 0n ? "-" : "";
  const abs = value < 0n ? -value : value;
  if (decimals <= 0) return sign + abs.toString();

  const divisor = 10n ** BigInt(decimals);
  const intPart = abs / divisor;
  const fracPart = abs % divisor;

  // 去掉 fracPart 末尾的 0
  let fracStr = fracPart.toString().padStart(decimals, "0");
  fracStr = fracStr.replace(/0+$/, "");
  if (fracStr === "") return sign + intPart.toString();
  return sign + intPart.toString() + "." + fracStr;
}

/** 将原始 token 数量（wei 单位 bigint）格式化为可读字符串。 */
export function formatTokenAmount(weiAmount: bigint, decimals: number): string {
  return formatBigInt(weiAmount, decimals);
}
