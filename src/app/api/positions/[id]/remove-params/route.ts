import { getDb } from "@/lib/db";
import { ok, fail } from "@/lib/api";
import { getClient, getChain } from "@/lib/chains";
import { getDexe } from "@/lib/chains/dexes";

export const dynamic = "force-dynamic";

/**
 * GET: 返回移除仓位所需的全部链上参数（前端构造写交易用）。
 *
 * 前端拿到这些后：
 *   - chainId / chainParams：用于 wallet_switchEthereumChain
 *   - npm：Step2 multicall 调用目标
 *   - liquidity：decreaseLiquidity 的全量参数
 *   - ownerOf：当前 NFT 实际 owner（前端校验连接的钱包是否匹配）
 *
 * @param id positions 主键
 */
export async function GET(_req: Request, { params }: { params: { id: string } }) {
  try {
    const db = getDb();
    const pos = db.prepare("SELECT * FROM positions WHERE id=?").get(params.id) as
      | {
          id: number;
          chain_id_ref: number;
          dex_id: number | null;
          token_id: string;
          source: string;
          staker_contract: string;
          pool: string;
          last_liquidity: string;
        }
      | undefined;

    if (!pos) return fail("仓位不存在", 404);

    // 取 NPM 地址（dex_id → dexes.npm）
    if (!pos.dex_id) {
      console.error(`Position ${pos.id} has null dex_id`, pos);
      return fail("该仓位缺少 DEX 信息，无法获取 NPM 地址");
    }
    const dex = getDexe(pos.dex_id);
    if (!dex?.npm) {
      console.error(`DEX ${pos.dex_id} has no NPM address`, dex);
      return fail("DEX 未配置 NPM 地址");
    }

    // 取链配置（EVM chainId + RPC，用于前端切链/添加链）
    const chain = getChain(pos.chain_id_ref);
    if (!chain) return fail("链配置不存在");

    // 链上读 ownerOf（实时校验 NFT 归属）
    const { client } = getClient(pos.chain_id_ref);
    let ownerOf = "";
    try {
      console.log(`Querying ownerOf for token ${pos.token_id} from ${dex.npm}`);
      ownerOf = (await client.readContract({
        address: dex.npm as `0x${string}`,
        abi: [
          {
            name: "ownerOf",
            type: "function",
            stateMutability: "view",
            inputs: [{ name: "tokenId", type: "uint256" }],
            outputs: [{ name: "owner", type: "address" }],
          },
        ],
        functionName: "ownerOf",
        args: [BigInt(pos.token_id)],
      })) as string;
      console.log(`ownerOf result: ${ownerOf}`);
    } catch (error) {
      console.error(`Failed to query ownerOf for token ${pos.token_id}:`, error);
      // NFT 可能已不存在（已 burn/转移），ownerOf 留空，前端按「无法移除」处理
      ownerOf = "";
    }

    return ok({
      tokenId: pos.token_id,
      npm: dex.npm,
      stakerContract: pos.staker_contract || "",
      source: pos.source,
      liquidity: pos.last_liquidity || "0",
      ownerOf,
      chain: {
        chainId: chain.chain_id, // EVM chainId
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
