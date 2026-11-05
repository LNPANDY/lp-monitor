import { getDb, isPairFlipped } from "@/lib/db";
import { ok, fail } from "@/lib/api";
import { getClient, getChain } from "@/lib/chains";
import { getDexe } from "@/lib/chains/dexes";

export const dynamic = "force-dynamic";

/**
 * GET: 返回移除仓位所需的全部链上参数（前端构造写交易用）。
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    const pos = db.prepare("SELECT * FROM positions WHERE id=?").get(params.id) as
      | {
          id: number;
          chain_id_ref: number;
          dex_id: number | null;
          dex_name: string;
          token_id: string;
          token0: string;
          token1: string;
          source: string;
          staker_contract: string;
          pool: string;
          last_liquidity: string;
          pair_flip: number;
        }
      | undefined;

    if (!pos) return fail("仓位不存在", 404);

    if (!pos.dex_id) {
      return fail("该仓位缺少 DEX 信息，无法获取 NPM 地址");
    }
    const dex = getDexe(pos.dex_id);
    if (!dex?.npm) {
      return fail("DEX 未配置 NPM 地址");
    }

    const chain = getChain(pos.chain_id_ref);
    if (!chain) return fail("链配置不存在");

    // 链上读 ownerOf + positions（实时校验 NFT 归属和流动性）
    const { client } = getClient(pos.chain_id_ref);
    let ownerOf = "";
    let realLiquidity = "0";
    try {
      const NPM_READ_ABI = [
        {
          name: "ownerOf",
          type: "function",
          stateMutability: "view",
          inputs: [{ name: "tokenId", type: "uint256" }],
          outputs: [{ name: "owner", type: "address" }],
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

      const [ownerRes, posData] = await Promise.all([
        client.readContract({
          address: dex.npm as `0x${string}`,
          abi: NPM_READ_ABI,
          functionName: "ownerOf",
          args: [BigInt(pos.token_id)],
        }),
        client
          .readContract({
            address: dex.npm as `0x${string}`,
            abi: NPM_READ_ABI,
            functionName: "positions",
            args: [BigInt(pos.token_id)],
          })
          .catch(() => null),
      ]);
      ownerOf = ownerRes as string;
      if (posData) {
        realLiquidity = (posData as any)[7].toString();
      } else {
        realLiquidity = pos.last_liquidity || "0";
      }
    } catch {
      ownerOf = "";
      realLiquidity = pos.last_liquidity || "0";
    }

    const pairFlip = pos.pair_flip === 1 || isPairFlipped(pos.chain_id_ref, pos.token0, pos.token1) ? 1 : 0;

    return ok({
      tokenId: pos.token_id,
      npm: dex.npm,
      dexName: dex.name || pos.dex_name || "",
      pool: pos.pool || "",
      chainIdRef: pos.chain_id_ref,
      pairFlip,
      stakerContract: pos.staker_contract || "",
      source: pos.source,
      liquidity: pos.last_liquidity || "0",
      realLiquidity,
      ownerOf,
      chain: {
        chainId: chain.chain_id,
        name: chain.name,
        rpcUrls: chain.rpc_urls,
        explorerUrl: chain.explorer_url,
        nativeSymbol: chain.symbol,
      },
    });
  } catch (e) {
    return fail(`获取移除参数失败：${(e as Error).message}`, 500);
  }
}

/**
 * POST: 前端完成链上移除仓位（collect 确认）后，立即将该仓位在本地 DB 中标记为 closed，
 * 无需等待后台定时器扫描，从而实现 UI 秒级刷新。
 */
export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare(
      `UPDATE positions
       SET notify_state = 'closed',
           last_liquidity = '0',
           last_in_range = 0,
           last_checked_at = ?
       WHERE id = ?`
    ).run(now, Number(params.id));
    return ok({ id: Number(params.id), closed: true });
  } catch (e) {
    return fail(`更新关闭状态失败：${(e as Error).message}`, 500);
  }
}
