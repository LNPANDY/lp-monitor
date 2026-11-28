/**
 * OKX Boost X-Liquidity（X Layer · Chain ID 196）实时池子雷达 + 多仓真实总收益统计引擎
 *
 * 核心能力：
 *  1. 实时读取 X Layer 全部 51 个活动 V3 池的 slot0 / liquidity / 池内余额 + OKX 最新 TVL/APY；
 *  2. 精准核算每个池子的有效集中倍数（EffConc）、8% 等价活跃流动性总量（Depth_8%）、
 *     真实净 LP 手续费（已扣 25% 协议费）、单池 OKX 固定日补、推荐资金区间；
 *  3. 实时枚举钱包在 X Layer 上的全部 Uniswap V3 NFT 仓位（持仓 + 精确待领手续费 + Bonus 宽度校验）
 *     与钱包滞留的主流币 / RWA 残币余额，结合 SQLite 资金与补贴台账，汇总最终真实总净赚：
 *       最终真实总收益 = 无常损失及买RWA损益 + 累计真实LP手续费 + 累计OKX补贴
 */
import { createPublicClient, fallback, formatUnits, http, parseAbi, type Address } from "viem";
import { getDb } from "@/lib/db";
import { getAmountsForLiquidity, tickToSqrtPriceX96 } from "@/lib/v3/math";
import {
  OKX_PHASE6_END_MS,
  OKX_PRODUCT_URL_BASE,
  OKX_XLAYER_POOLS,
  RWA_YAHOO_TICKERS,
  XLAYER_CHAIN_ID,
  XLAYER_MAJOR_TOKENS,
  XLAYER_RPCS,
  XLAYER_V3_FACTORY,
  XLAYER_V3_NPM,
  type OkxXLayerPoolMeta,
} from "./xlayer-catalog";

const Q96 = 1n << 96n;
const Q128 = 1n << 128n;
const MASK256 = (1n << 256n) - 1n;
const CONC_8PCT = 1 / (1 - Math.pow(1.08, -0.25)); // 52.471x (for total width 8%)

function subMod256(a: bigint, b: bigint): bigint {
  return (a - b) & MASK256;
}

const V3_POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function feeGrowthGlobal0X128() view returns (uint256)",
  "function feeGrowthGlobal1X128() view returns (uint256)",
  "function ticks(int24) view returns (uint128 liquidityGross, int128 liquidityNet, uint256 feeGrowthOutside0X128, uint256 feeGrowthOutside1X128, int56 tickCumulativeOutside, uint160 secondsPerLiquidityOutsideX128, uint32 secondsOutside, bool initialized)",
]);

const V3_FACTORY_ABI = parseAbi([
  "function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)",
]);

const V3_NPM_ABI = parseAbi([
  "function balanceOf(address owner) view returns (uint256)",
  "function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)",
  "function positions(uint256 tokenId) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
]);

const ERC20_ABI = parseAbi([
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]);

const ERC4626_ABI = parseAbi([
  "function convertToAssets(uint256 shares) view returns (uint256)",
]);

const xlayerClient = createPublicClient({
  chain: {
    id: XLAYER_CHAIN_ID,
    name: "X Layer",
    nativeCurrency: { name: "OKB", symbol: "OKB", decimals: 18 },
    rpcUrls: { default: { http: [...XLAYER_RPCS] } },
  },
  transport: fallback(
    XLAYER_RPCS.map((u) => http(u, { timeout: 10_000, retryCount: 1 })),
    { rank: false }
  ),
});

export interface OkxLivePoolMetrics extends OkxXLayerPoolMeta {
  okxUrl: string;
  currentTick: number;
  sqrtPriceX96: string;
  /** 1 token0 = price0In1 token1（已按 decimals 换算） */
  price0In1: number;
  /** token0 / token1 实时 USD 单价 */
  price0Usd: number;
  price1Usd: number;
  /** 展示方向：1 RWA(或主币) = displayPrice 主流币(或计价币) */
  displayInverted: boolean;
  /** 底层包装代币池价（1 wXXXx = ? 主流币） */
  displayPrice: number;
  /** ERC-4626 股息包装乘数比（baseMult / quoteMult），用于换算为 OKX 页面展示的原股价格 */
  wrapMultiplier: number;
  /** 扣除股息乘数后的链上原股价格（与 OKX 原股申购页价格、真实美股价格 1:1 对应） */
  unwrappedDexPrice: number;
  displayBaseSymbol: string;
  displayQuoteSymbol: string;
  /** 真实股票/ETF 行情比对（来自 Yahoo Finance，含常规盘与盘前/盘后报价） */
  realStockTicker: string | null;
  realMarket: "US" | "HK" | "EU" | "ETF" | "CRYPTO" | null;
  realRegularPrice: number | null;
  realExtPrice: number | null;
  realExtSession: "PRE" | "POST" | "REGULAR" | "24/7" | null;
  realExtTime: string | null;
  /** 链上原股 DEX 价 vs 真实常规盘/盘前盘后的精准折溢价 (%)：正=链上溢价(易砸)，负=链上折价(易拉) */
  spreadVsRegularPct: number | null;
  spreadVsExtPct: number | null;
  /** 协议抽成比例（0.25 = 25%），LP 净到手 = 1 - protocolFeeShare */
  protocolFeeShare: number;
  /** 池内实时链上余额与 TVL */
  bal0: number;
  bal1: number;
  onchainTvlUsd: number;
  okxTvlUsd: number;
  /** 标称 7d LP Base APY 与 OKX Bonus APY (%) */
  okxBaseApyPct: number;
  okxBonusApyPct: number;
  okxTotalApyPct: number;
  /** 当前活跃流动性 L 与有效集中倍数 */
  activeLiquidity: string;
  effConc: number;
  /** 8% 总宽度（~800 ticks）等价活跃流动性总量（USD） */
  depth8pctUsd: number;
  /** 推算全池真实 24h 净 LP 手续费（USD，已含 25% 协议费扣除） */
  poolDailyLpFeeUsd: number;
  /** 推荐起手 & 舒适资金上限（USD，按 20% 自我稀释上限测算） */
  recMinUsd: number;
  recMaxUsd: number;
  updatedAt: string;
}

export interface OkxPoolsSnapshotResponse {
  updatedAt: string;
  phase6EndMs: number;
  totalPools: number;
  okxSynced: boolean;
  realQuotesCount: number;
  majorPricesUsd: Record<string, number>;
  tokenPricesUsd: Record<string, number>;
  pools: OkxLivePoolMetrics[];
}

interface CacheBox {
  snapshot: OkxPoolsSnapshotResponse | null;
  fetchedAt: number;
  multMap: Record<string, number>;
  multFetchedAt: number;
}

const GLOBAL_KEY = "__lpMonitorOkxXLayerCache__";
const CACHE_TTL_MS = 60_000;
const MULT_TTL_MS = 10 * 60_000;

function getCache(): CacheBox {
  const g = globalThis as any;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = { snapshot: null, fetchedAt: 0, multMap: {}, multFetchedAt: 0 } as CacheBox;
  }
  return g[GLOBAL_KEY] as CacheBox;
}

async function mapConcurrent<T, R>(items: T[], conc: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  for (let i = 0; i < items.length; i += conc) {
    const slice = items.slice(i, i + conc);
    const out = await Promise.all(slice.map(fn));
    for (let j = 0; j < out.length; j++) results[i + j] = out[j];
  }
  return results;
}

/** 从 Binance 拉取主流币与黄金现货 USD 价格（BTC/ETH/SOL/PAXG）。 */
async function fetchBinanceMajorPrices(): Promise<Record<string, number>> {
  const out: Record<string, number> = {
    USDG: 1,
    USDC: 1,
    USDT0: 1,
    BTC: 60000,
    ETH: 1650,
    SOL: 120,
    OKB: 45,
    PAXG: 3650,
  };
  try {
    const pairs = [
      ["BTC", "BTCUSDT"],
      ["ETH", "ETHUSDT"],
      ["SOL", "SOLUSDT"],
      ["PAXG", "PAXGUSDT"],
    ] as const;
    await Promise.all(
      pairs.map(async ([k, sym]) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        try {
          const r = await fetch(
            `https://data-api.binance.vision/api/v3/ticker/price?symbol=${sym}`,
            { signal: ctrl.signal, cache: "no-store" }
          );
          if (r.ok) {
            const j = await r.json();
            const px = Number(j?.price);
            if (Number.isFinite(px) && px > 0) out[k] = px;
          }
        } catch {
        } finally {
          clearTimeout(t);
        }
      })
    );
  } catch {}
  return out;
}

/** 读取所有 wXXXx (ERC-4626) 股息包装乘数 convertToAssets(1e18)，10 分钟缓存。 */
async function fetchWrappedRwaMultipliers(): Promise<Record<string, number>> {
  const cache = getCache();
  const now = Date.now();
  if (Object.keys(cache.multMap).length > 0 && now - cache.multFetchedAt < MULT_TTL_MS) {
    return cache.multMap;
  }
  const wrappedAddrs = new Set<string>();
  for (const p of OKX_XLAYER_POOLS) {
    if (p.token0Symbol.startsWith("w")) wrappedAddrs.add(p.token0);
    if (p.token1Symbol.startsWith("w")) wrappedAddrs.add(p.token1);
  }
  const oneE18 = 10n ** 18n;
  const out: Record<string, number> = {};
  await mapConcurrent(Array.from(wrappedAddrs), 12, async (addr) => {
    try {
      const assets = await xlayerClient.readContract({
        address: addr as Address,
        abi: ERC4626_ABI,
        functionName: "convertToAssets",
        args: [oneE18],
      });
      const m = Number(formatUnits(assets, 18));
      out[addr] = Number.isFinite(m) && m > 0.5 && m < 5 ? m : 1;
    } catch {
      out[addr] = 1;
    }
  });
  cache.multMap = out;
  cache.multFetchedAt = now;
  return out;
}

interface RealStockQuoteUsd {
  ticker: string;
  market: "US" | "HK" | "EU" | "ETF";
  regUsd: number;
  extUsd: number;
  session: "PRE" | "POST" | "REGULAR";
  extTime: string | null;
}

/** 并行从 Yahoo Finance 拉取全部美股/港股/欧股常规盘与盘前/盘后报价，并换算为 USD。 */
async function fetchRealStockQuotes(): Promise<Record<string, RealStockQuoteUsd>> {
  const uniqueTickers = Array.from(
    new Set([
      ...Object.values(RWA_YAHOO_TICKERS).map((x) => x.ticker),
      "HKD=X",
      "EURUSD=X",
      "GBPUSD=X",
    ])
  );

  interface RawYf {
    ticker: string;
    currency: string;
    reg: number;
    ext: number;
    session: "PRE" | "POST" | "REGULAR";
    extTime: string | null;
  }

  const rawList = await mapConcurrent(uniqueTickers, 12, async (ticker): Promise<RawYf | null> => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 7000);
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        ticker
      )}?interval=5m&range=1d&includePrePost=true`;
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" },
        signal: ctrl.signal,
        cache: "no-store",
      });
      if (!res.ok) return null;
      const j = await res.json();
      const result = j?.chart?.result?.[0];
      const meta = result?.meta;
      const reg = Number(meta?.regularMarketPrice);
      if (!Number.isFinite(reg) || reg <= 0) return null;

      const closes: (number | null)[] = result?.indicators?.quote?.[0]?.close || [];
      const timestamps: number[] = result?.timestamp || [];
      let ext = reg;
      let extTs = Number(meta?.regularMarketTime) || 0;
      for (let i = closes.length - 1; i >= 0; i--) {
        const c = closes[i];
        if (c !== null && c !== undefined && Number.isFinite(c) && c > 0) {
          ext = c;
          extTs = timestamps[i] || extTs;
          break;
        }
      }

      const regStart = Number(meta?.currentTradingPeriod?.regular?.start) || 0;
      const regEnd = Number(meta?.currentTradingPeriod?.regular?.end) || 0;
      let session: "PRE" | "POST" | "REGULAR" = "REGULAR";
      if (regEnd > 0 && extTs > regEnd) session = "POST";
      else if (regStart > 0 && extTs < regStart) session = "PRE";

      const extTime = extTs
        ? new Date(extTs * 1000 + 8 * 3600_000).toISOString().replace("T", " ").slice(5, 16)
        : null;

      return {
        ticker,
        currency: String(meta?.currency || "USD"),
        reg,
        ext,
        session,
        extTime,
      };
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  });

  const rawByTicker: Record<string, RawYf> = {};
  for (const r of rawList) {
    if (r) rawByTicker[r.ticker] = r;
  }

  const hkdPerUsd = rawByTicker["HKD=X"]?.reg || 7.8;
  const usdPerEur = rawByTicker["EURUSD=X"]?.reg || 1.09;
  const usdPerGbp = rawByTicker["GBPUSD=X"]?.reg || 1.31;

  const toUsd = (val: number, currency: string): number => {
    if (currency === "USD") return val;
    if (currency === "HKD") return val / hkdPerUsd;
    if (currency === "EUR") return val * usdPerEur;
    if (currency === "GBp") return (val / 100) * usdPerGbp;
    if (currency === "GBP") return val * usdPerGbp;
    return val;
  };

  const out: Record<string, RealStockQuoteUsd> = {};
  for (const [cleanKey, meta] of Object.entries(RWA_YAHOO_TICKERS)) {
    const q = rawByTicker[meta.ticker];
    if (!q) continue;
    out[cleanKey] = {
      ticker: meta.ticker,
      market: meta.market,
      regUsd: toUsd(q.reg, q.currency),
      extUsd: toUsd(q.ext, q.currency),
      session: q.session,
      extTime: q.extTime,
    };
  }
  return out;
}

function cleanRwaBaseKey(sym: string): string {
  return sym.replace(/^w/, "").replace(/[xy]$/, "");
}

interface OkxRemotePoolInfo {
  tvl: number;
  baseApyPct: number;
  bonusApyPct: number;
  totalApyPct: number;
}

/** 拉取 OKX X-Liquidity 活动页实时 TVL 与 APY（优雅降级，不影响链上主流程）。 */
async function fetchOkxEventMetrics(): Promise<{
  ok: boolean;
  byName: Record<string, OkxRemotePoolInfo>;
}> {
  const byName: Record<string, OkxRemotePoolInfo> = {};
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const res = await fetch("https://web3.okx.com/zh-hans/boost/x-liquidity/event", {
      headers: {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, byName };
    const html = await res.text();
    // 精确提取 window.__INIT_STATE__.appContext = parseData("...", ...) 中的 JSON 字符串
    const marker = "window.__INIT_STATE__.appContext = parseData(";
    const startIdx = html.indexOf(marker);
    if (startIdx === -1) return { ok: false, byName };
    const quoteStart = html.indexOf('"', startIdx + marker.length);
    if (quoteStart === -1) return { ok: false, byName };
    // 扫描转义双引号找到闭合引号
    let i = quoteStart + 1;
    let escaped = false;
    while (i < html.length) {
      const ch = html[i];
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        break;
      }
      i++;
    }
    if (i >= html.length) return { ok: false, byName };
    const literal = html.slice(quoteStart, i + 1);
    const jsonText = JSON.parse(literal) as string;
    const parsed = JSON.parse(jsonText);
    const displayList =
      parsed?.appContext?.initialProps?.XLiquidity?.activityData?.displayList ||
      parsed?.initialProps?.XLiquidity?.activityData?.displayList ||
      [];
    for (const cat of displayList) {
      if (cat?.category !== "LIQUIDITY_POOL") continue;
      for (const tag of cat.tagList || []) {
        for (const inv of tag.investments || []) {
          const name = String(inv?.investmentName || "");
          if (!name) continue;
          const tvl = Number(inv?.tvl || 0);
          const totalApy = Number(inv?.apy || 0) * 100;
          let baseApy = 0;
          let bonusApy = 0;
          for (const r of inv?.rateDetail || []) {
            if (r?.type === 4 || r?.type === 1) baseApy += Number(r.rate || 0) * 100;
            if (r?.type === 6) bonusApy += Number(r.rate || 0) * 100;
          }
          byName[name] = { tvl, baseApyPct: baseApy, bonusApyPct: bonusApy, totalApyPct: totalApy };
        }
      }
    }
    return { ok: Object.keys(byName).length > 5, byName };
  } catch {
    return { ok: false, byName };
  } finally {
    clearTimeout(timer);
  }
}

function decodeProtocolFeeShare(feeProtocol: number): number {
  const f0 = feeProtocol & 0x0f;
  const f1 = (feeProtocol >> 4) & 0x0f;
  const p0 = f0 > 0 ? 1 / f0 : 0;
  const p1 = f1 > 0 ? 1 / f1 : 0;
  return (p0 + p1) / 2;
}

/** 实时拉取全部 51 个 OKX X-Liquidity V3 池的链上数据与集中度分析。 */
export async function fetchOkxXLayerPoolsSnapshot(opts?: {
  force?: boolean;
}): Promise<OkxPoolsSnapshotResponse> {
  const cache = getCache();
  const now = Date.now();
  if (!opts?.force && cache.snapshot && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.snapshot;
  }

  const [majorSpot, okxRemote, multMap, realStockQuotes] = await Promise.all([
    fetchBinanceMajorPrices(),
    fetchOkxEventMetrics(),
    fetchWrappedRwaMultipliers(),
    fetchRealStockQuotes(),
  ]);

  // 并行读取 51 个 V3 池的 slot0 / liquidity / 双币余额
  const rawReads = await mapConcurrent(OKX_XLAYER_POOLS, 8, async (meta) => {
    try {
      const pool = meta.poolAddress as Address;
      const t0 = meta.token0 as Address;
      const t1 = meta.token1 as Address;
      const [slot0, liq, b0, b1] = await Promise.all([
        xlayerClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" }),
        xlayerClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "liquidity" }),
        xlayerClient.readContract({ address: t0, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] }),
        xlayerClient.readContract({ address: t1, abi: ERC20_ABI, functionName: "balanceOf", args: [pool] }),
      ]);
      const sqrtPriceX96 = slot0[0];
      const currentTick = Number(slot0[1]);
      const feeProtocol = Number(slot0[5]);
      const S = Number(sqrtPriceX96) / Number(Q96);
      // 1 token0 = S^2 * 10^(dec0 - dec1) token1
      const price0In1 = S * S * Math.pow(10, meta.dec0 - meta.dec1);
      const bal0 = Number(formatUnits(b0, meta.dec0));
      const bal1 = Number(formatUnits(b1, meta.dec1));
      const virtualFullRaw1 = 2 * Number(liq) * S;
      const actualPoolRaw1 = Number(b0) * S * S + Number(b1);
      const effConc = actualPoolRaw1 > 0 ? virtualFullRaw1 / actualPoolRaw1 : 0;
      return {
        meta,
        ok: true,
        sqrtPriceX96,
        currentTick,
        feeProtocol,
        liq,
        price0In1,
        bal0,
        bal1,
        effConc,
      };
    } catch {
      return {
        meta,
        ok: false,
        sqrtPriceX96: 0n,
        currentTick: 0,
        feeProtocol: 68,
        liq: 0n,
        price0In1: 0,
        bal0: 0,
        bal1: 0,
        effConc: 0,
      };
    }
  });

  // 构建全链 token USD 价格表（先填已知主流币，再用链上池价迭代 2 轮反推全部 RWA 代币实时 USD 单价）
  const tokenPricesUsd: Record<string, number> = {
    "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8": 1, // USDG
    "0xb6ceceab302e2e4948951ee7843fc24e92933061": 1, // USDC
    "0x779ded0c9e1022225f8e0630b35a9b54be713736": 1, // USDT0
    "0xb7c00000bcdeef966b20b3d884b98e64d2b06b4f": majorSpot.BTC, // xBTC
    "0xe7b000003a45145decf8a28fc755ad5ec5ea025a": majorSpot.ETH, // xETH
    "0x505000008de8748dbd4422ff4687a4fc9beba15b": majorSpot.SOL, // xSOL
  };

  for (let pass = 0; pass < 3; pass++) {
    for (const r of rawReads) {
      if (!r.ok || r.price0In1 <= 0) continue;
      const a0 = r.meta.token0;
      const a1 = r.meta.token1;
      if (tokenPricesUsd[a0] && !tokenPricesUsd[a1]) {
        tokenPricesUsd[a1] = tokenPricesUsd[a0] / r.price0In1;
      } else if (tokenPricesUsd[a1] && !tokenPricesUsd[a0]) {
        tokenPricesUsd[a0] = tokenPricesUsd[a1] * r.price0In1;
      }
    }
  }
  const wokbAddr = "0xe538905cf8410324e03a5a23c1c177a474d59b2b";
  if (tokenPricesUsd[wokbAddr]) {
    majorSpot.OKB = tokenPricesUsd[wokbAddr];
  }

  /** 根据资产符号返回真实外部报价（美股/港股/欧股/黄金/主流币），用于精确比对折溢价 */
  const resolveExternalQuote = (
    sym: string
  ): {
    regUsd: number;
    extUsd: number;
    ticker: string | null;
    market: "US" | "HK" | "EU" | "ETF" | "CRYPTO" | null;
    session: "PRE" | "POST" | "REGULAR" | "24/7";
    extTime: string | null;
  } | null => {
    if (sym === "USDG" || sym === "USDC" || sym === "USDT0") {
      return { regUsd: 1, extUsd: 1, ticker: null, market: null, session: "24/7", extTime: null };
    }
    if (sym === "xBTC") {
      return { regUsd: majorSpot.BTC, extUsd: majorSpot.BTC, ticker: "BTCUSDT", market: "CRYPTO", session: "24/7", extTime: null };
    }
    if (sym === "xETH") {
      return { regUsd: majorSpot.ETH, extUsd: majorSpot.ETH, ticker: "ETHUSDT", market: "CRYPTO", session: "24/7", extTime: null };
    }
    if (sym === "xSOL") {
      return { regUsd: majorSpot.SOL, extUsd: majorSpot.SOL, ticker: "SOLUSDT", market: "CRYPTO", session: "24/7", extTime: null };
    }
    const baseKey = cleanRwaBaseKey(sym);
    if (baseKey === "PAXG") {
      return { regUsd: majorSpot.PAXG, extUsd: majorSpot.PAXG, ticker: "PAXGUSDT", market: "CRYPTO", session: "24/7", extTime: null };
    }
    const q = realStockQuotes[baseKey];
    if (!q) return null;
    return {
      regUsd: q.regUsd,
      extUsd: q.extUsd,
      ticker: q.ticker,
      market: q.market,
      session: q.session,
      extTime: q.extTime,
    };
  };

  const updatedAt = new Date().toISOString();
  let realQuotesCount = 0;
  const pools: OkxLivePoolMetrics[] = rawReads.map((r) => {
    const m = r.meta;
    const p0 = tokenPricesUsd[m.token0] || 0;
    const p1 = tokenPricesUsd[m.token1] || 0;
    const onchainTvlUsd = r.bal0 * p0 + r.bal1 * p1;
    const remote = okxRemote.byName[m.name];
    const tvl = remote?.tvl && remote.tvl > 0 ? remote.tvl : onchainTvlUsd;
    const baseApyPct = remote?.baseApyPct ?? 0;
    const bonusApyPct = remote?.bonusApyPct ?? (tvl > 0 ? Math.min(100, (m.okxDailyUsd * 365 / tvl) * 100) : 0);
    const totalApyPct = remote?.totalApyPct ?? (baseApyPct + bonusApyPct);

    const depth8pctUsd = tvl > 0 && r.effConc > 0 ? tvl * (r.effConc / CONC_8PCT) : 0;
    const poolDailyLpFeeUsd = (baseApyPct / 100) * tvl / 365;
    const protocolFeeShare = decodeProtocolFeeShare(r.feeProtocol);

    // 统一展示为「1 非主流/RWA = ? 主流币」便于直观操作 95% 主流 + 5% RWA
    const displayInverted = m.majorSide === "token0";
    const displayPrice =
      r.price0In1 > 0 ? (displayInverted ? 1 / r.price0In1 : r.price0In1) : 0;
    const displayBaseAddr = displayInverted ? m.token1 : m.token0;
    const displayQuoteAddr = displayInverted ? m.token0 : m.token1;
    const displayBaseSymbol = displayInverted ? m.token1Symbol : m.token0Symbol;
    const displayQuoteSymbol = displayInverted ? m.token0Symbol : m.token1Symbol;

    // 精确扣除 ERC-4626 股息包装乘数：1 wBase = baseMult * Base => 1 Base = (displayPrice / (baseMult / quoteMult)) Quote
    const baseMult = multMap[displayBaseAddr] ?? 1;
    const quoteMult = multMap[displayQuoteAddr] ?? 1;
    const wrapMultiplier = quoteMult > 0 ? baseMult / quoteMult : 1;
    const unwrappedDexPrice = wrapMultiplier > 0 ? displayPrice / wrapMultiplier : displayPrice;

    // 比对真实外部股价（常规盘 + 盘前/盘后）
    let realStockTicker: string | null = null;
    let realMarket: "US" | "HK" | "EU" | "ETF" | "CRYPTO" | null = null;
    let realRegularPrice: number | null = null;
    let realExtPrice: number | null = null;
    let realExtSession: "PRE" | "POST" | "REGULAR" | "24/7" | null = null;
    let realExtTime: string | null = null;
    let spreadVsRegularPct: number | null = null;
    let spreadVsExtPct: number | null = null;

    if (unwrappedDexPrice > 0) {
      const bq = resolveExternalQuote(displayBaseSymbol);
      const qq = resolveExternalQuote(displayQuoteSymbol);
      if (bq && qq && qq.regUsd > 0 && qq.extUsd > 0 && bq.ticker) {
        realStockTicker = qq.ticker ? `${bq.ticker}/${qq.ticker}` : bq.ticker;
        realMarket = bq.market;
        realRegularPrice = bq.regUsd / qq.regUsd;
        realExtPrice = bq.extUsd / qq.extUsd;
        realExtSession = bq.session !== "24/7" ? bq.session : qq.session;
        realExtTime = bq.extTime || qq.extTime;
        spreadVsRegularPct = Number((((unwrappedDexPrice - realRegularPrice) / realRegularPrice) * 100).toFixed(2));
        spreadVsExtPct = Number((((unwrappedDexPrice - realExtPrice) / realExtPrice) * 100).toFixed(2));
        realQuotesCount++;
      }
    }

    // 推荐资金：按 20% 自我稀释上限（cap = depth8pct * 0.25）给出舒适上限，最低 $500，上限 $15,000
    const recMaxUsd =
      depth8pctUsd > 0
        ? Math.max(500, Math.min(15000, Math.round((depth8pctUsd * 0.25) / 100) * 100))
        : 1000;
    const recMinUsd = Math.min(recMaxUsd, depth8pctUsd < 10000 ? 500 : 1000);

    return {
      ...m,
      okxUrl: `${OKX_PRODUCT_URL_BASE}/${m.detailPath}`,
      currentTick: r.currentTick,
      sqrtPriceX96: r.sqrtPriceX96.toString(),
      price0In1: r.price0In1,
      price0Usd: p0,
      price1Usd: p1,
      displayInverted,
      displayPrice,
      wrapMultiplier: Number(wrapMultiplier.toFixed(6)),
      unwrappedDexPrice,
      displayBaseSymbol,
      displayQuoteSymbol,
      realStockTicker,
      realMarket,
      realRegularPrice,
      realExtPrice,
      realExtSession,
      realExtTime,
      spreadVsRegularPct,
      spreadVsExtPct,
      protocolFeeShare,
      bal0: r.bal0,
      bal1: r.bal1,
      onchainTvlUsd: Math.round(onchainTvlUsd),
      okxTvlUsd: Math.round(tvl),
      okxBaseApyPct: Number(baseApyPct.toFixed(2)),
      okxBonusApyPct: Number(bonusApyPct.toFixed(2)),
      okxTotalApyPct: Number(totalApyPct.toFixed(2)),
      activeLiquidity: r.liq.toString(),
      effConc: Number(r.effConc.toFixed(2)),
      depth8pctUsd: Math.round(depth8pctUsd),
      poolDailyLpFeeUsd: Number(poolDailyLpFeeUsd.toFixed(2)),
      recMinUsd,
      recMaxUsd,
      updatedAt,
    };
  });

  const snapshot: OkxPoolsSnapshotResponse = {
    updatedAt,
    phase6EndMs: OKX_PHASE6_END_MS,
    totalPools: pools.length,
    okxSynced: okxRemote.ok,
    realQuotesCount,
    majorPricesUsd: majorSpot,
    tokenPricesUsd,
    pools,
  };
  cache.snapshot = snapshot;
  cache.fetchedAt = now;
  return snapshot;
}

// ==================== 多仓真实总收益台账引擎 ====================

export type OkxLedgerEntryType =
  | "deposit"
  | "withdraw"
  | "rwa_buy_cost"
  | "lp_fee_realized"
  | "okx_bonus";

export interface OkxLedgerEntry {
  id: number;
  walletAddress: string;
  entryType: OkxLedgerEntryType;
  amountUsd: number;
  poolName: string;
  tokenId: string;
  note: string;
  occurredAt: string;
  createdAt: string;
}

export function listOkxLedgerEntries(walletAddress: string): OkxLedgerEntry[] {
  const db = getDb();
  const w = walletAddress.trim().toLowerCase();
  const rows = db
    .prepare(
      `SELECT * FROM okx_xlayer_ledger_entries
       WHERE LOWER(wallet_address)=? OR wallet_address=''
       ORDER BY occurred_at DESC, id DESC`
    )
    .all(w) as any[];
  return rows.map((r) => ({
    id: r.id,
    walletAddress: r.wallet_address,
    entryType: r.entry_type as OkxLedgerEntryType,
    amountUsd: Number(r.amount_usd) || 0,
    poolName: r.pool_name || "",
    tokenId: r.token_id || "",
    note: r.note || "",
    occurredAt: r.occurred_at || "",
    createdAt: r.created_at || "",
  }));
}

export function addOkxLedgerEntry(input: {
  walletAddress: string;
  entryType: OkxLedgerEntryType;
  amountUsd: number;
  poolName?: string;
  tokenId?: string;
  note?: string;
  occurredAt?: string;
}): OkxLedgerEntry {
  const db = getDb();
  const w = input.walletAddress.trim().toLowerCase();
  const amt = Math.max(0, Number(input.amountUsd) || 0);
  const occurred = input.occurredAt?.trim() || new Date().toISOString().replace("T", " ").slice(0, 19);
  const res = db
    .prepare(
      `INSERT INTO okx_xlayer_ledger_entries
        (wallet_address, entry_type, amount_usd, pool_name, token_id, note, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      w,
      input.entryType,
      amt,
      (input.poolName || "").trim(),
      (input.tokenId || "").trim(),
      (input.note || "").trim(),
      occurred
    );
  const row = db
    .prepare("SELECT * FROM okx_xlayer_ledger_entries WHERE id=?")
    .get(Number(res.lastInsertRowid)) as any;
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    entryType: row.entry_type,
    amountUsd: Number(row.amount_usd) || 0,
    poolName: row.pool_name || "",
    tokenId: row.token_id || "",
    note: row.note || "",
    occurredAt: row.occurred_at || "",
    createdAt: row.created_at || "",
  };
}

export function deleteOkxLedgerEntry(id: number): boolean {
  const db = getDb();
  const res = db.prepare("DELETE FROM okx_xlayer_ledger_entries WHERE id=?").run(id);
  return res.changes > 0;
}

export interface XLayerLivePosition {
  tokenId: string;
  poolAddress: string;
  poolName: string;
  okxUrl: string;
  token0: string;
  token1: string;
  token0Symbol: string;
  token1Symbol: string;
  fee: number;
  tickLower: number;
  tickUpper: number;
  tickWidth: number;
  bonusEligible: boolean;
  currentTick: number;
  inRange: boolean;
  marginLowerPct: number;
  marginUpperPct: number;
  liquidity: string;
  amount0: number;
  amount1: number;
  valueUsd: number;
  fees0: number;
  fees1: number;
  uncollectedFeesUsd: number;
  activeSharePct: number;
  estDailyLpFeeUsd: number;
  estDailyOkxBonusUsd: number;
}

export interface XLayerWalletAsset {
  address: string;
  symbol: string;
  isMajor: boolean;
  balance: number;
  priceUsd: number;
  valueUsd: number;
}

export interface OkxXLayerPortfolioPnl {
  walletAddress: string;
  updatedAt: string;
  activePositions: XLayerLivePosition[];
  closedTokenIds: { tokenId: string; poolName: string; tickLower: number; tickUpper: number }[];
  walletAssets: XLayerWalletAsset[];
  entries: OkxLedgerEntry[];
  summary: {
    /** 总入金（deposit + rwa_buy_cost） */
    totalDepositedUsd: number;
    /** 其中单列记录的买 RWA 成本 */
    totalRwaBuyCostUsd: number;
    /** 累计提现回笼（withdraw） */
    totalWithdrawnUsd: number;
    /** 净投入本金 = 总入金 - 累计提现回笼 */
    netCapitalInvestedUsd: number;
    /** 链上在池活跃 LP 双币当前价值 */
    activeLpHoldingsUsd: number;
    /** 钱包滞留资产价值（主流币 + 未入池/残余 RWA 币） */
    walletIdleHoldingsUsd: number;
    /** 其中滞留 RWA 币现值 */
    walletIdleRwaUsd: number;
    /** 当前链上总持仓价值（活跃 LP + 钱包滞留资产） */
    currentTotalHoldingsUsd: number;
    /** 无常损失 & 买 RWA 币价损益 = 当前总持仓 - 净投入本金 */
    ilAndRwaPnlUsd: number;
    /** 在池待领取净 LP 手续费 */
    uncollectedLpFeesUsd: number;
    /** 台账已记录的已领/平仓实收 LP 手续费 */
    realizedLpFeesUsd: number;
    /** 累计真实 LP 手续费总计 */
    totalLpFeesUsd: number;
    /** 累计 OKX 奖励金（USDG） */
    totalOkxBonusUsd: number;
    /** 最终真实净收益（U 本位） = 无常损失及买RWA损益 + 累计LP手续费 + 累计OKX补贴 */
    finalNetProfitUsd: number;
    /** 真实总收益率 (%) = 最终真实净收益 / 总入金 */
    finalRoiPct: number | null;
    /** 当前活跃仓位合计预估日产出（LP 费 + OKX 补贴） */
    estActiveDailyTotalUsd: number;
  };
}

/** 获取默认监控钱包地址（若用户未传参则取 wallets 表第一条启用钱包）。 */
export function resolveDefaultWalletAddress(): string {
  const db = getDb();
  const row = db
    .prepare("SELECT address FROM wallets WHERE enabled=1 ORDER BY id ASC LIMIT 1")
    .get() as { address?: string } | undefined;
  return row?.address || "";
}

/** 扫描钱包在 X Layer 上的所有 V3 仓位、滞留 RWA/主流币余额，结合台账汇总真实总收益。 */
export async function fetchOkxXLayerPortfolioPnl(
  rawWalletAddress?: string
): Promise<OkxXLayerPortfolioPnl> {
  const walletAddress = (rawWalletAddress || resolveDefaultWalletAddress()).trim();
  const snapshot = await fetchOkxXLayerPoolsSnapshot();
  const tokenPrices = snapshot.tokenPricesUsd;
  const poolByAddr = new Map(snapshot.pools.map((p) => [p.poolAddress.toLowerCase(), p]));
  const updatedAt = new Date().toISOString();

  if (!walletAddress || !/^0x[0-9a-fA-F]{40}$/.test(walletAddress)) {
    return {
      walletAddress: "",
      updatedAt,
      activePositions: [],
      closedTokenIds: [],
      walletAssets: [],
      entries: [],
      summary: {
        totalDepositedUsd: 0,
        totalRwaBuyCostUsd: 0,
        totalWithdrawnUsd: 0,
        netCapitalInvestedUsd: 0,
        activeLpHoldingsUsd: 0,
        walletIdleHoldingsUsd: 0,
        walletIdleRwaUsd: 0,
        currentTotalHoldingsUsd: 0,
        ilAndRwaPnlUsd: 0,
        uncollectedLpFeesUsd: 0,
        realizedLpFeesUsd: 0,
        totalLpFeesUsd: 0,
        totalOkxBonusUsd: 0,
        finalNetProfitUsd: 0,
        finalRoiPct: null,
        estActiveDailyTotalUsd: 0,
      },
    };
  }

  const wallet = walletAddress as Address;

  // 1. 枚举钱包在 X Layer Uniswap V3 NPM 下的全部 NFT 仓位
  let nftCount = 0;
  try {
    const bal = await xlayerClient.readContract({
      address: XLAYER_V3_NPM,
      abi: V3_NPM_ABI,
      functionName: "balanceOf",
      args: [wallet],
    });
    nftCount = Math.min(Number(bal), 60);
  } catch {}

  const tokenIds = await mapConcurrent(
    Array.from({ length: nftCount }, (_, i) => i),
    8,
    async (idx) => {
      try {
        return await xlayerClient.readContract({
          address: XLAYER_V3_NPM,
          abi: V3_NPM_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [wallet, BigInt(idx)],
        });
      } catch {
        return null;
      }
    }
  );

  const validIds = tokenIds.filter((x): x is bigint => x !== null);
  const activePositions: XLayerLivePosition[] = [];
  const closedTokenIds: { tokenId: string; poolName: string; tickLower: number; tickUpper: number }[] = [];

  await mapConcurrent(validIds, 6, async (tid) => {
    try {
      const pos = await xlayerClient.readContract({
        address: XLAYER_V3_NPM,
        abi: V3_NPM_ABI,
        functionName: "positions",
        args: [tid],
      });
      const token0 = pos[2].toLowerCase();
      const token1 = pos[3].toLowerCase();
      const fee = Number(pos[4]);
      const tickLower = Number(pos[5]);
      const tickUpper = Number(pos[6]);
      const liquidity = pos[7];
      const fgLast0 = pos[8];
      const fgLast1 = pos[9];
      const owed0 = pos[10];
      const owed1 = pos[11];

      const poolAddr = (
        await xlayerClient.readContract({
          address: XLAYER_V3_FACTORY,
          abi: V3_FACTORY_ABI,
          functionName: "getPool",
          args: [pos[2], pos[3], fee],
        })
      ).toLowerCase();

      const matched = poolByAddr.get(poolAddr);
      const poolName = matched?.name || `${token0.slice(0, 6)}-${token1.slice(0, 6)}`;

      if (liquidity === 0n && owed0 === 0n && owed1 === 0n) {
        closedTokenIds.push({ tokenId: tid.toString(), poolName, tickLower, tickUpper });
        return;
      }

      const [slot0, poolLiq, fg0, fg1, lowerInfo, upperInfo] = await Promise.all([
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "slot0" }),
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "liquidity" }),
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal0X128" }),
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "feeGrowthGlobal1X128" }),
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "ticks", args: [tickLower] }),
        xlayerClient.readContract({ address: poolAddr as Address, abi: V3_POOL_ABI, functionName: "ticks", args: [tickUpper] }),
      ]);

      const sqrtPriceX96 = slot0[0];
      const currentTick = Number(slot0[1]);
      const inRange = currentTick >= tickLower && currentTick < tickUpper;
      const dec0 = matched?.dec0 ?? 18;
      const dec1 = matched?.dec1 ?? 18;
      const sym0 = matched?.token0Symbol ?? "T0";
      const sym1 = matched?.token1Symbol ?? "T1";

      const { amount0: amt0Str, amount1: amt1Str } = getAmountsForLiquidity(
        sqrtPriceX96,
        tickToSqrtPriceX96(tickLower),
        tickToSqrtPriceX96(tickUpper),
        liquidity,
        dec0,
        dec1
      );
      const amount0 = Number(amt0Str) || 0;
      const amount1 = Number(amt1Str) || 0;

      const below0 = currentTick >= tickLower ? lowerInfo[2] : subMod256(fg0, lowerInfo[2]);
      const below1 = currentTick >= tickLower ? lowerInfo[3] : subMod256(fg1, lowerInfo[3]);
      const above0 = currentTick < tickUpper ? upperInfo[2] : subMod256(fg0, upperInfo[2]);
      const above1 = currentTick < tickUpper ? upperInfo[3] : subMod256(fg1, upperInfo[3]);
      const inside0 = subMod256(subMod256(fg0, below0), above0);
      const inside1 = subMod256(subMod256(fg1, below1), above1);
      const fees0Raw = owed0 + (subMod256(inside0, fgLast0) * liquidity) / Q128;
      const fees1Raw = owed1 + (subMod256(inside1, fgLast1) * liquidity) / Q128;
      const fees0 = Number(formatUnits(fees0Raw, dec0));
      const fees1 = Number(formatUnits(fees1Raw, dec1));

      const p0 = tokenPrices[token0] || 0;
      const p1 = tokenPrices[token1] || 0;
      const valueUsd = amount0 * p0 + amount1 * p1;
      const uncollectedFeesUsd = fees0 * p0 + fees1 * p1;

      const tickWidth = tickUpper - tickLower;
      const bonusEligible =
        !(tickLower === -887272 && tickUpper === 887272) &&
        tickWidth > (matched?.tickWidthRule ?? 750);
      const activeShare = inRange && poolLiq > 0n ? Number(liquidity) / Number(poolLiq) : 0;

      const marginLowerPct = (1 - Math.pow(1.0001, tickLower - currentTick)) * 100;
      const marginUpperPct = (Math.pow(1.0001, tickUpper - currentTick) - 1) * 100;

      const estDailyLpFeeUsd = matched ? matched.poolDailyLpFeeUsd * activeShare : 0;
      const estDailyOkxUncapped = matched && bonusEligible ? matched.okxDailyUsd * activeShare : 0;
      const estDailyOkxBonusUsd = valueUsd > 0 ? Math.min(estDailyOkxUncapped, (valueUsd * 1.0) / 365) : 0;

      activePositions.push({
        tokenId: tid.toString(),
        poolAddress: poolAddr,
        poolName,
        okxUrl: matched?.okxUrl || "https://web3.okx.com/zh-hans/boost/x-liquidity/event",
        token0,
        token1,
        token0Symbol: sym0,
        token1Symbol: sym1,
        fee,
        tickLower,
        tickUpper,
        tickWidth,
        bonusEligible,
        currentTick,
        inRange,
        marginLowerPct: Number(marginLowerPct.toFixed(2)),
        marginUpperPct: Number(marginUpperPct.toFixed(2)),
        liquidity: liquidity.toString(),
        amount0,
        amount1,
        valueUsd: Number(valueUsd.toFixed(2)),
        fees0,
        fees1,
        uncollectedFeesUsd: Number(uncollectedFeesUsd.toFixed(4)),
        activeSharePct: Number((activeShare * 100).toFixed(3)),
        estDailyLpFeeUsd: Number(estDailyLpFeeUsd.toFixed(2)),
        estDailyOkxBonusUsd: Number(estDailyOkxBonusUsd.toFixed(2)),
      });
    } catch {}
  });

  // 2. 扫描钱包在 X Layer 上持有的全部主流币 + RWA 代币（把买 RWA 残余/回笼币全部纳入总资产）
  const tokenMetaMap = new Map<string, { symbol: string; decimals: number; isMajor: boolean }>();
  for (const [addr, info] of Object.entries(XLAYER_MAJOR_TOKENS)) {
    tokenMetaMap.set(addr.toLowerCase(), { symbol: info.symbol, decimals: info.decimals, isMajor: true });
  }
  for (const p of snapshot.pools) {
    if (!tokenMetaMap.has(p.token0)) {
      tokenMetaMap.set(p.token0, { symbol: p.token0Symbol, decimals: p.dec0, isMajor: false });
    }
    if (!tokenMetaMap.has(p.token1)) {
      tokenMetaMap.set(p.token1, { symbol: p.token1Symbol, decimals: p.dec1, isMajor: false });
    }
  }

  const walletAssets: XLayerWalletAsset[] = [];
  // 原生 OKB
  try {
    const okbBal = await xlayerClient.getBalance({ address: wallet });
    const balNum = Number(formatUnits(okbBal, 18));
    const px = snapshot.majorPricesUsd.OKB || 0;
    if (balNum * px >= 0.5) {
      walletAssets.push({
        address: "0x0000000000000000000000000000000000000000",
        symbol: "OKB (Native)",
        isMajor: true,
        balance: balNum,
        priceUsd: px,
        valueUsd: Number((balNum * px).toFixed(2)),
      });
    }
  } catch {}

  const allTokenEntries = Array.from(tokenMetaMap.entries());
  await mapConcurrent(allTokenEntries, 12, async ([addr, info]) => {
    try {
      const raw = await xlayerClient.readContract({
        address: addr as Address,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [wallet],
      });
      if (raw === 0n) return;
      const bal = Number(formatUnits(raw, info.decimals));
      const px = tokenPrices[addr] || 0;
      const val = bal * px;
      if (val >= 0.5 || bal > 0.0001) {
        walletAssets.push({
          address: addr,
          symbol: info.symbol,
          isMajor: info.isMajor,
          balance: bal,
          priceUsd: px,
          valueUsd: Number(val.toFixed(2)),
        });
      }
    } catch {}
  });
  walletAssets.sort((a, b) => b.valueUsd - a.valueUsd);

  // 3. 结合 SQLite 台账计算最终真实总净赚
  const entries = listOkxLedgerEntries(walletAddress);
  let totalDepositOnly = 0;
  let totalRwaBuyCostUsd = 0;
  let totalWithdrawnUsd = 0;
  let realizedLpFeesUsd = 0;
  let totalOkxBonusUsd = 0;

  for (const e of entries) {
    if (e.entryType === "deposit") totalDepositOnly += e.amountUsd;
    else if (e.entryType === "rwa_buy_cost") totalRwaBuyCostUsd += e.amountUsd;
    else if (e.entryType === "withdraw") totalWithdrawnUsd += e.amountUsd;
    else if (e.entryType === "lp_fee_realized") realizedLpFeesUsd += e.amountUsd;
    else if (e.entryType === "okx_bonus") totalOkxBonusUsd += e.amountUsd;
  }

  const totalDepositedUsd = totalDepositOnly + totalRwaBuyCostUsd;
  const netCapitalInvestedUsd = totalDepositedUsd - totalWithdrawnUsd;
  const activeLpHoldingsUsd = activePositions.reduce((s, p) => s + p.valueUsd, 0);
  const uncollectedLpFeesUsd = activePositions.reduce((s, p) => s + p.uncollectedFeesUsd, 0);
  const walletIdleHoldingsUsd = walletAssets.reduce((s, a) => s + a.valueUsd, 0);
  const walletIdleRwaUsd = walletAssets
    .filter((a) => !a.isMajor)
    .reduce((s, a) => s + a.valueUsd, 0);
  const currentTotalHoldingsUsd = activeLpHoldingsUsd + walletIdleHoldingsUsd;

  // 若尚未填写任何入金台账，不虚构巨额正收益，将 IL 置 0 并提示用户登记转入本金
  const ilAndRwaPnlUsd =
    totalDepositedUsd > 0 ? currentTotalHoldingsUsd - netCapitalInvestedUsd : 0;
  const totalLpFeesUsd = uncollectedLpFeesUsd + realizedLpFeesUsd;
  const finalNetProfitUsd = ilAndRwaPnlUsd + totalLpFeesUsd + totalOkxBonusUsd;
  const finalRoiPct =
    totalDepositedUsd > 0 ? Number(((finalNetProfitUsd / totalDepositedUsd) * 100).toFixed(2)) : null;
  const estActiveDailyTotalUsd = activePositions.reduce(
    (s, p) => s + p.estDailyLpFeeUsd + p.estDailyOkxBonusUsd,
    0
  );

  return {
    walletAddress,
    updatedAt,
    activePositions,
    closedTokenIds,
    walletAssets,
    entries,
    summary: {
      totalDepositedUsd: Number(totalDepositedUsd.toFixed(2)),
      totalRwaBuyCostUsd: Number(totalRwaBuyCostUsd.toFixed(2)),
      totalWithdrawnUsd: Number(totalWithdrawnUsd.toFixed(2)),
      netCapitalInvestedUsd: Number(netCapitalInvestedUsd.toFixed(2)),
      activeLpHoldingsUsd: Number(activeLpHoldingsUsd.toFixed(2)),
      walletIdleHoldingsUsd: Number(walletIdleHoldingsUsd.toFixed(2)),
      walletIdleRwaUsd: Number(walletIdleRwaUsd.toFixed(2)),
      currentTotalHoldingsUsd: Number(currentTotalHoldingsUsd.toFixed(2)),
      ilAndRwaPnlUsd: Number(ilAndRwaPnlUsd.toFixed(2)),
      uncollectedLpFeesUsd: Number(uncollectedLpFeesUsd.toFixed(2)),
      realizedLpFeesUsd: Number(realizedLpFeesUsd.toFixed(2)),
      totalLpFeesUsd: Number(totalLpFeesUsd.toFixed(2)),
      totalOkxBonusUsd: Number(totalOkxBonusUsd.toFixed(2)),
      finalNetProfitUsd: Number(finalNetProfitUsd.toFixed(2)),
      finalRoiPct,
      estActiveDailyTotalUsd: Number(estActiveDailyTotalUsd.toFixed(2)),
    },
  };
}
