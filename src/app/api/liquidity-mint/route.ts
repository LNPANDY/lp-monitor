/**
 * 创建仓位的参数准备 API（极速版）。
 *
 * 优化要点：
 *   1. 复用进程级 `getPoolStaticMeta` 缓存（token0/token1/fee/tickSpacing/factory/decimals/symbol 0 RPC）。
 *   2. 将 `slot0 + liquidity` 与钱包的 `balanceOf + allowance + isApprovedForAll` 合并为单次 `Promise.all` 并行读取（仅 1 个 RTT）。
 *   3. 直接使用 `Pool.liquidity()` 计算窗口占比，移除耗时数秒的质押合约 Vault 枚举。
 */
import { isPairFlipped } from "@/lib/db";
import { getClient } from "@/lib/chains";
import { ok, fail, getBody } from "@/lib/api";
import { listDexes, listStaking } from "@/lib/chains/dexes";
import {
  tickToSqrtPriceX96,
  computeLiquidityFromAmount,
} from "@/lib/wallet/build-mint";
import { sqrtPriceX96ToHumanPrice, tickToPriceDisplay } from "@/lib/v3/math";
import {
  getPoolStaticMeta,
  readPoolState,
  sumStakedWindowLiquidity,
} from "@/lib/v3/liquidity";

export const dynamic = "force-dynamic";

function floorTick(tick: number, spacing: number): number {
  return Math.floor(tick / spacing) * spacing;
}
function ceilTick(tick: number, spacing: number): number {
  return Math.ceil(tick / spacing) * spacing;
}

const ERC20_ABI = [
  {
    name: "balanceOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
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

const ERC721_APPROVAL_ABI = [
  {
    name: "isApprovedForAll",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

export async function POST(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    pool?: string;
    wallet?: string;
    tick_lower?: number;
    tick_upper?: number;
    input_side?: "token0" | "token1";
    input_amount?: string;
  }>(req);

  if (!b.chain_id || !b.pool) return fail("chain_id 和 pool 必填");
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.pool)) return fail("pool 地址非法");

  const { client, chain } = getClient(b.chain_id);
  const pool = b.pool as `0x${string}`;

  try {
    // 1. 获取池子静态元数据（命中缓存时 0 RPC！）
    const meta = await getPoolStaticMeta(client, b.chain_id, pool);
    const {
      token0,
      token1,
      fee,
      tickSpacing: spacing,
      factory: poolFactory,
      decimals0: dec0,
      decimals1: dec1,
      symbol0: sym0,
      symbol1: sym1,
    } = meta;

    // 2. 匹配 DEX 与质押合约（纯内存/SQLite，0 RPC）
    const dexes = listDexes(b.chain_id, true).filter((d) => d.type === "v3-fork");
    const matchedDex =
      (poolFactory
        ? dexes.find((d) => (d.factory || "").toLowerCase() === poolFactory.toLowerCase())
        : undefined) ?? dexes[0];

    const normSym = (s: string) =>
      (s || "").toLowerCase().replace(/\.(e|b|c|m|w)$/i, "").trim();
    const base0 = normSym(sym0);
    const base1 = normSym(sym1);
    const allStaking = listStaking(b.chain_id, true);
    const matchedStaking = allStaking.filter((s) => {
      const rawLabel = (s.pair_label || "").toLowerCase();
      if (!rawLabel) return false;
      const labelBases = rawLabel
        .split(/[\/\s,]+/)
        .map((t) => normSym(t))
        .filter((t) => t && !/^\d+(\.\d+)?%?$/.test(t));
      return labelBases.includes(base0) && labelBases.includes(base1);
    });

    // 3. 单次并行 RTT 读取：池子实时状态（slot0 + liquidity）+（若有钱包）余额与授权
    const hasWallet = !!(b.wallet && /^0x[a-fA-F0-9]{40}$/.test(b.wallet));
    const walletAddr = hasWallet ? (b.wallet as `0x${string}`) : undefined;
    const npmAddr = matchedDex?.npm as `0x${string}` | undefined;
    const stakerContract = matchedStaking[0]?.contract as `0x${string}` | undefined;

    const [poolState, walletReads] = await Promise.all([
      readPoolState(client, pool),
      walletAddr
        ? Promise.all([
            client
              .readContract({
                address: token0,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [walletAddr],
              })
              .catch(() => 0n) as Promise<bigint>,
            client
              .readContract({
                address: token1,
                abi: ERC20_ABI,
                functionName: "balanceOf",
                args: [walletAddr],
              })
              .catch(() => 0n) as Promise<bigint>,
            npmAddr
              ? (client
                  .readContract({
                    address: token0,
                    abi: ERC20_ABI,
                    functionName: "allowance",
                    args: [walletAddr, npmAddr],
                  })
                  .catch(() => 0n) as Promise<bigint>)
              : Promise.resolve(0n),
            npmAddr
              ? (client
                  .readContract({
                    address: token1,
                    abi: ERC20_ABI,
                    functionName: "allowance",
                    args: [walletAddr, npmAddr],
                  })
                  .catch(() => 0n) as Promise<bigint>)
              : Promise.resolve(0n),
            npmAddr && stakerContract
              ? (client
                  .readContract({
                    address: npmAddr,
                    abi: ERC721_APPROVAL_ABI,
                    functionName: "isApprovedForAll",
                    args: [walletAddr, stakerContract],
                  })
                  .catch(() => false) as Promise<boolean>)
              : Promise.resolve(false),
          ])
        : Promise.resolve(null),
    ]);

    const { sqrtPriceX96, currentTick, liquidity: poolLiquidity } = poolState;

    // 4. 计算区间
    let tickLower: number;
    let tickUpper: number;
    if (b.tick_lower !== undefined && b.tick_upper !== undefined) {
      tickLower = floorTick(Number(b.tick_lower), spacing);
      tickUpper = ceilTick(Number(b.tick_upper), spacing);
      if (tickLower >= tickUpper) return fail("tick_lower 必须小于 tick_upper");
    } else {
      tickLower = floorTick(currentTick, spacing);
      tickUpper = tickLower + spacing;
    }

    // 5. 单侧金额反算 + 质押仓位占比 & 全池窗口占比估算（优先命中 15s 质押窗口缓存与 NFT 静态缓存）
    let compute: {
      liquidity: string;
      amount0: string;
      amount1: string;
      amount0Human: string;
      amount1Human: string;
      shareAfter?: number;
      stakedShareAfter?: number;
      shareInPool?: number;
      poolLiquidity?: string;
      stakedLiquidity?: string;
      stakedPositionCount?: number;
      hasStaking?: boolean;
    } | null = null;

    if (b.input_side && b.input_amount) {
      const sideDec = b.input_side === "token0" ? dec0 : dec1;
      const amountRaw = parseHumanAmount(b.input_amount, sideDec);
      if (amountRaw > 0n) {
        const sqrtLower = tickToSqrtPriceX96(tickLower);
        const sqrtUpper = tickToSqrtPriceX96(tickUpper);
        const r = computeLiquidityFromAmount(
          sqrtPriceX96,
          sqrtLower,
          sqrtUpper,
          b.input_side,
          amountRaw
        );

        const mine = r.liquidity;
        const hasStaking = Boolean(
          npmAddr &&
            stakerContract &&
            /^0x[a-fA-F0-9]{40}$/.test(npmAddr) &&
            /^0x[a-fA-F0-9]{40}$/.test(stakerContract)
        );

        let stakedLiquidityRaw = 0n;
        let stakedPositionCount = 0;
        if (hasStaking && npmAddr && stakerContract) {
          try {
            const stakedInfo = await sumStakedWindowLiquidity(
              client,
              npmAddr,
              stakerContract,
              pool,
              tickLower,
              tickUpper
            );
            stakedLiquidityRaw = stakedInfo.stakedLiquidityRaw;
            stakedPositionCount = stakedInfo.matchedCount;
          } catch (e) {
            console.warn("[liquidity-mint] sumStakedWindowLiquidity failed:", (e as Error).message);
          }
        }

        const shareInPool =
          mine > 0n && poolLiquidity + mine > 0n
            ? Number(mine) / Number(poolLiquidity + mine)
            : 0;

        const stakedShareAfter =
          hasStaking && mine > 0n && stakedLiquidityRaw + mine > 0n
            ? Number(mine) / Number(stakedLiquidityRaw + mine)
            : undefined;

        const shareAfter =
          stakedShareAfter !== undefined ? stakedShareAfter : shareInPool;

        compute = {
          liquidity: r.liquidity.toString(),
          amount0: r.amount0.toString(),
          amount1: r.amount1.toString(),
          amount0Human: formatRaw(r.amount0, dec0),
          amount1Human: formatRaw(r.amount1, dec1),
          shareAfter,
          stakedShareAfter,
          shareInPool,
          poolLiquidity: poolLiquidity.toString(),
          stakedLiquidity: stakedLiquidityRaw.toString(),
          stakedPositionCount,
          hasStaking,
        };
      }
    }

    const pairFlip = isPairFlipped(b.chain_id, token0, token1) ? 1 : 0;
    const priceCurrent = sqrtPriceX96ToHumanPrice(sqrtPriceX96, dec0, dec1);
    const priceLow = tickToPriceDisplay(tickLower, dec0, dec1);
    const priceHigh = tickToPriceDisplay(tickUpper, dec0, dec1);

    let balances = null;
    let approvals = null;
    if (walletReads) {
      const [bal0, bal1, a0, a1, nftAll] = walletReads;
      balances = {
        token0: bal0.toString(),
        token1: bal1.toString(),
        token0Human: formatRaw(bal0, dec0),
        token1Human: formatRaw(bal1, dec1),
      };
      if (matchedDex) {
        const need0 = compute ? BigInt(compute.amount0) : 1n;
        const need1 = compute ? BigInt(compute.amount1) : 1n;
        approvals = {
          token0: {
            allowance: a0.toString(),
            sufficient: a0 >= need0,
            decimals: dec0,
          },
          token1: {
            allowance: a1.toString(),
            sufficient: a1 >= need1,
            decimals: dec1,
          },
          nftApprovedForAll: nftAll,
        };
      }
    }

    return ok({
      chain: { id: chain.id, name: chain.name, chain_id: chain.chain_id },
      pairFlip,
      pool: {
        address: b.pool.toLowerCase(),
        token0: token0.toLowerCase(),
        token1: token1.toLowerCase(),
        token0Symbol: sym0,
        token1Symbol: sym1,
        token0Decimals: dec0,
        token1Decimals: dec1,
        fee: Number(fee),
        tickSpacing: spacing,
        currentTick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        priceCurrent,
      },
      range: {
        tickLower,
        tickUpper,
        priceLow,
        priceHigh,
        isMinimal:
          tickLower === floorTick(currentTick, spacing) &&
          tickUpper === tickLower + spacing,
      },
      compute,
      balances,
      matchedStaking: matchedStaking.map((s) => ({
        id: s.id,
        platform: s.platform,
        pair_label: s.pair_label,
        contract: s.contract,
      })),
      dex: matchedDex
        ? { id: matchedDex.id, name: matchedDex.name, npm: matchedDex.npm }
        : null,
      approvals,
    });
  } catch (e: any) {
    return fail(`读取池子状态失败：${e?.message ?? e}`, 502);
  }
}

function parseHumanAmount(input: string, decimals: number): bigint {
  const s = input.trim();
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

function formatRaw(v: bigint, decimals: number): string {
  if (v === 0n) return "0";
  const s = v.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}
