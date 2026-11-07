import { getDb, isPairFlipped } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";
import { getClient, getChain } from "@/lib/chains";
import { getDexe, listStaking } from "@/lib/chains/dexes";
import { resolveTokens } from "@/lib/chains/tokens";
import { getAmountsForLiquidity, tickToSqrtPriceX96 } from "@/lib/v3/math";
import { V3_POOL_ABI } from "@/lib/adapters/v3-fork";

export const dynamic = "force-dynamic";

const NPM_READ_ABI = [
  {
    name: "ownerOf",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    name: "getApproved",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "operator", type: "address" }],
  },
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

const ERC20_READ_ABI = [
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

/**
 * GET /api/positions/[id]/adjust?wallet=0x...
 * 单次并发 RTT 获取修改已有仓位流动性（或一键质押）所需的全部链上状态：
 * - 当前真实 liquidity、ownerOf(tokenId)（用于断点恢复检测）
 * - Pool slot0 (sqrtPriceX96 / currentTick)
 * - 双币 decimals、当前仓位折算的 token0/token1 数量
 * - 钱包双币余额、对 NPM 的 allowance、对 Staker 的 isApprovedForAll / getApproved
 */
export async function GET(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const url = new URL(req.url);
    const walletParam = url.searchParams.get("wallet") || "";
    const db = getDb();
    const pos = db
      .prepare("SELECT * FROM positions WHERE id=?")
      .get(Number(params.id)) as any;

    if (!pos) return fail("仓位不存在", 404);
    if (!pos.dex_id) return fail("该仓位缺少 DEX 信息");

    const dex = getDexe(pos.dex_id);
    if (!dex?.npm) return fail("DEX 未配置 NPM 地址");

    const chain = getChain(pos.chain_id_ref);
    if (!chain) return fail("链配置不存在");

    const { client } = getClient(pos.chain_id_ref);
    const npmAddr = dex.npm as `0x${string}`;
    const tokenIdBig = BigInt(pos.token_id);
    const poolAddr = pos.pool as `0x${string}`;
    const token0Addr = pos.token0.toLowerCase() as `0x${string}`;
    const token1Addr = pos.token1.toLowerCase() as `0x${string}`;

    // 匹配可用质押合约（若仓位本身未记录 staker_contract，则从配置表或收藏池匹配）
    let stakerContract: string = pos.staker_contract || "";
    let stakerLabel = "";
    const allStaking = listStaking(pos.chain_id_ref, true);
    if (stakerContract) {
      const found = allStaking.find(
        (s) => s.contract.toLowerCase() === stakerContract.toLowerCase()
      );
      stakerLabel = found ? found.pair_label || found.platform : "质押合约";
    } else {
      const normSym = (s: string) =>
        (s || "").toLowerCase().replace(/\.(e|b|c|m|w)$/i, "").trim();
      const base0 = normSym(pos.token0_symbol || "");
      const base1 = normSym(pos.token1_symbol || "");
      const matched = allStaking.find((s) => {
        if (s.dex_id && pos.dex_id && s.dex_id !== pos.dex_id) return false;
        const rawLabel = (s.pair_label || "").toLowerCase();
        if (!rawLabel || !base0 || !base1) return false;
        const labelBases = rawLabel
          .split(/[\/\s,]+/)
          .map((t) => normSym(t))
          .filter((t) => t && !/^\d+(\.\d+)?%?$/.test(t));
        return labelBases.includes(base0) && labelBases.includes(base1);
      });
      if (matched) {
        stakerContract = matched.contract;
        stakerLabel = matched.pair_label || matched.platform;
      } else if (pos.pool) {
        const fav = db
          .prepare(
            "SELECT staker_addr, label FROM liquidity_favorites WHERE chain_id_ref=? AND LOWER(pool_addr)=LOWER(?) AND staker_addr != '' LIMIT 1"
          )
          .get(pos.chain_id_ref, pos.pool) as
          | { staker_addr: string; label: string }
          | undefined;
        if (fav?.staker_addr) {
          stakerContract = fav.staker_addr;
          stakerLabel = fav.label || "质押合约";
        }
      }
    }

    const walletAddr = (
      /^0x[a-fA-F0-9]{40}$/.test(walletParam)
        ? walletParam
        : pos.wallet_address
    ) as `0x${string}`;

    // 单轮并发读取链上状态
    const [ownerRes, posData, slot0Res, tokenMap, walletReads] =
      await Promise.all([
        client
          .readContract({
            address: npmAddr,
            abi: NPM_READ_ABI,
            functionName: "ownerOf",
            args: [tokenIdBig],
          })
          .catch(() => ""),
        client
          .readContract({
            address: npmAddr,
            abi: NPM_READ_ABI,
            functionName: "positions",
            args: [tokenIdBig],
          })
          .catch(() => null),
        poolAddr
          ? client
              .readContract({
                address: poolAddr,
                abi: V3_POOL_ABI,
                functionName: "slot0",
              })
              .catch(() => null)
          : Promise.resolve(null),
        resolveTokens(client, pos.chain_id_ref, [token0Addr, token1Addr]),
        Promise.all([
          client
            .readContract({
              address: token0Addr,
              abi: ERC20_READ_ABI,
              functionName: "balanceOf",
              args: [walletAddr],
            })
            .catch(() => 0n) as Promise<bigint>,
          client
            .readContract({
              address: token1Addr,
              abi: ERC20_READ_ABI,
              functionName: "balanceOf",
              args: [walletAddr],
            })
            .catch(() => 0n) as Promise<bigint>,
          client
            .readContract({
              address: token0Addr,
              abi: ERC20_READ_ABI,
              functionName: "allowance",
              args: [walletAddr, npmAddr],
            })
            .catch(() => 0n) as Promise<bigint>,
          client
            .readContract({
              address: token1Addr,
              abi: ERC20_READ_ABI,
              functionName: "allowance",
              args: [walletAddr, npmAddr],
            })
            .catch(() => 0n) as Promise<bigint>,
          stakerContract
            ? (client
                .readContract({
                  address: npmAddr,
                  abi: NPM_READ_ABI,
                  functionName: "isApprovedForAll",
                  args: [walletAddr, stakerContract as `0x${string}`],
                })
                .catch(() => false) as Promise<boolean>)
            : Promise.resolve(false),
          stakerContract
            ? (client
                .readContract({
                  address: npmAddr,
                  abi: NPM_READ_ABI,
                  functionName: "getApproved",
                  args: [tokenIdBig],
                })
                .catch(() => "") as Promise<string>)
            : Promise.resolve(""),
        ]),
      ]);

    const dec0 = tokenMap.get(token0Addr)?.decimals ?? 18;
    const dec1 = tokenMap.get(token1Addr)?.decimals ?? 18;
    const sym0 =
      pos.token0_symbol || tokenMap.get(token0Addr)?.symbol || "token0";
    const sym1 =
      pos.token1_symbol || tokenMap.get(token1Addr)?.symbol || "token1";

    const realLiquidity: bigint = posData
      ? ((posData as any)[7] as bigint)
      : BigInt(pos.last_liquidity || "0");
    const tickLower: number = posData
      ? Number((posData as any)[5])
      : Number(pos.tick_lower);
    const tickUpper: number = posData
      ? Number((posData as any)[6])
      : Number(pos.tick_upper);

    const sqrtPriceX96: bigint = slot0Res
      ? ((slot0Res as any)[0] as bigint)
      : tickToSqrtPriceX96(Number(pos.last_current_tick || 0));
    const currentTick: number = slot0Res
      ? Number((slot0Res as any)[1])
      : Number(pos.last_current_tick || 0);

    const sqrtLower = tickToSqrtPriceX96(tickLower);
    const sqrtUpper = tickToSqrtPriceX96(tickUpper);
    const currentAmounts = getAmountsForLiquidity(
      sqrtPriceX96,
      sqrtLower,
      sqrtUpper,
      realLiquidity,
      dec0,
      dec1
    );

    const ownerOfStr = String(ownerRes || "");
    const currentlyStakedOnChain = Boolean(
      stakerContract &&
        ownerOfStr &&
        ownerOfStr.toLowerCase() === stakerContract.toLowerCase()
    );
    const pairFlip =
      pos.pair_flip === 1 ||
      isPairFlipped(pos.chain_id_ref, pos.token0, pos.token1)
        ? 1
        : 0;

    const [bal0, bal1, allow0, allow1, isApprovedForAll, approvedOperator] =
      walletReads;
    const singleTokenApproved = Boolean(
      stakerContract &&
        approvedOperator &&
        approvedOperator.toLowerCase() === stakerContract.toLowerCase()
    );

    return ok({
      positionId: pos.id,
      tokenId: pos.token_id,
      npm: dex.npm,
      dexName: dex.name || pos.dex_name || "",
      pool: pos.pool,
      chainIdRef: pos.chain_id_ref,
      pairFlip,
      token0: {
        address: token0Addr,
        symbol: sym0,
        decimals: dec0,
        currentAmount: currentAmounts.amount0,
        walletBalance: bal0.toString(),
        allowance: allow0.toString(),
      },
      token1: {
        address: token1Addr,
        symbol: sym1,
        decimals: dec1,
        currentAmount: currentAmounts.amount1,
        walletBalance: bal1.toString(),
        allowance: allow1.toString(),
      },
      tickLower,
      tickUpper,
      currentTick,
      sqrtPriceX96: sqrtPriceX96.toString(),
      realLiquidity: realLiquidity.toString(),
      ownerOf: ownerOfStr,
      source: pos.source,
      stakerContract,
      stakerLabel,
      currentlyStakedOnChain,
      nftApprovedForAll: isApprovedForAll,
      singleTokenApproved,
      chain: {
        chainId: chain.chain_id,
        name: chain.name,
        rpcUrls: chain.rpc_urls,
        explorerUrl: chain.explorer_url,
        nativeSymbol: chain.symbol,
      },
    });
  } catch (e) {
    return fail(`读取仓位参数失败：${(e as Error).message}`, 500);
  }
}

/**
 * POST /api/positions/[id]/adjust
 * 链上完成「一键质押」或「增/减流动性 + 重新质押」后，
 * 立即从链上读取最新 liquidity 与 ownerOf 并同步回 SQLite 数据库，实现 UI 秒级刷新。
 */
export async function POST(
  req: Request,
  { params }: { params: { id: string } }
) {
  try {
    const body = await getBody<{ stakerContract?: string }>(req).catch(
      () => ({} as { stakerContract?: string })
    );
    const db = getDb();
    const pos = db
      .prepare("SELECT * FROM positions WHERE id=?")
      .get(Number(params.id)) as any;
    if (!pos) return fail("仓位不存在", 404);

    const dex = pos.dex_id ? getDexe(pos.dex_id) : null;
    const { client } = getClient(pos.chain_id_ref);
    const npmAddr = dex?.npm as `0x${string}` | undefined;
    const tokenIdBig = BigInt(pos.token_id);

    let newLiquidity = pos.last_liquidity || "0";
    let ownerOfStr = "";

    if (npmAddr) {
      const [ownerRes, posData] = await Promise.all([
        client
          .readContract({
            address: npmAddr,
            abi: NPM_READ_ABI,
            functionName: "ownerOf",
            args: [tokenIdBig],
          })
          .catch(() => ""),
        client
          .readContract({
            address: npmAddr,
            abi: NPM_READ_ABI,
            functionName: "positions",
            args: [tokenIdBig],
          })
          .catch(() => null),
      ]);
      ownerOfStr = String(ownerRes || "");
      if (posData) {
        newLiquidity = ((posData as any)[7] as bigint).toString();
      }
    }

    const candidateStaker = (
      body.stakerContract ||
      pos.staker_contract ||
      ""
    ).trim();
    const isNowStaked = Boolean(
      candidateStaker &&
        ownerOfStr &&
        ownerOfStr.toLowerCase() === candidateStaker.toLowerCase()
    );

    let stakingId: number | null = pos.staking_id ?? null;
    if (isNowStaked && candidateStaker) {
      const sRow = db
        .prepare(
          "SELECT id FROM staking_contracts WHERE chain_id_ref=? AND LOWER(contract)=LOWER(?) LIMIT 1"
        )
        .get(pos.chain_id_ref, candidateStaker) as { id: number } | undefined;
      if (sRow) stakingId = sRow.id;
    }

    const now = new Date().toISOString();
    const isClosed = BigInt(newLiquidity || "0") === 0n && !isNowStaked;

    db.prepare(
      `UPDATE positions
       SET last_liquidity = ?,
           source = ?,
           staker_contract = ?,
           staking_id = ?,
           notify_state = CASE WHEN ? = 1 THEN 'closed' ELSE notify_state END,
           last_checked_at = ?
       WHERE id = ?`
    ).run(
      newLiquidity,
      isNowStaked ? "staking" : "direct",
      isNowStaked ? candidateStaker : pos.staker_contract || "",
      stakingId,
      isClosed ? 1 : 0,
      now,
      pos.id
    );

    // 清理该仓位的旧流动性快照缓存，确保下次点「流动性分析」读取最新占比
    db.prepare("DELETE FROM liquidity_snapshots WHERE position_id=?").run(
      pos.id
    );

    return ok({
      id: pos.id,
      last_liquidity: newLiquidity,
      source: isNowStaked ? "staking" : "direct",
      staker_contract: isNowStaked ? candidateStaker : "",
    });
  } catch (e) {
    return fail(`同步仓位状态失败：${(e as Error).message}`, 500);
  }
}
