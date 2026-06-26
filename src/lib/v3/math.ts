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
const Q96 = 10n ** 96n;
const Q128 = 10n ** 128n;

/** Uniswap V3 fee → tickSpacing 映射。 */
export const FEE_TO_TICK_SPACING: Record<number, number> = {
  100: 1,
  500: 10,
  3000: 60,
  10000: 200,
};

// ==================== tick ↔ sqrtPriceX96 ====================

/**
 * tick → sqrtPriceX96，用定点 bigint 迭代。
 *
 * V3 的 price = 1.0001^tick，sqrtPrice = sqrt(price)。
 * sqrtPriceX96 = sqrtPrice × 2^96。
 *
 * 对于 tick 范围很大的值（如 -500000 ~ 500000），必须用定点整数避免
 * Math.pow 的浮点精度丢失。实现参考 TickMath.getSqrtRatioAtTick。
 *
 * 这里用简化版：将 1.0001 表示为定点整数 (1_0001 / 10_000)，
 * 然后用 bigint 重复平方算 1.0001^tick，最后取平方根得 sqrtPriceX96。
 *
 * 对大多数实用场景（tick 在 ±500000 内），精度足够。
 */
export function tickToSqrtPriceX96(tick: number): bigint {
  const absTick = tick < 0 ? -tick : tick;
  // 1.0001^absTick，用定点整数
  // 以 Q128 为精度基准：ratio = (10001/10000)^absTick
  // 最后 sqrt(ratio) * 2^96 = sqrtPriceX96
  // 即 sqrtPriceX96 = sqrt(10001^absTick / 10000^absTick) * 2^96
  //                  = 10001^(absTick/2) / 10000^(absTick/2) * 2^96
  // 当 absTick 为偶数时可以直接算；奇数时多乘一个 1.0001

  let ratio: bigint;
  const numerator = 10001n;
  const denominator = 10000n;

  if (absTick & 1) {
    // 奇数 tick：ratio = 1.0001 * 1.0001^(absTick-1)
    const halfPower = intPow(numerator, denominator, absTick - 1);
    ratio = (halfPower * numerator * Q128) / denominator;
  } else {
    const halfPower = intPow(numerator, denominator, absTick);
    ratio = halfPower;
  }

  // ratio 是以 Q128 为精度的 1.0001^absTick
  // sqrtPriceX96 = sqrt(ratio) * 2^(96-64) = sqrt(ratio / 2^128) * 2^96 = isqrt(ratio) >> 16
  // 因为 ratio 是 Q128，所以 isqrt(ratio) 是 Q64，右移 16 得 Q96 即 sqrtPriceX96
  const sqrtRatio = isqrt(ratio);
  const result = sqrtRatio >> 16n;

  return tick >= 0 ? result : (Q96 * Q96 * Q96) / result; // 负 tick 取倒数
}

/** bigint 整数平方根（Newton 法）。 */
function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error("isqrt of negative");
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

/**
 * 定点整数幂：计算 (base/denom)^exp，返回 Q128 定点结果。
 * base > denom，exp >= 0。
 * 用 repeated squaring。
 */
function intPow(base: bigint, denom: bigint, exp: number): bigint {
  let result = Q128; // 初始 = 1.0 (Q128)
  let baseRatio = (base * Q128) / denom; // base/denom in Q128
  let e = exp;
  while (e > 0) {
    if (e & 1) {
      result = (result * baseRatio) >> 128n;
    }
    baseRatio = (baseRatio * baseRatio) >> 128n;
    e >>= 1;
  }
  return result;
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
