/**
 * 创建仓位的参数准备 API。
 *
 * GET/POST 返回：
 *   - 池子当前状态（currentTick / sqrtPriceX96 / tickSpacing / 最小窗口区间）
 *   - 给定 tickLower/tickUpper + 单侧金额时的反算结果（liquidity / 两侧金额）
 *   - 可选的质押合约列表（供前端选择是否质押）
 *
 * 前端拿到后构造 mint / approve / deposit 的 calldata 发交易。
 */
import { getDb } from "@/lib/db";
import { getClient } from "@/lib/chains";
import { resolveTokens } from "@/lib/chains/tokens";
import { ok, fail, getBody } from "@/lib/api";
import { listStaking } from "@/lib/chains/dexes";
import {
  tickToSqrtPriceX96,
  computeLiquidityFromAmount,
} from "@/lib/wallet/build-mint";

export const dynamic = "force-dynamic";

const POOL_STATE_ABI = [
  {
    name: "slot0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
    ],
  },
  {
    name: "tickSpacing",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "int24" }],
  },
  {
    name: "token0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "token1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "fee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
] as const;

/** 把 tick 向下对齐到 tickSpacing 的整数倍 */
function floorTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}
/** 把 tick 向上对齐 */
function ceilTick(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

export async function POST(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    pool?: string;
    /** 钱包地址：传了才会查授权额度 */
    wallet?: string;
    /** 可选：指定区间（不传则用当前 tick 所在的最小 tickSpacing 窗口） */
    tick_lower?: number;
    tick_upper?: number;
    /** 可选：单侧金额反算 */
    input_side?: "token0" | "token1";
    input_amount?: string;
  }>(req);

  if (!b.chain_id || !b.pool) return fail("chain_id 和 pool 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.pool)) return fail("pool 地址非法");

  const db = getDb();
  const { client, chain } = getClient(b.chain_id);
  const pool = b.pool as `0x${string}`;

  try {
    // 1. 读池子基础状态
    const [slot0, tickSpacing, token0, token1, fee] = await Promise.all([
      client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "slot0" }) as Promise<readonly [bigint, number, number, number]>,
      client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "tickSpacing" }) as Promise<number>,
      client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "token0" }) as Promise<string>,
      client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "token1" }) as Promise<string>,
      client.readContract({ address: pool, abi: POOL_STATE_ABI, functionName: "fee" }) as Promise<number>,
    ]);

    const sqrtPriceX96 = slot0[0];
    const currentTick = Number(slot0[1]);
    const spacing = Number(tickSpacing);

    // 2. 计算区间：未指定时用当前 tick 所在的最小 tickSpacing 窗口
    let tickLower: number;
    let tickUpper: number;
    if (b.tick_lower !== undefined && b.tick_upper !== undefined) {
      tickLower = floorTick(Number(b.tick_lower), spacing);
      tickUpper = ceilTick(Number(b.tick_upper), spacing);
      if (tickLower >= tickUpper) return fail("tick_lower 必须小于 tick_upper");
    } else {
      // 最小窗口：包含当前 tick 的最小 tickSpacing 区间
      tickLower = floorTick(currentTick, spacing);
      tickUpper = tickLower + spacing;
    }

    // 3. token 元数据
    const tokenMap = await resolveTokens(client, b.chain_id, [token0, token1]);
    const m0 = tokenMap.get(token0.toLowerCase());
    const m1 = tokenMap.get(token1.toLowerCase());

    // 4. 单侧金额反算（可选）
    let compute: {
      liquidity: string;
      amount0: string;
      amount1: string;
      amount0Human: string;
      amount1Human: string;
    } | null = null;
    if (b.input_side && b.input_amount) {
      const dec0 = m0?.decimals ?? 18;
      const dec1 = m1?.decimals ?? 18;
      const sideDec = b.input_side === "token0" ? dec0 : dec1;
      // 人类可读金额 → 原始单位 BigInt
      const amountRaw = parseHumanAmount(b.input_amount, sideDec);
      if (amountRaw > 0n) {
        const sqrtLower = tickToSqrtPriceX96(tickLower);
        const sqrtUpper = tickToSqrtPriceX96(tickUpper);
        const r = computeLiquidityFromAmount(sqrtPriceX96, sqrtLower, sqrtUpper, b.input_side, amountRaw);
        compute = {
          liquidity: r.liquidity.toString(),
          amount0: r.amount0.toString(),
          amount1: r.amount1.toString(),
          amount0Human: formatRaw(r.amount0, dec0),
          amount1Human: formatRaw(r.amount1, dec1),
        };
      }
    }

    // 5. 质押合约：按 token 对自动匹配（不返回全部，避免用户选错）
    //    匹配规则：staking_contracts.pair_label 含 token0/token1 的 symbol（大小写不敏感）
    const sym0 = (m0?.symbol ?? "").toLowerCase();
    const sym1 = (m1?.symbol ?? "").toLowerCase();
    const allStaking = listStaking(b.chain_id, true);
    const matchedStaking = allStaking.filter((s) => {
      const label = (s.pair_label || "").toLowerCase();
      if (!label) return false;
      // pair_label 形如 "W0G/USDC"、"WBTC / W0G"、"W0G/WETH 0.3"
      // 两边 symbol 都要出现在 label 里（顺序无关）
      return label.includes(sym0) && label.includes(sym1);
    });

    // 6. 匹配的 DEX（v3）：用 factory 反查池子所属 factory，避免用户选错
    const dexes = db.prepare(
      "SELECT id, name, type, factory, npm, stateview FROM dexes WHERE chain_id_ref=? AND enabled=1 AND type='v3-fork'"
    ).all(b.chain_id) as any[];

    // 用池子的 factory() 精确定位 DEX
    let poolFactory = "";
    try {
      poolFactory = await client.readContract({
        address: pool,
        abi: [{ name: "factory", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "address" }] }] as const,
        functionName: "factory",
      }) as string;
    } catch { /* 部分池子无 factory view，回退到全部 */ }
    const matchedDex = poolFactory
      ? dexes.find((d) => d.factory.toLowerCase() === poolFactory.toLowerCase())
      : undefined;

    // 7. 授权状态（需要钱包地址才查）
    let approvals: {
      token0: { allowance: string; sufficient: boolean; decimals: number };
      token1: { allowance: string; sufficient: boolean; decimals: number };
    } | null = null;
    if (b.wallet && /^0x[a-fA-F0-9]{40}$/.test(b.wallet) && matchedDex) {
      const dec0 = m0?.decimals ?? 18;
      const dec1 = m1?.decimals ?? 18;
      const need0 = compute ? BigInt(compute.amount0) : 0n;
      const need1 = compute ? BigInt(compute.amount1) : 0n;
      const [a0, a1] = await Promise.all([
        readAllowance(client, token0, b.wallet, matchedDex.npm),
        readAllowance(client, token1, b.wallet, matchedDex.npm),
      ]);
      approvals = {
        token0: { allowance: a0.toString(), sufficient: a0 >= need0, decimals: dec0 },
        token1: { allowance: a1.toString(), sufficient: a1 >= need1, decimals: dec1 },
      };
    }

    return ok({
      chain: { id: chain.id, name: chain.name, chain_id: chain.chain_id },
      pool: {
        address: b.pool.toLowerCase(),
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        token0Symbol: m0?.symbol ?? "",
        token1Symbol: m1?.symbol ?? "",
        token0Decimals: m0?.decimals ?? 18,
        token1Decimals: m1?.decimals ?? 18,
        fee: Number(fee),
        tickSpacing: spacing,
        currentTick,
        sqrtPriceX96: sqrtPriceX96.toString(),
      },
      range: {
        tickLower,
        tickUpper,
        isMinimal: tickLower === floorTick(currentTick, spacing) && tickUpper === tickLower + spacing,
      },
      compute,
      /** 自动匹配的质押合约（可能为空 = 该 token 对无质押平台） */
      matchedStaking: matchedStaking.map((s) => ({
        id: s.id,
        platform: s.platform,
        pair_label: s.pair_label,
        contract: s.contract,
      })),
      /** 自动匹配的 DEX（按池子 factory 精确匹配） */
      dex: matchedDex ? { id: matchedDex.id, name: matchedDex.name, npm: matchedDex.npm } : null,
      /** 授权状态（需传 wallet 且能匹配 DEX） */
      approvals,
    });
  } catch (e: any) {
    return fail(`读取池子状态失败：${e?.message ?? e}`, 502);
  }
}

/** 人类可读金额 → 原始单位 BigInt（支持小数，最多 decimals 位） */
function parseHumanAmount(input: string, decimals: number): bigint {  const s = input.trim();
  if (!s) return 0n;
  if (!/^\d*\.?\d*$/.test(s)) return 0n;
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

/** 查询 ERC20 授权额度（失败返回 0n，前端会按"需要授权"处理） */
async function readAllowance(
  client: any,
  token: string,
  owner: string,
  spender: string
): Promise<bigint> {
  try {
    const abi = [
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
    const v = await client.readContract({
      address: token as `0x${string}`,
      abi,
      functionName: "allowance",
      args: [owner as `0x${string}`, spender as `0x${string}`],
    });
    return v as bigint;
  } catch {
    return 0n;
  }
}
