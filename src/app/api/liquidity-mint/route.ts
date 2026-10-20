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

    // 4. 质押合约：按 token 对自动匹配（不返回全部，避免用户选错）
    //    匹配规则：staking_contracts.pair_label 含 token0/token1 的 symbol。
    //    需要 symbol 别名归一化：链上 symbol 可能是 "USDC.e"/"WETH.e"，而用户配置的
    //    pair_label 常写 "USDC"/"WETH"。这里按基础名（去掉 .e/.b/.c 等后缀）比对。
    const normSym = (s: string) => (s || "").toLowerCase().replace(/\.(e|b|c|m|w)$/i, "").trim();
    const base0 = normSym(m0?.symbol ?? "");
    const base1 = normSym(m1?.symbol ?? "");
    const allStaking = listStaking(b.chain_id, true);
    const matchedStaking = allStaking.filter((s) => {
      const rawLabel = (s.pair_label || "").toLowerCase();
      if (!rawLabel) return false;
      // 把 label 里的每个 token 名也做归一化，便于 "USDC" 匹配 "USDC.e"
      // label 形如 "W0G/USDC"、"WBTC / W0G"、"W0G/WETH 0.3"
      const labelBases = rawLabel
        .split(/[\/\s,]+/)
        .map((t) => normSym(t))
        .filter((t) => t && !/^\d+(\.\d+)?%?$/.test(t)); // 排除 "0.3" 这类费率后缀
      return labelBases.includes(base0) && labelBases.includes(base1);
    });

    // 5. 匹配的 DEX（v3）：用 factory 反查池子所属 factory，避免用户选错
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

    // 6. 单侧金额反算（可选）
    let compute: {
      liquidity: string;
      amount0: string;
      amount1: string;
      amount0Human: string;
      amount1Human: string;
      /** 添加后在该区间的流动性占比（0~1），分母=池子当前活跃流动性 */
      shareAfter?: number;
      /** 池子当前活跃流动性 */
      poolLiquidity?: string;
      /** 该区间内已质押的流动性总和（参考） */
      stakedLiquidity?: string;
      /** 相对质押池的占比（参考） */
      shareInStaking?: number;
    } | null = null;
    if (b.input_side && b.input_amount) {
      const dec0 = m0?.decimals ?? 18;
      const dec1 = m1?.decimals ?? 18;
      const sideDec = b.input_side === "token0" ? dec0 : dec1;
      const amountRaw = parseHumanAmount(b.input_amount, sideDec);
      if (amountRaw > 0n) {
        const sqrtLower = tickToSqrtPriceX96(tickLower);
        const sqrtUpper = tickToSqrtPriceX96(tickUpper);
        const r = computeLiquidityFromAmount(sqrtPriceX96, sqrtLower, sqrtUpper, b.input_side, amountRaw);

        // 分母用「池子当前活跃流动性」= 该 tick 处所有 LP 的流动性总和
        // （包含质押的 + 直接持有的 + 其他 vault 的）。
        // 说明：pool.liquidity() 是当前 tick 处的活跃流动性；若目标区间不含当前 tick，
        // 该值不代表目标区间的真实流动性。
        let poolLiquidity = 0n;
        try {
          poolLiquidity = await client.readContract({
            address: pool,
            abi: [{ name: "liquidity", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint128" }] }] as const,
            functionName: "liquidity",
          }) as bigint;
        } catch { /* 部分池子无 liquidity view */ }

        // 额外统计：该区间内「已质押」的流动性（仅作参考展示，不参与主占比）
        let stakedLiquidity = 0n;
        if (matchedStaking.length > 0 && matchedDex) {
          stakedLiquidity = await sumStakedLiquidity(
            client,
            matchedDex.npm as `0x${string}`,
            matchedStaking[0].contract as `0x${string}`,
            token0,
            token1,
            Number(fee),
            tickLower,
            tickUpper
          );
        }

        const mine = r.liquidity;
        // 主占比：相对池子在该 tick 的活跃流动性（这才是真实的市场份额）
        const shareAfter = mine > 0n && (poolLiquidity + mine) > 0n
          ? Number(mine) / Number(poolLiquidity + mine)
          : 0;
        // 参考占比：相对「质押池同区间流动性 + 自己」（看质押竞争程度）
        const shareInStaking = mine > 0n && stakedLiquidity > 0n
          ? Number(mine) / Number(stakedLiquidity + mine)
          : 0;

        compute = {
          liquidity: r.liquidity.toString(),
          amount0: r.amount0.toString(),
          amount1: r.amount1.toString(),
          amount0Human: formatRaw(r.amount0, dec0),
          amount1Human: formatRaw(r.amount1, dec1),
          shareAfter,
          poolLiquidity: poolLiquidity.toString(),
          stakedLiquidity: stakedLiquidity.toString(),
          shareInStaking,
        };
      }
    }

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

/**
 * 汇总质押合约在同一池子、同一 tick 区间内的 LP 流动性总和。
 *
 * 实现：枚举 vault 在 NPM 上持有的全部 NFT（balanceOf + tokenOfOwnerByIndex），
 * 读每个 NFT 的 positions()，筛选 token0/token1/fee 匹配且 tick 区间相同的，累加 liquidity。
 *
 * 失败返回 0n（调用方会回退到 pool.liquidity()）。
 */
async function sumStakedLiquidity(
  client: any,
  npm: `0x${string}`,
  vault: `0x${string}`,
  token0: string,
  token1: string,
  fee: number,
  tickLower: number,
  tickUpper: number
): Promise<bigint> {
  try {
    const balance = await client.readContract({
      address: npm,
      abi: [{ name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const,
      functionName: "balanceOf",
      args: [vault],
    }) as bigint;
    if (balance === 0n) return 0n;

    // 枚举 tokenId（限制上限避免 RPC 爆炸）
    const maxScan = balance > 200n ? 200n : balance;
    const ids: bigint[] = [];
    for (let i = 0n; i < maxScan; i++) {
      try {
        const id = await client.readContract({
          address: npm,
          abi: [{ name: "tokenOfOwnerByIndex", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }, { name: "index", type: "uint256" }], outputs: [{ name: "", type: "uint256" }] }] as const,
          functionName: "tokenOfOwnerByIndex",
          args: [vault, i],
        }) as bigint;
        ids.push(id);
      } catch { break; }
    }
    if (ids.length === 0) return 0n;

    const t0 = token0.toLowerCase();
    const t1 = token1.toLowerCase();
    const positionsAbi = [
      {
        name: "positions",
        type: "function",
        stateMutability: "view",
        inputs: [{ name: "tokenId", type: "uint256" }],
        outputs: [
          { name: "nonce", type: "uint96" },
          { name: "operator", type: "address" },
          { name: "token0", type: "address" },
          { name: "token1", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "tickLower", type: "int24" },
          { name: "tickUpper", type: "int24" },
          { name: "liquidity", type: "uint128" },
          { name: "feeGrowthInside0LastX128", type: "uint256" },
          { name: "feeGrowthInside1LastX128", type: "uint256" },
          { name: "tokensOwed0", type: "uint128" },
          { name: "tokensOwed1", type: "uint128" },
        ],
      },
    ] as const;

    let total = 0n;
    // 并发读取（限并 8）
    const chunkSize = 8;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const results = await Promise.all(
        chunk.map(async (id) => {
          try {
            return await client.readContract({
              address: npm,
              abi: positionsAbi,
              functionName: "positions",
              args: [id],
            }) as readonly any[];
          } catch { return null; }
        })
      );
      for (const r of results) {
        if (!r) continue;
        if (String(r[2]).toLowerCase() !== t0) continue;
        if (String(r[3]).toLowerCase() !== t1) continue;
        if (Number(r[4]) !== fee) continue;
        if (Number(r[5]) !== tickLower || Number(r[6]) !== tickUpper) continue;
        total += BigInt(r[7]);
      }
    }
    return total;
  } catch {
    return 0n;
  }
}
