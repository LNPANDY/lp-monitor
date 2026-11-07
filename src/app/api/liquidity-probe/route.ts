import { getDb, isPairFlipped } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";
import { getClient } from "@/lib/chains";
import { listDexes, listStaking } from "@/lib/chains/dexes";
import { ensureStakingPoolMeta, matchStakingContractsForPool } from "@/lib/staking/match";
import { getPoolStaticMeta, probeMinRange } from "@/lib/v3/liquidity";
import type { MinRangeProbeResult } from "@/lib/v3/liquidity";
import { loadAllMappings, buildQuotesByAddr } from "@/lib/cex/binance";

export const dynamic = "force-dynamic";

interface ProbeBody {
  chainId: number; // chains 主键 id
  pool: string;
  staker?: string;
  npm?: string;
  wallet?: string; // 可选连接钱包地址：传入时一并并发返回余额与授权，供建仓与 Swap 直接复用（省去重复请求）
  force?: boolean;
}

const ERC20_BAL_ABI = [
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

function formatRaw(v: bigint, decimals: number): string {
  if (v === 0n) return "0";
  const s = v.toString().padStart(decimals + 1, "0");
  const intPart = s.slice(0, s.length - decimals);
  const fracPart = s.slice(s.length - decimals).replace(/0+$/, "");
  return fracPart ? `${intPart}.${fracPart}` : intPart;
}

export async function POST(req: Request) {
  try {
    const b = await getBody<ProbeBody>(req);
    if (!b.chainId) return fail("缺少 chainId");
    if (!b.pool) return fail("缺少 pool 地址");
    const db = getDb();
    const { client, chain } = getClient(b.chainId);
    const poolAddr = b.pool.trim() as `0x${string}`;

    // 1. 读取池子静态元数据（进程级永久缓存，已缓存池 0 RPC！）
    let meta;
    try {
      meta = await getPoolStaticMeta(client, b.chainId, poolAddr);
    } catch (e) {
      return fail(`读取池子元数据失败：${(e as Error).message}`, 502);
    }

    const { token0, token1, decimals0: dec0, decimals1: dec1, symbol0: sym0, symbol1: sym1, fee, tickSpacing, factory } = meta;

    // 匹配 DEX 与质押合约（纯内存/SQLite 计算，0 RPC）
    const dexes = listDexes(b.chainId, true).filter((d) => d.type === "v3-fork");
    const matchedDex =
      (factory
        ? dexes.find((d) => (d.factory || "").toLowerCase() === factory.toLowerCase())
        : undefined) ?? dexes[0];

    const allStaking = listStaking(b.chainId, true);
    await ensureStakingPoolMeta(client, b.chainId, allStaking);
    const matchedStaking = matchStakingContractsForPool(allStaking, {
      chainIdRef: b.chainId,
      dexId: matchedDex?.id,
      token0,
      token1,
      symbol0: sym0,
      symbol1: sym1,
      fee: Number(fee),
    });

    // 2. 并行执行：最小区间探针（仅 slot0 + liquidity 1 个 RTT） + CEX 报价 + （可选）钱包双币余额与授权
    const cexMappingsByChain = loadAllMappings();
    const chainMappings = cexMappingsByChain.get(b.chainId) ?? [];
    const hasWallet = !!(b.wallet && /^0x[a-fA-F0-9]{40}$/.test(b.wallet));
    const walletAddr = hasWallet ? (b.wallet as `0x${string}`) : undefined;
    const npmAddr = ((b.npm || "").trim() || matchedDex?.npm || "") as `0x${string}`;
    const stakerAddr = ((b.staker || "").trim() || matchedStaking[0]?.contract || "") as `0x${string}`;

    const [result, quoteByAddr, walletState] = await Promise.all([
      probeMinRange(
        client,
        poolAddr,
        dec0,
        dec1,
        sym0,
        sym1,
        npmAddr || undefined,
        stakerAddr || undefined,
        !!b.force
      ),
      chainMappings.length > 0
        ? buildQuotesByAddr(chainMappings)
        : Promise.resolve(new Map()),
      walletAddr
        ? Promise.all([
            client
              .readContract({
                address: token0,
                abi: ERC20_BAL_ABI,
                functionName: "balanceOf",
                args: [walletAddr],
              })
              .catch(() => 0n) as Promise<bigint>,
            client
              .readContract({
                address: token1,
                abi: ERC20_BAL_ABI,
                functionName: "balanceOf",
                args: [walletAddr],
              })
              .catch(() => 0n) as Promise<bigint>,
            npmAddr
              ? (client
                  .readContract({
                    address: token0,
                    abi: ERC20_BAL_ABI,
                    functionName: "allowance",
                    args: [walletAddr, npmAddr],
                  })
                  .catch(() => 0n) as Promise<bigint>)
              : Promise.resolve(0n),
            npmAddr
              ? (client
                  .readContract({
                    address: token1,
                    abi: ERC20_BAL_ABI,
                    functionName: "allowance",
                    args: [walletAddr, npmAddr],
                  })
                  .catch(() => 0n) as Promise<bigint>)
              : Promise.resolve(0n),
            npmAddr && stakerAddr
              ? (client
                  .readContract({
                    address: npmAddr,
                    abi: ERC721_APPROVAL_ABI,
                    functionName: "isApprovedForAll",
                    args: [walletAddr, stakerAddr],
                  })
                  .catch(() => false) as Promise<boolean>)
              : Promise.resolve(false),
          ])
        : Promise.resolve(null),
    ]);

    // 3. CEX 差价计算
    let cexPayload: any = undefined;
    if (chainMappings.length > 0) {
      const q0 = quoteByAddr.get(token0.toLowerCase());
      const q1 = quoteByAddr.get(token1.toLowerCase());
      if (q0 && q1 && result.priceCurrent) {
        const dexRate = Number(result.priceCurrent);
        const cexRate = q0.price / q1.price;
        if (
          Number.isFinite(dexRate) &&
          dexRate > 0 &&
          Number.isFinite(cexRate) &&
          cexRate > 0
        ) {
          const diff = (dexRate - cexRate) / cexRate;
          const absDiff = Math.abs(diff);
          const threshold = (result.fee / 1_000_000) * 2;
          const quote =
            q0.quote === q1.quote
              ? q0.quote || "USD"
              : `${q0.quote}/${q1.quote}`;
          cexPayload = {
            pairLabel: `${sym0}/${sym1}`,
            token0CexSymbol: q0.symbol,
            token1CexSymbol: q1.symbol,
            quote,
            dexRate,
            cexRate,
            diff,
            absDiff,
            exceedsThreshold: absDiff >= threshold,
            token0Price: q0.price,
            token1Price: q1.price,
            token0Quote: q0.quote,
            token1Quote: q1.quote,
          };
        }
      }
    }

    const pairFlip = isPairFlipped(b.chainId, token0, token1) ? 1 : 0;

    // 4. 探针成功后，仅当收藏表缺 symbol 时才更新 SQLite
    if (sym0 && sym1) {
      try {
        db.prepare(
          `UPDATE liquidity_favorites
           SET token0 = ?, token1 = ?, token0_symbol = ?, token1_symbol = ?
           WHERE chain_id_ref = ? AND LOWER(pool_addr) = LOWER(?) AND (token0_symbol IS NULL OR token0_symbol = '')`
        ).run(
          token0.toLowerCase(),
          token1.toLowerCase(),
          sym0,
          sym1,
          b.chainId,
          b.pool.toLowerCase()
        );
      } catch {}
    }

    // 5. 组装供下方「建仓面板」和「Swap 面板」直接复用的初始数据包（消除二次请求！）
    const balances = walletState
      ? {
          token0: walletState[0].toString(),
          token1: walletState[1].toString(),
          token0Human: formatRaw(walletState[0], dec0),
          token1Human: formatRaw(walletState[1], dec1),
        }
      : null;

    const approvals =
      walletState && matchedDex
        ? {
            token0: {
              allowance: walletState[2].toString(),
              sufficient: walletState[2] > 0n,
              decimals: dec0,
            },
            token1: {
              allowance: walletState[3].toString(),
              sufficient: walletState[3] > 0n,
              decimals: dec1,
            },
            nftApprovedForAll: walletState[4],
          }
        : null;

    const mintInit = {
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
        fee,
        tickSpacing: result.tickSpacing || tickSpacing,
        currentTick: result.currentTick,
        sqrtPriceX96: result.sqrtPriceX96 ?? "0",
        priceCurrent: result.priceCurrent,
      },
      range: {
        tickLower: result.tickLower,
        tickUpper: result.tickUpper,
        priceLow: result.priceLow,
        priceHigh: result.priceHigh,
        isMinimal: true,
      },
      compute: null,
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
    };

    return ok({
      ...result,
      pool: b.pool,
      token0,
      token1,
      token0Decimals: dec0,
      token1Decimals: dec1,
      pairFlip,
      stakedPlatform:
        matchedStaking[0]?.pair_label ||
        matchedStaking[0]?.platform ||
        (stakerAddr ? "质押合约" : ""),
      cex: cexPayload,
      mintInit,
      cached: false,
    });
  } catch (e) {
    console.error("[liquidity-probe] UNCAUGHT:", e);
    return fail(`未捕获异常：${(e as Error).message}`, 500);
  }
}
