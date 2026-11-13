/**
 * 统一「不稳定币 / 稳定币」展示坐标系与方向换算工具（前后端通用，零外部依赖）。
 *
 * 核心原则：
 *   1. 在 Uniswap V3 底层，原始价格恒为 `1 token0 = 1.0001^tick token1`。
 *   2. 当交易对未翻转（`flip = false`，如 W0G/USDC.e）时：
 *      - 展示口径：`1 token0 = X token1`
 *      - 主币上涨 → 原始 tick 增大 → 向 `tickUpper`（右端 100% 价格上界）移动。
 *   3. 当交易对已翻转（`flip = true`，如底层 USDC.e/WETH 翻转为 WETH/USDC.e）时：
 *      - 展示口径：`1 token1 = (1/X) token0`
 *      - 主币上涨 → 1 USDC 能换的 WETH 变少 → 原始 tick 减小（向 `tickLower` 移动）！
 *      - 因此在展示坐标系下：
 *          • 价格下界（0% / 左端）对应 `tickUpper`（`1 / rawPrice(tickUpper)`）
 *          • 价格上界（100% / 右端）对应 `tickLower`（`1 / rawPrice(tickLower)`）
 *          • 区间位置百分比 `displayMarginLowerPct = 100 - rawMarginLowerPct`
 *      - 统一后效果：全站任何池子均为 **左低右高、主币上涨向右（逼近上界 100%）、主币下跌向左（逼近下界 0%）**。
 */

const STABLE_SYMBOLS = new Set([
  "USDC",
  "USDC.E",
  "USDT",
  "OUSDT",
  "USDT0",
  "USDCE",
  "DAI",
  "FDUSD",
  "USDE",
  "FRAX",
  "BUSD",
  "TUSD",
  "LUSD",
  "PYUSD",
  "USDBC",
  "USD+",
]);

/** 判断代币符号是否为稳定币 */
export function isStableTokenSymbol(symbol?: string | null): boolean {
  if (!symbol) return false;
  const norm = symbol.trim().toUpperCase();
  if (STABLE_SYMBOLS.has(norm)) return true;
  if (norm.startsWith("USDC") || norm.startsWith("USDT")) return true;
  return false;
}

/**
 * 判断底层 token0/token1 是否属于「稳定币在前、非稳定币在后」（如 USDC.e/WETH、USDC.e/SOL），
 * 需要默认翻转为「不稳定币 / 稳定币」（WETH/USDC.e、SOL/USDC.e）。
 */
export function shouldAutoFlipPair(
  sym0?: string | null,
  sym1?: string | null
): boolean {
  return isStableTokenSymbol(sym0) && !isStableTokenSymbol(sym1);
}

/**
 * 推导最终生效的翻转状态：
 *   - 若显式传入了 pairFlip（0/1 或 boolean），以显式值为准；
 *   - 若未传入（null/undefined，如静态激励池配置），则自动按「不稳定币/稳定币」规则推导。
 */
export function resolveEffectiveFlip(
  sym0?: string | null,
  sym1?: string | null,
  pairFlip?: number | boolean | null
): boolean {
  if (pairFlip === 1 || pairFlip === true) return true;
  if (pairFlip === 0 || pairFlip === false) return false;
  return shouldAutoFlipPair(sym0, sym1);
}

/**
 * 将底层原始区间位置百分比（0=tickLower, 100=tickUpper）转换为展示坐标系百分比（0=价格下界, 100=价格上界）。
 */
export function toDisplayMarginPct(
  rawMarginLowerPct: number,
  flip: boolean
): number {
  return flip ? 100 - rawMarginLowerPct : rawMarginLowerPct;
}

/**
 * 将底层 0~1 相对区间位置转换为展示坐标系 0~1 位置（0=价格下界, 1=价格上界）。
 */
export function toDisplayMarginUnit(
  rawMarginLowerUnit: number,
  flip: boolean
): number {
  return flip ? 1 - rawMarginLowerUnit : rawMarginLowerUnit;
}

/**
 * 按展示坐标系计算 DEX 与 CEX 的汇率及价差：
 *   - `displayDiff > 0` 恒代表「在当前展示口径下 DEX 主币价格高于 CEX」
 *   - `displayDiff < 0` 恒代表「在当前展示口径下 DEX 主币价格低于 CEX」
 */
export function toDisplayPriceDiff(
  rawDexRate: number,
  rawCexRate: number,
  flip: boolean
): {
  displayDexRate: number;
  displayCexRate: number;
  displayDiff: number;
  displayAbsDiff: number;
  dexHigherThanCex: boolean;
} {
  const displayDexRate =
    flip && rawDexRate > 0 ? 1 / rawDexRate : rawDexRate;
  const displayCexRate =
    flip && rawCexRate > 0 ? 1 / rawCexRate : rawCexRate;
  const displayDiff =
    displayCexRate > 0
      ? (displayDexRate - displayCexRate) / displayCexRate
      : 0;
  return {
    displayDexRate,
    displayCexRate,
    displayDiff,
    displayAbsDiff: Math.abs(displayDiff),
    dexHigherThanCex: displayDiff > 0,
  };
}

/**
 * 判断越界方向（严格对齐展示坐标系的价格上下界）：
 *   - `isAboveUpper = true`  → 涨穿上界（高于价格上界）
 *   - `isAboveUpper = false` → 跌破下界（低于价格下界）
 */
export function getOutOfRangeDisplayDirection(
  currentTick: number,
  tickLower: number,
  tickUpper: number,
  flip: boolean
): {
  isAboveUpper: boolean;
  actionLabel: string;
  boundLabel: string;
} {
  const rawBelowLower = currentTick < tickLower;
  const rawAboveUpper = currentTick >= tickUpper;
  const isAboveUpper = flip ? rawBelowLower : rawAboveUpper;
  return {
    isAboveUpper,
    actionLabel: isAboveUpper ? "涨穿上界" : "跌破下界",
    boundLabel: isAboveUpper ? "高于上界" : "低于下界",
  };
}

/** 推断代币精度（优先取已知或缓存 decimals，兜底按常见地址与符号识别） */
export function inferDisplayTokenDecimals(
  tokenAddr?: string | null,
  symbol?: string | null,
  explicitDecimals?: number | null
): number {
  if (
    typeof explicitDecimals === "number" &&
    Number.isFinite(explicitDecimals) &&
    explicitDecimals > 0
  ) {
    return explicitDecimals;
  }
  const addr = (tokenAddr || "").toLowerCase();
  const sym = (symbol || "").toUpperCase();
  if (
    addr === "0x1f3aa82227281ca364bfb3d253b0f1af1da6473e" ||
    addr === "0x1217bfe6c773eec6cc4a38b5dc45b92292b6e189" ||
    sym.includes("USDC") ||
    sym.includes("USDT")
  ) {
    return 6;
  }
  if (
    addr === "0x0555e30da8f98308edb960aa94c0db47230d2b9c" ||
    sym.includes("BTC")
  ) {
    return 8;
  }
  if (
    addr === "0x2b269f9deb4804c5a4bd97e4d951c775beaa0cc5" ||
    sym === "SOL" ||
    sym === "WSOL"
  ) {
    return 9;
  }
  return 18;
}

/** 格式化人类可读价格（杜绝科学计数法与浮点尾数噪音） */
export function formatDisplayPrice(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1000) {
    return Number(n.toFixed(2)).toString();
  }
  if (abs >= 1) {
    let s = Number(n.toPrecision(7)).toFixed(4);
    s = s.replace(/0+$/, "").replace(/\.$/, "");
    return s || "0";
  }
  const clean = Number(n.toPrecision(6));
  const leadingZeros = Math.max(0, -Math.floor(Math.log10(abs)) - 1);
  const decimals = Math.min(18, leadingZeros + 6);
  let s = clean.toFixed(decimals);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return s || "0";
}

/**
 * 将任意链上 Tick 直接换算为当前展示口径下的人类可读价格（处理 ±887220 全区间极值）。
 */
export function tickToDisplayPrice(
  tick: number,
  dec0: number,
  dec1: number,
  flip: boolean
): string {
  if (!Number.isFinite(tick)) return "—";
  if (tick <= -880000) return flip ? "∞" : "0";
  if (tick >= 880000) return flip ? "0" : "∞";
  const rawHuman = Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
  if (!Number.isFinite(rawHuman) || rawHuman <= 0) return "—";
  const val = flip ? 1 / rawHuman : rawHuman;
  return formatDisplayPrice(val);
}

/**
 * 将链上 [tickLower, tickUpper] 换算为展示坐标系下的 [价格下界, 价格上界]（始终保证 priceLow <= priceHigh）。
 */
export function ticksToDisplayPriceRange(
  tickLower: number,
  tickUpper: number,
  dec0: number,
  dec1: number,
  flip: boolean
): { priceLow: string; priceHigh: string } {
  if (flip) {
    return {
      priceLow: tickToDisplayPrice(tickUpper, dec0, dec1, true),
      priceHigh: tickToDisplayPrice(tickLower, dec0, dec1, true),
    };
  }
  return {
    priceLow: tickToDisplayPrice(tickLower, dec0, dec1, false),
    priceHigh: tickToDisplayPrice(tickUpper, dec0, dec1, false),
  };
}
