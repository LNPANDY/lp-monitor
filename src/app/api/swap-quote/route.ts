/**
 * 代币兑换报价 API（QuoterV2 单跳）。
 *
 * 入参：{ chain_id, pool, amount_in, side, slippage_pct, wallet? }
 *   side: 'exact_in_token0'（用 token0 换 token1）| 'exact_in_token1'
 *
 * 逻辑：
 *   1. 读池子 token0/token1/fee + factory 匹配 DEX → 拿 quoter 地址
 *   2. 调 QuoterV2.quoteExactInputSingle（tokenIn, tokenOut, amountIn, fee, 0）
 *   3. 返回 amountOut / 价格影响 / 滑点后最小获得
 *
 * 注意：QuoterV2.quoteExactInputSingle 是 non-view（state-mutating stub），
 * 但可以用 eth_call 模拟执行；viem 的 readContract 自动走 eth_call。
 */
import { getDb } from "@/lib/db";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** QuoterV1.quoteExactInputSingle：5 个平铺参数，返回仅 amountOut */
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
] as const;

/** QuoterV2.quoteExactInputSingle：struct 参数，返回 amountOut + sqrtPriceAfter 等 */
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
] as const;

const POOL_ABI = [
  { name: "token0", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "token1", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] },
  { name: "fee", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint24" }] },
  { name: "slot0", type: "function", stateMutability: "view", inputs: [], outputs: [
    { name: "sqrtPriceX96", type: "uint160" },
    { name: "tick", type: "int24" },
    { name: "observationIndex", type: "uint16" },
    { name: "observationCardinality", type: "uint16" },
  ] },
] as const;

export async function POST(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    pool?: string;
    amount_in?: string;
    side?: string;
    slippage_pct?: number;
  }>(req);

  if (!b.chain_id || !b.pool || !b.amount_in) return fail("chain_id/pool/amount_in 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.pool)) return fail("pool 地址非法");
  if (b.side !== "exact_in_token0" && b.side !== "exact_in_token1") return fail("side 须为 exact_in_token0 或 exact_in_token1");

  const db = getDb();
  const { client, chain } = getClient(b.chain_id);
  const pool = b.pool as `0x${string}`;

  try {
    // 1. 读池子基础信息
    const [token0, token1, fee, slot0] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token0" }) as Promise<string>,
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "token1" }) as Promise<string>,
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "fee" }) as Promise<number>,
      client.readContract({ address: pool, abi: POOL_ABI, functionName: "slot0" }) as Promise<readonly [bigint, number, number, number]>,
    ]);
    const sqrtPriceBefore = slot0[0];

    // 2. factory 匹配 DEX → quoter 地址
    let poolFactory = "";
    try {
      poolFactory = await client.readContract({
        address: pool,
        abi: [{ name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
        functionName: "factory",
      }) as string;
    } catch { /* ignore */ }
    const dexRow = (db.prepare(
      "SELECT id, name, quoter FROM dexes WHERE chain_id_ref=? AND enabled=1 AND LOWER(factory)=LOWER(?)"
    ).get(b.chain_id, poolFactory) as any) ?? null;

    if (!dexRow?.quoter) {
      return fail(`该 DEX（${dexRow?.name ?? poolFactory.slice(0, 10) ?? "未知"}）未配置 Quoter 地址，请在配置页的 DEX 设置里填写`, 400);
    }

    // 3. token 元数据与金额
    const tokenMap = await resolveTokens(client, b.chain_id, [token0, token1]);
    const m0 = tokenMap.get(token0.toLowerCase());
    const m1 = tokenMap.get(token1.toLowerCase());
    const decIn = b.side === "exact_in_token0" ? (m0?.decimals ?? 18) : (m1?.decimals ?? 18);
    const decOut = b.side === "exact_in_token0" ? (m1?.decimals ?? 18) : (m0?.decimals ?? 18);
    const tokenIn = b.side === "exact_in_token0" ? token0 : token1;
    const tokenOut = b.side === "exact_in_token0" ? token1 : token0;
    const symIn = b.side === "exact_in_token0" ? (m0?.symbol ?? "token0") : (m1?.symbol ?? "token1");
    const symOut = b.side === "exact_in_token0" ? (m1?.symbol ?? "token1") : (m0?.symbol ?? "token0");

    const amountIn = parseHumanAmount(b.amount_in, decIn);
    if (amountIn <= 0n) return fail("amount_in 须为正数");

    // 4. 调 Quoter（V2 struct 签名优先，revert 则回退 V1 平铺签名）
    const quoter = dexRow.quoter as `0x${string}`;
    let amountOut = 0n;
    let sqrtPriceAfter = 0n;
    let gasEstimate = 0n;
    let quoterVersion: "v2" | "v1" = "v2";
    try {
      const result = await client.readContract({
        address: quoter,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: tokenIn as `0x${string}`,
          tokenOut: tokenOut as `0x${string}`,
          amountIn,
          fee: Number(fee),
          sqrtPriceLimitX96: 0n,
        }],
      }) as readonly [bigint, bigint, number, bigint];
      amountOut = result[0];
      sqrtPriceAfter = result[1];
      gasEstimate = result[3];
    } catch (v2Err: any) {
      // V2 签名失败 → 尝试 V1（很多 fork 只部署了 QuoterV1）
      try {
        const r1 = await client.readContract({
          address: quoter,
          abi: QUOTER_V1_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            tokenIn as `0x${string}`,
            tokenOut as `0x${string}`,
            amountIn,
            Number(fee),
            0n,
          ],
        }) as bigint;
        amountOut = r1;
        quoterVersion = "v1";
      } catch (v1Err: any) {
        return fail(`报价失败：QuoterV2 与 V1 签名均不匹配（检查 quoter 地址是否正确）—— ${String(v1Err?.message ?? v1Err).slice(0, 120)}`, 502);
      }
    }

    // 5. 价格影响：用 sqrtPriceBefore/After 换算价格变化
    //    price = (sqrtP / 2^96)^2；影响 = |priceAfter - priceBefore| / priceBefore
    let priceImpactPct: number | null = null;
    try {
      if (sqrtPriceBefore > 0n && sqrtPriceAfter > 0n) {
        const pB = Number(sqrtPriceBefore) / Number(1n << 96n);
        const pA = Number(sqrtPriceAfter) / Number(1n << 96n);
        // side=token0→token1 时价格朝下走（token1/token0 变小），反之朝上
        const impact = b.side === "exact_in_token0" ? (pB - pA) / pB : (pA - pB) / pB;
        priceImpactPct = impact >= 0 ? impact * 100 : 0;
      }
    } catch { priceImpactPct = null; }

    // 6. 滑点后最小获得
    const slippagePct = Number(b.slippage_pct ?? 0.5);
    const slip = BigInt(Math.max(0, Math.min(95, Math.round((slippagePct || 0.5) * 100))));
    const amountOutMin = (amountOut * (10000n - slip)) / 10000n;

    return ok({
      chain: { id: chain.id, name: chain.name },
      pool: pool.toLowerCase(),
      dexName: dexRow.name,
      tokenIn: { address: tokenIn.toLowerCase(), symbol: symIn, decimals: decIn },
      tokenOut: { address: tokenOut.toLowerCase(), symbol: symOut, decimals: decOut },
      amountIn: amountIn.toString(),
      amountInHuman: formatRaw(amountIn, decIn),
      amountOut: amountOut.toString(),
      amountOutHuman: formatRaw(amountOut, decOut),
      amountOutMin: amountOutMin.toString(),
      amountOutMinHuman: formatRaw(amountOutMin, decOut),
      slippagePct,
      priceImpactPct,
      gasEstimate: gasEstimate.toString(),
      executionPrice: Number(amountOut) / Number(amountIn) * Math.pow(10, decIn - decOut),
      quoterVersion,
    });
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (msg.includes("revert") || msg.includes("Too little")) {
      return fail(`报价失败：流动性不足以完成这笔兑换（${msg.slice(0, 120)}）`, 422);
    }
    return fail(`报价失败：${msg.slice(0, 200)}`, 502);
  }
}

/** 人类可读金额 → 原始单位 BigInt（与 liquidity-mint 同实现） */
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
  const neg = v < 0n;
  const a = neg ? -v : v;
  const s = a.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + (fracPart ? `${intPart}.${fracPart}` : intPart);
}
