/**
 * 代币兑换报价 API（代币对模式，自动找池子）。
 *
 * 入参：{ chain_id, token_in_addr, token_out_addr, amount_in, slippage_pct, fee? }
 *   token_addr 可以是 CEX 映射里的 __native__（原生币），自动映射到 wrapped 合约。
 *
 * 流程：
 *   1. __native__ → 同链 token_symbols 找基础名相同的 wrapped 合约（0G→W0G）
 *   2. 取该链配了 quoter 的 v3 DEX
 *   3. 并发调 factory.getPool(tokenIn, tokenOut, fee) 遍历 4 个标准档位，
 *      非零池并发读 liquidity()，自动选流动性最大的池子
 *   4. QuoterV2 报价（revert 回退 V1 平铺签名）
 *   5. 返回报价 + 池子/fee + 可用档位 + router 地址（供前端构造 swap tx）
 */
import { getDb } from "@/lib/db";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { ok, fail, getBody } from "@/lib/api";
import { FEE_TIERS } from "@/lib/v3/math";
import { getPoolAddress } from "@/lib/adapters/v3-fork";
import { buildQuotesByAddr } from "@/lib/cex/binance";

export const dynamic = "force-dynamic";

/** QuoterV1：quoteExactInputSingle / quoteExactOutputSingle 平铺参数 */
const QUOTER_V1_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "amountIn", type: "uint256" },
      { name: "fee", type: "uint24" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountOut", type: "uint256" }],
  },
  {
    name: "quoteExactOutputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "tokenIn", type: "address" },
      { name: "tokenOut", type: "address" },
      { name: "fee", type: "uint24" },
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceLimitX96", type: "uint160" },
    ],
    outputs: [{ name: "amountIn", type: "uint256" }],
  },
] as const;

/** QuoterV2：quoteExactInputSingle / quoteExactOutputSingle struct 参数 */
const QUOTER_V2_ABI = [
  {
    name: "quoteExactInputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
  {
    name: "quoteExactOutputSingle",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "fee", type: "uint24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountIn", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

const POOL_LIQUIDITY_ABI = [
  { name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128" }] },
] as const;

const POOL_SLOT0_ABI = [
  { name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" },
    { name: "observationCardinality", type: "uint16" },
  ] },
] as const;

const ERC20_READ_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

interface PoolCandidate {
  fee: number;
  pool: string;
  liquidity: bigint;
}

/** 永久缓存 factory + 双币 + fee 对应的 Pool 地址（包括 ZERO_ADDR，因为通常不会临时新建档位） */
function getSwapPoolAddrCache(): Map<string, { ts: number; pool: string }> {
  const g = globalThis as any;
  if (!g.__lpMonitorSwapPoolAddrCache__) {
    g.__lpMonitorSwapPoolAddrCache__ = new Map();
  }
  return g.__lpMonitorSwapPoolAddrCache__;
}

/** 短期缓存（30s）某交易对 4 个费率档的可用池及流动性排序，避免连续输入金额时每次重查 4 档池子 */
function getPairPoolsCache(): Map<string, { ts: number; sorted: PoolCandidate[] }> {
  const g = globalThis as any;
  if (!g.__lpMonitorPairPoolsCache__) {
    g.__lpMonitorPairPoolsCache__ = new Map();
  }
  return g.__lpMonitorPairPoolsCache__;
}

/** 永久缓存 Quoter 合约支持的 ABI 版本（v2 或 v1），避免 V1 Quoter 每次先调 V2 revert 浪费 1 个 RTT */
function getQuoterVersionCache(): Map<string, "v2" | "v1"> {
  const g = globalThis as any;
  if (!g.__lpMonitorQuoterVersionCache__) {
    g.__lpMonitorQuoterVersionCache__ = new Map();
  }
  return g.__lpMonitorQuoterVersionCache__;
}

export async function POST(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    token_in_addr?: string;
    token_out_addr?: string;
    amount_in?: string;
    /** 目标输出数量（反向输入模式）：想要得到多少 tokenOut */
    target_out?: string;
    slippage_pct?: number;
    fee?: number;
    pool?: string;
    /** 钱包地址：传了就返回两个 token 的余额与授权状态（兑换面板显示与免预检用） */
    wallet?: string;
  }>(req);

  if (!b.chain_id || !b.token_in_addr || !b.token_out_addr) {
    return fail("chain_id/token_in_addr/token_out_addr 必填");
  }
  if (!b.amount_in && !b.target_out) {
    return fail("amount_in 与 target_out 须填其一");
  }
  if (b.token_in_addr.toLowerCase() === b.token_out_addr.toLowerCase()) {
    return fail("token_in 和 token_out 不能相同");
  }

  const db = getDb();
  const { client, chain } = getClient(b.chain_id);

  try {
    // 1. __native__ → wrapped 合约映射
    const resolveAddr = async (raw: string): Promise<{ addr: string; isNative: boolean }> => {
      const a = raw.trim().toLowerCase();
      if (a === "__native__") {
        const natives = db.prepare(
          "SELECT token_symbol FROM token_symbols WHERE chain_id_ref=? AND token_addr='__native__' AND enabled=1"
        ).all(b.chain_id) as { token_symbol: string }[];
        const nativeSym = natives[0]?.token_symbol ?? chain.symbol;
        const base = nativeSym.toLowerCase();
        const candidates = db.prepare(
          "SELECT token_addr, token_symbol FROM token_symbols WHERE chain_id_ref=? AND enabled=1 AND token_addr!='__native__'"
        ).all(b.chain_id) as { token_addr: string; token_symbol: string }[];
        const wrapped = candidates.filter((t) => {
          const sym = t.token_symbol.toLowerCase();
          const stripped = sym.startsWith("w") ? sym.slice(1) : sym;
          return stripped === base || sym.includes(base);
        });
        if (wrapped.length === 0) {
          throw new Error(`原生币 ${nativeSym} 未找到对应的 wrapped 合约（请在 CEX 报价匹配里配置 ${nativeSym} 的包装代币，如 W${nativeSym}）`);
        }
        return { addr: wrapped[0].token_addr.toLowerCase(), isNative: true };
      }
      if (!/^0x[a-f0-9]{40}$/.test(a)) throw new Error(`token 地址非法: ${raw}`);
      return { addr: a, isNative: false };
    };

    const inMeta = await resolveAddr(b.token_in_addr);
    const outMeta = await resolveAddr(b.token_out_addr);

    // 2. 该链配了 quoter 的 v3 DEX
    const dexRow = db.prepare(
      "SELECT id, name, quoter, router02, swaprouter, factory FROM dexes WHERE chain_id_ref=? AND enabled=1 AND type='v3-fork' AND quoter!=''"
    ).get(b.chain_id) as { id: number; name: string; quoter: string; router02: string; swaprouter: string; factory: string } | undefined;
    if (!dexRow) {
      return fail("该链没有配置 Quoter 地址的 DEX（请在配置页 DEX 设置里填写 QuoterV2 地址）", 400);
    }

    // 3. 自动找池子（带 30s 费率档列表缓存 + 永久 Pool 地址缓存）与 token 元数据并行读取
    const factory = dexRow.factory as `0x${string}`;
    const [tA, tB] =
      inMeta.addr.toLowerCase() < outMeta.addr.toLowerCase()
        ? [inMeta.addr.toLowerCase(), outMeta.addr.toLowerCase()]
        : [outMeta.addr.toLowerCase(), inMeta.addr.toLowerCase()];
    const pairKey = `${b.chain_id}:${factory.toLowerCase()}:${tA}:${tB}`;
    const pairPoolsCache = getPairPoolsCache();
    const poolAddrCache = getSwapPoolAddrCache();
    const now = Date.now();

    const discoverPools = async (): Promise<PoolCandidate[]> => {
      const cachedPair = pairPoolsCache.get(pairKey);
      if (cachedPair && now - cachedPair.ts < 30_000) {
        return cachedPair.sorted;
      }
      const candidates: (PoolCandidate | null)[] = await Promise.all(
        FEE_TIERS.map(async (feeTier) => {
          try {
            const addrKey = `${pairKey}:${feeTier}`;
            const cachedAddr = poolAddrCache.get(addrKey);
            let pool: string | null = null;
            if (cachedAddr && (cachedAddr.pool !== ZERO_ADDR || now - cachedAddr.ts < 300_000)) {
              pool = cachedAddr.pool;
            } else {
              pool = await getPoolAddress(
                client,
                factory,
                inMeta.addr as `0x${string}`,
                outMeta.addr as `0x${string}`,
                feeTier
              );
              if (pool) {
                poolAddrCache.set(addrKey, { ts: now, pool });
              }
            }
            if (!pool || pool === ZERO_ADDR) return null;
            let liquidity = 0n;
            try {
              liquidity = (await client.readContract({
                address: pool as `0x${string}`,
                abi: POOL_LIQUIDITY_ABI,
                functionName: "liquidity",
              })) as bigint;
            } catch {
              /* ignore */
            }
            return { fee: feeTier, pool, liquidity };
          } catch {
            return null;
          }
        })
      );
      const valid = candidates.filter((p): p is PoolCandidate => p !== null);
      const sortedList = valid.slice().sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : 0));
      if (sortedList.length > 0) {
        pairPoolsCache.set(pairKey, { ts: Date.now(), sorted: sortedList });
      }
      return sortedList;
    };

    const [sorted, tokenMap] = await Promise.all([
      discoverPools(),
      resolveTokens(client, b.chain_id, [inMeta.addr, outMeta.addr]),
    ]);

    if (sorted.length === 0) {
      return fail("未找到这两个代币的池子（4 个标准费率档都没有部署）", 404);
    }
    const selected: PoolCandidate =
      (b.fee ? sorted.find((p) => p.fee === b.fee) : undefined) ?? sorted[0];
    const pool = selected.pool;
    const fee = selected.fee;

    // 4. token 元数据与金额（V3 池的 token0 恒为地址按字典序较小者，无需额外 RPC 读 pool.token0()！）
    const mIn = tokenMap.get(inMeta.addr.toLowerCase());
    const mOut = tokenMap.get(outMeta.addr.toLowerCase());
    const decIn = mIn?.decimals ?? 18;
    const decOut = mOut?.decimals ?? 18;
    const symIn = inMeta.isNative ? chain.symbol : (mIn?.symbol ?? "tokenIn");
    const symOut = outMeta.isNative ? chain.symbol : (mOut?.symbol ?? "tokenOut");
    const poolToken0 = tA;
    const dec0 = poolToken0 === inMeta.addr.toLowerCase() ? decIn : decOut;
    const dec1 = poolToken0 === inMeta.addr.toLowerCase() ? decOut : decIn;

    let targetOutRaw = 0n;
    let amountIn = 0n;
    if (b.target_out) {
      targetOutRaw = parseHumanAmount(b.target_out, decOut);
      if (targetOutRaw <= 0n) return fail("target_out 须为正数");
    } else {
      amountIn = parseHumanAmount(b.amount_in ?? "0", decIn);
      if (amountIn <= 0n) return fail("金额须为正数");
    }

    // 5. 单次并行 RTT：Quoter 报价（正向 quoteExactInputSingle / 反向 quoteExactOutputSingle）+ Pool slot0 + 钱包状态
    const quoter = dexRow.quoter as `0x${string}`;
    const quoterKey = `${b.chain_id}:${quoter.toLowerCase()}`;
    const quoterVerCache = getQuoterVersionCache();
    const knownVer = quoterVerCache.get(quoterKey);
    const routerAddr = dexRow.router02 || dexRow.swaprouter || "";
    const hasWallet = !!(b.wallet && /^0x[a-fA-F0-9]{40}$/.test(b.wallet));
    const walletAddr = hasWallet ? (b.wallet as `0x${string}`) : undefined;
    const inIsNativeToken = b.token_in_addr?.toLowerCase() === "__native__";
    const outIsNativeToken = b.token_out_addr?.toLowerCase() === "__native__";

    const runExactInQuoter = async (inAmt: bigint): Promise<{ amountOut: bigint; gasEstimate: bigint }> => {
      if (knownVer === "v1") {
        const r1 = (await client.readContract({
          address: quoter,
          abi: QUOTER_V1_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            inMeta.addr as `0x${string}`,
            outMeta.addr as `0x${string}`,
            inAmt,
            fee,
            0n,
          ],
        })) as bigint;
        return { amountOut: r1, gasEstimate: 0n };
      }
      try {
        const result = (await client.readContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            {
              tokenIn: inMeta.addr as `0x${string}`,
              tokenOut: outMeta.addr as `0x${string}`,
              amountIn: inAmt,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })) as readonly [bigint, bigint, number, bigint];
        quoterVerCache.set(quoterKey, "v2");
        return { amountOut: result[0], gasEstimate: result[3] };
      } catch {
        try {
          const r1 = (await client.readContract({
            address: quoter,
            abi: QUOTER_V1_ABI,
            functionName: "quoteExactInputSingle",
            args: [
              inMeta.addr as `0x${string}`,
              outMeta.addr as `0x${string}`,
              inAmt,
              fee,
              0n,
            ],
          })) as bigint;
          quoterVerCache.set(quoterKey, "v1");
          return { amountOut: r1, gasEstimate: 0n };
        } catch (v1Err: any) {
          throw new Error(
            `报价失败：QuoterV2 与 V1 签名均不匹配——${String(v1Err?.message ?? v1Err).slice(0, 120)}`
          );
        }
      }
    };

    /**
     * 反向精确输出报价（用户在 TokenOut 输入目标数量如 0.1）：
     * 直接调用链上 Quoter.quoteExactOutputSingle(targetOutRaw)，由池子合约一步精确反算包含手续费与价格滑点后的真实 amountIn，
     * 不仅比旧版「先串行读 slot0 再调 Quoter」少 1 个 RTT（更快），而且钱包模拟出来的输出数量精确等于 0.1！
     */
    const runExactOutQuoter = async (
      outAmt: bigint
    ): Promise<{ amountIn: bigint; gasEstimate: bigint } | null> => {
      if (knownVer === "v1") {
        try {
          const r1 = (await client.readContract({
            address: quoter,
            abi: QUOTER_V1_ABI,
            functionName: "quoteExactOutputSingle",
            args: [
              inMeta.addr as `0x${string}`,
              outMeta.addr as `0x${string}`,
              fee,
              outAmt,
              0n,
            ],
          })) as bigint;
          return { amountIn: r1, gasEstimate: 0n };
        } catch {
          return null;
        }
      }
      try {
        const result = (await client.readContract({
          address: quoter,
          abi: QUOTER_V2_ABI,
          functionName: "quoteExactOutputSingle",
          args: [
            {
              tokenIn: inMeta.addr as `0x${string}`,
              tokenOut: outMeta.addr as `0x${string}`,
              amount: outAmt,
              fee,
              sqrtPriceLimitX96: 0n,
            },
          ],
        })) as readonly [bigint, bigint, number, bigint];
        quoterVerCache.set(quoterKey, "v2");
        return { amountIn: result[0], gasEstimate: result[3] };
      } catch {
        try {
          const r1 = (await client.readContract({
            address: quoter,
            abi: QUOTER_V1_ABI,
            functionName: "quoteExactOutputSingle",
            args: [
              inMeta.addr as `0x${string}`,
              outMeta.addr as `0x${string}`,
              fee,
              outAmt,
              0n,
            ],
          })) as bigint;
          quoterVerCache.set(quoterKey, "v1");
          return { amountIn: r1, gasEstimate: 0n };
        } catch {
          return null;
        }
      }
    };

    const readBal = async (tokenAddr: string, isNative: boolean): Promise<bigint> => {
      if (!walletAddr) return 0n;
      try {
        if (isNative) return await client.getBalance({ address: walletAddr });
        return (await client.readContract({
          address: tokenAddr as `0x${string}`,
          abi: ERC20_READ_ABI,
          functionName: "balanceOf",
          args: [walletAddr],
        })) as bigint;
      } catch {
        return 0n;
      }
    };

    const [directQuoteRes, exactOutRes, slot0Res, walletState] = await Promise.all([
      targetOutRaw > 0n ? Promise.resolve(null) : runExactInQuoter(amountIn),
      targetOutRaw > 0n ? runExactOutQuoter(targetOutRaw) : Promise.resolve(null),
      client
        .readContract({
          address: pool as `0x${string}`,
          abi: POOL_SLOT0_ABI,
          functionName: "slot0",
        })
        .catch(() => null) as Promise<readonly [bigint, number, number, number] | null>,
      walletAddr
        ? Promise.all([
            readBal(inMeta.addr, inIsNativeToken),
            readBal(outMeta.addr, outIsNativeToken),
            !inIsNativeToken && routerAddr
              ? (client
                  .readContract({
                    address: inMeta.addr as `0x${string}`,
                    abi: ERC20_READ_ABI,
                    functionName: "allowance",
                    args: [walletAddr, routerAddr as `0x${string}`],
                  })
                  .catch(() => 0n) as Promise<bigint>)
              : Promise.resolve(1n << 255n),
          ])
        : Promise.resolve(null),
    ]);

    let amountOut = 0n;
    let gasEstimate = 0n;

    if (targetOutRaw > 0n) {
      if (exactOutRes && exactOutRes.amountIn > 0n) {
        // 路径 A（最快 & 最准）：链上 quoteExactOutputSingle 直接返回精确 amountIn（加 1 wei 防止整除截断导致少 1 wei）
        amountIn = exactOutRes.amountIn + 1n;
        amountOut = targetOutRaw;
        gasEstimate = exactOutRes.gasEstimate;
      } else {
        // 路径 B（兜底：若某自建 Quoter 未实现 quoteExactOutputSingle）：
        // 用 slot0 + 池子手续费率补偿 (1e6 / (1e6 - fee)) 估算初值，调一次 quoteExactInputSingle 后按真实成交比例做精确线性修正
        if (!slot0Res) return fail("读取池子价格失败");
        const poolSortedSpot =
          (Number(slot0Res[0]) ** 2 / Number(1n << 96n) ** 2) *
          Math.pow(10, dec0 - dec1);
        const inIsToken0 = inMeta.addr.toLowerCase() === poolToken0;
        const spot = inIsToken0 ? poolSortedSpot : 1 / poolSortedSpot;
        if (spot <= 0 || !Number.isFinite(spot)) return fail("读取池子价格失败");
        const feeFactor = 1_000_000 / Math.max(1, 1_000_000 - fee);
        const estIn = parseHumanAmount(
          ((Number(targetOutRaw) / Number(10n ** BigInt(decOut)) / spot) * feeFactor).toPrecision(15),
          decIn
        );
        if (estIn <= 0n) return fail("估算输入金额失败");
        const q1 = await runExactInQuoter(estIn);
        if (q1.amountOut <= 0n) {
          return fail("报价结果为 0：池子流动性可能不足以完成这笔兑换", 422);
        }
        // 按实测成交率反推精确 amountIn（将价格冲击与手续费一并校准到位）
        amountIn = (estIn * targetOutRaw + q1.amountOut - 1n) / q1.amountOut + 1n;
        amountOut = targetOutRaw;
        gasEstimate = q1.gasEstimate;
      }
    } else if (directQuoteRes) {
      amountOut = directQuoteRes.amountOut;
      gasEstimate = directQuoteRes.gasEstimate;
    }

    if (amountOut <= 0n || amountIn <= 0n) {
      return fail("报价结果为 0：池子流动性可能不足以完成这笔兑换", 422);
    }

    // 6. 价格影响：spot 价 vs 成交价
    let priceImpactPct: number | null = null;
    const executionPrice =
      Number(formatRaw(amountOut, decOut)) / Number(formatRaw(amountIn, decIn));
    if (slot0Res) {
      const sqrtP = slot0Res[0];
      const poolSortedPrice =
        (Number(sqrtP) ** 2 / Number(1n << 96n) ** 2) * Math.pow(10, dec0 - dec1);
      const inIsToken0 = inMeta.addr.toLowerCase() === poolToken0;
      const spotPrice = inIsToken0 ? poolSortedPrice : 1 / poolSortedPrice;
      if (spotPrice > 0 && Number.isFinite(spotPrice)) {
        priceImpactPct = (Math.abs(spotPrice - executionPrice) / spotPrice) * 100;
      }
    }

    // 6.5 稳定币 CEX 对比
    let cexCompare: {
      stableSymbol: string;
      otherSymbol: string;
      cexPrice: number;
      executionPriceInStable: number;
      diffPct: number;
      cexSymbolLabel: string;
      displayPrice: number;
    } | null = null;
    try {
      const stableMappings = db.prepare(
        `SELECT ts.token_addr, ts.token_symbol, ts.cex_symbol, ts.fixed_price, ts.quote, ts.inverted
         FROM token_symbols ts WHERE ts.chain_id_ref=? AND ts.enabled=1 AND ts.is_stable=1`
      ).all(b.chain_id) as { token_addr: string; token_symbol: string; cex_symbol: string; fixed_price: number | null; quote: string; inverted: number }[];
      if (stableMappings.length > 0) {
        const inIsStable = stableMappings.find((m) => m.token_addr.toLowerCase() === inMeta.addr.toLowerCase());
        const outIsStable = stableMappings.find((m) => m.token_addr.toLowerCase() === outMeta.addr.toLowerCase());
        const stableSide = inIsStable ? "in" : outIsStable ? "out" : null;
        if (stableSide) {
          const stableMap = (inIsStable ?? outIsStable)!;
          const otherAddr = stableSide === "in" ? outMeta.addr : inMeta.addr;
          const otherMap = db.prepare(
            "SELECT token_addr, cex_symbol, fixed_price, quote, inverted FROM token_symbols WHERE chain_id_ref=? AND enabled=1 AND LOWER(token_addr)=LOWER(?)"
          ).get(b.chain_id, otherAddr) as { cex_symbol: string; fixed_price: number | null; quote: string; inverted: number } | undefined;
          if (otherMap) {
            const mappingsForQuote = [{
              chainIdRef: b.chain_id,
              tokenAddr: otherAddr.toLowerCase(),
              cexSymbol: (otherMap.cex_symbol || "").toUpperCase(),
              fixedPrice: otherMap.fixed_price,
              quote: otherMap.quote,
              inverted: otherMap.inverted === 1,
            }];
            const quotes = await buildQuotesByAddr(mappingsForQuote);
            const otherQuote = quotes.get(otherAddr.toLowerCase());
            if (otherQuote && otherQuote.price > 0) {
              const stableSymbol = stableMap.token_symbol || "stable";
              const otherSymbol = stableSide === "in" ? symOut : symIn;
              const displayPrice = stableSide === "out" ? executionPrice : 1 / executionPrice;
              const cexPrice = otherQuote.price;
              const diffPct = ((displayPrice - cexPrice) / cexPrice) * 100;
              cexCompare = {
                stableSymbol,
                otherSymbol,
                cexPrice,
                executionPriceInStable: displayPrice,
                diffPct,
                cexSymbolLabel: otherQuote.symbol,
                displayPrice,
              };
            }
          }
        }
      }
      if (!cexCompare && executionPrice > 0) {
        const pairRows = db.prepare(
          `SELECT token_addr, cex_symbol, fixed_price, quote, inverted
           FROM token_symbols
           WHERE chain_id_ref=? AND enabled=1 AND LOWER(token_addr) IN (LOWER(?), LOWER(?))`
        ).all(b.chain_id, inMeta.addr, outMeta.addr) as {
          token_addr: string;
          cex_symbol: string;
          fixed_price: number | null;
          quote: string;
          inverted: number;
        }[];
        if (pairRows.length >= 2) {
          const quotes = await buildQuotesByAddr(
            pairRows.map((r) => ({
              chainIdRef: b.chain_id!,
              tokenAddr: r.token_addr.toLowerCase(),
              cexSymbol: (r.cex_symbol || "").toUpperCase(),
              fixedPrice: r.fixed_price,
              quote: r.quote,
              inverted: r.inverted === 1,
            }))
          );
          const qIn = quotes.get(inMeta.addr.toLowerCase());
          const qOut = quotes.get(outMeta.addr.toLowerCase());
          if (qIn && qOut && qIn.price > 0 && qOut.price > 0) {
            const cexPrice = qIn.price / qOut.price;
            const diffPct = ((executionPrice - cexPrice) / cexPrice) * 100;
            cexCompare = {
              stableSymbol: symOut,
              otherSymbol: symIn,
              cexPrice,
              executionPriceInStable: executionPrice,
              diffPct,
              cexSymbolLabel: `${qIn.symbol}/${qOut.symbol}`,
              displayPrice: executionPrice,
            };
          }
        }
      }
    } catch {
      /* CEX 对比失败不影响主报价 */
    }

    // 7. 滑点后最小获得
    const slippagePct = Number(b.slippage_pct ?? 0.1);
    const slip = BigInt(Math.max(0, Math.min(95, Math.round((slippagePct || 0.1) * 100))));
    const amountOutMin = (amountOut * (10000n - slip)) / 10000n;

    const balances = walletState
      ? { in: walletState[0].toString(), out: walletState[1].toString() }
      : null;
    const allowanceSufficient = inIsNativeToken
      ? true
      : walletState
        ? walletState[2] >= amountIn
        : false;

    return ok({
      chain: { id: chain.id, name: chain.name, chain_id: chain.chain_id },
      dexName: dexRow.name,
      pool: pool.toLowerCase(),
      fee,
      availableFees: sorted.map((p) => ({ fee: p.fee, liquidity: p.liquidity.toString() })),
      tokenIn: { addr: inMeta.addr, symbol: symIn, decimals: decIn, isNative: inMeta.isNative },
      tokenOut: { addr: outMeta.addr, symbol: symOut, decimals: decOut, isNative: outMeta.isNative },
      amountIn: amountIn.toString(),
      amountInHuman: formatRaw(amountIn, decIn),
      amountOut: amountOut.toString(),
      amountOutHuman: formatRaw(amountOut, decOut),
      amountOutMin: amountOutMin.toString(),
      amountOutMinHuman: formatRaw(amountOutMin, decOut),
      slippagePct,
      priceImpactPct,
      gasEstimate: gasEstimate.toString(),
      executionPrice,
      router: routerAddr
        ? { addr: routerAddr, kind: dexRow.router02 ? "router02" : "swaprouter" }
        : null,
      balances,
      allowanceSufficient,
      cexCompare,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    return fail(`报价失败：${msg.slice(0, 200)}`, 502);
  }
}

/** 人类可读金额 → 原始单位 BigInt */
function parseHumanAmount(input: string, decimals: number): bigint {
  const s = input.trim();
  if (!s || !/^\d*\.?\d*$/.test(s)) return 0n;
  const [intPart, fracPart = ""] = s.split(".");
  const frac = (fracPart + "0".repeat(decimals)).slice(0, decimals);
  try {
    return BigInt((intPart || "0") + frac);
  } catch {
    return 0n;
  }
}

/** 原始单位 BigInt → 人类可读字符串 */
function formatRaw(v: bigint, decimals: number): string {
  if (v === 0n) return "0";
  const s = v.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}
