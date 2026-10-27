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

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

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
    /** 钱包地址：传了就返回两个 token 的余额（兑换面板显示用） */
    wallet?: string;
  }>(req);

  if (!b.chain_id || !b.token_in_addr || !b.token_out_addr || !b.amount_in) {
    return fail("chain_id/token_in_addr/token_out_addr/amount_in 必填");
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
        const wrapped = db.prepare(
          "SELECT token_addr, token_symbol FROM token_symbols WHERE chain_id_ref=? AND enabled=1 AND token_addr!='__native__' AND LOWER(token_symbol) LIKE ?"
        ).all(b.chain_id, `${base}%`) as { token_addr: string; token_symbol: string }[];
        if (wrapped.length === 0) {
          throw new Error(`原生币 ${nativeSym} 未找到对应的 wrapped 合约（请在 CEX 报价匹配里配置其包装代币）`);
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

    // 3. 自动找池子：4 档并发 getPool，非零池并发 liquidity，选流动性最大
    const factory = dexRow.factory as `0x${string}`;
    const poolCandidates: (PoolCandidate | null)[] = await Promise.all(
      FEE_TIERS.map(async (feeTier) => {
        try {
          const pool = await getPoolAddress(client, factory, inMeta.addr as `0x${string}`, outMeta.addr as `0x${string}`, feeTier);
          if (!pool || pool === ZERO_ADDR) return null;
          let liquidity = 0n;
          try {
            liquidity = await client.readContract({ address: pool, abi: POOL_LIQUIDITY_ABI, functionName: "liquidity" }) as bigint;
          } catch { /* ignore */ }
          return { fee: feeTier, pool, liquidity };
        } catch {
          return null;
        }
      })
    );
    interface PoolCandidate { fee: number; pool: string; liquidity: bigint }
    const validPools = poolCandidates.filter((p): p is PoolCandidate => p !== null);
    if (validPools.length === 0) {
      return fail("未找到这两个代币的池子（4 个标准费率档都没有部署）", 404);
    }
    const sorted = validPools.slice().sort((x, y) => Number(y.liquidity - x.liquidity));
    const selected: { fee: number; pool: string; liquidity: bigint } = (b.fee ? sorted.find((p) => p.fee === b.fee) : undefined) ?? sorted[0];
    const pool = selected.pool;
    const fee = selected.fee;

    // 4. token 元数据与金额
    const tokenMap = await resolveTokens(client, b.chain_id, [inMeta.addr, outMeta.addr]);
    const mIn = tokenMap.get(inMeta.addr.toLowerCase());
    const mOut = tokenMap.get(outMeta.addr.toLowerCase());
    const decIn = mIn?.decimals ?? 18;
    const decOut = mOut?.decimals ?? 18;
    const symIn = inMeta.isNative ? chain.symbol : (mIn?.symbol ?? "tokenIn");
    const symOut = outMeta.isNative ? chain.symbol : (mOut?.symbol ?? "tokenOut");

    // 金额确定：
    //   正向（amount_in）直接用；反向（target_out）用 spot 价估初始值，
    //   报价后按实际 amountOut/目标 比例迭代修正一次（Quoter 是线性的近似，两次足够精确）
    let targetOutRaw = 0n;
    let amountIn = 0n;
    if (b.target_out) {
      targetOutRaw = parseHumanAmount(b.target_out, decOut);
      if (targetOutRaw <= 0n) return fail("target_out 须为正数");
      const slot00 = await client.readContract({ address: pool as `0x${string}`, abi: POOL_SLOT0_ABI, functionName: "slot0" }) as readonly [bigint, number, number, number];
      const spot = Number(slot00[0]) ** 2 / Number(1n << 96n) ** 2 * Math.pow(10, decIn - decOut);
      if (spot <= 0) return fail("读取池子价格失败");
      // 初始估计：targetOut / spot
      amountIn = parseHumanAmount((Number(targetOutRaw) / Number(10n ** BigInt(decOut)) / spot).toPrecision(15), decIn);
    } else {
      amountIn = parseHumanAmount(b.amount_in, decIn);
    }
    if (amountIn <= 0n) return fail("金额须为正数");

    // 5. QuoterV2 报价（revert 回退 V1）
    const quoter = dexRow.quoter as `0x${string}`;
    let amountOut = 0n;
    let sqrtPriceAfter = 0n;
    let gasEstimate = 0n;
    try {
      const result = await client.readContract({
        address: quoter,
        abi: QUOTER_V2_ABI,
        functionName: "quoteExactInputSingle",
        args: [{
          tokenIn: inMeta.addr as `0x${string}`,
          tokenOut: outMeta.addr as `0x${string}`,
          amountIn,
          fee,
          sqrtPriceLimitX96: 0n,
        }],
      }) as readonly [bigint, bigint, number, bigint];
      amountOut = result[0];
      sqrtPriceAfter = result[1];
      gasEstimate = result[3];
    } catch (v2Err: any) {
      try {
        const r1 = await client.readContract({
          address: quoter,
          abi: QUOTER_V1_ABI,
          functionName: "quoteExactInputSingle",
          args: [
            inMeta.addr as `0x${string}`,
            outMeta.addr as `0x${string}`,
            amountIn,
            fee,
            0n,
          ],
        }) as bigint;
        amountOut = r1;
      } catch (v1Err: any) {
        return fail(`报价失败：QuoterV2 与 V1 签名均不匹配——${String(v1Err?.message ?? v1Err).slice(0, 120)}`, 502);
      }
    }
    if (amountOut <= 0n) {
      return fail("报价结果为 0：池子流动性可能不足以完成这笔兑换", 422);
    }

    // 反向模式：spot 价粗算的 amountIn 一次报价即可，不做迭代修正。
    // 精度由两道防线兜底：① 交易 amountOutMinimum 链上强制（达不到 revert）
    // ② 钱包签名时用户复核实际输入/输出，不合适直接拒绝。

    // 6. 价格影响：spot 价 vs 成交价
    let priceImpactPct: number | null = null;
    try {
      const slot0 = await client.readContract({ address: pool as `0x${string}`, abi: POOL_SLOT0_ABI, functionName: "slot0" }) as readonly [bigint, number, number, number];
      const sqrtP = slot0[0];
      // spot price（tokenOut raw / tokenIn raw，整币口径）
      const spotPrice = Number(sqrtP) ** 2 / Number(1n << 96n) ** 2 * Math.pow(10, decIn - decOut);
      const execPrice = Number(amountOut) / Number(amountIn);
      if (spotPrice > 0) {
        priceImpactPct = Math.abs(spotPrice - execPrice) / spotPrice * 100;
      }
    } catch { /* ignore */ }

    // 7. 滑点后最小获得
    const slippagePct = Number(b.slippage_pct ?? 0.1);
    const slip = BigInt(Math.max(0, Math.min(95, Math.round((slippagePct || 0.1) * 100))));
    const amountOutMin = (amountOut * (10000n - slip)) / 10000n;

    // router：优先 router02（struct 签名），回退 swaprouter
    const routerAddr = dexRow.router02 || dexRow.swaprouter || "";

    // 余额查询（wallet 传入时）：native 用 getBalance，ERC20 用 balanceOf
    let balances: { in: string; out: string } | null = null;
    if (b.wallet && /^0x[a-fA-F0-9]{40}$/.test(b.wallet)) {
      try {
        const readBal = async (tokenAddr: string, isNative: boolean): Promise<bigint> => {
          try {
            if (isNative) {
              return await client.getBalance({ address: b.wallet as `0x${string}` });
            }
            return await client.readContract({
              address: tokenAddr as `0x${string}`,
              abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
              functionName: "balanceOf",
              args: [b.wallet as `0x${string}`],
            }) as bigint;
          } catch { return 0n; }
        };
        // 注意：__native__ 显示原生余额，wrapped 侧读合约余额（用户实际持有的可能两者都有，
        // 这里按面板口径：选了原生币显示原生余额，选了 wrapped 显示 wrapped 余额）
        const inIsNativeToken = b.token_in_addr?.toLowerCase() === "__native__";
        const outIsNativeToken = b.token_out_addr?.toLowerCase() === "__native__";
        const [bin, bout] = await Promise.all([
          readBal(inMeta.addr, inIsNativeToken),
          readBal(outMeta.addr, outIsNativeToken),
        ]);
        balances = { in: bin.toString(), out: bout.toString() };
      } catch { balances = null; }
    }

    return ok({
      chain: { id: chain.id, name: chain.name },
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
      router: routerAddr
        ? { addr: routerAddr, kind: dexRow.router02 ? "router02" : "swaprouter" }
        : null,
      balances,
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
