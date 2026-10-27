/**
 * 批量查询钱包代币余额（轻量，供兑换面板选 token 后显示）。
 *
 * 入参：{ chain_id, wallet, tokens: string[] }
 *   tokens 里可以是合约地址或 '__native__'（原生币，用 getBalance）。
 *
 * 返回：{ balances: string[] } —— 与 tokens 顺序一致的 raw 余额字符串。
 */
import { getClient } from "@/lib/chains";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "", type: "uint256" }] },
] as const;

export async function POST(req: Request) {
  const b = await getBody<{ chain_id?: number; wallet?: string; tokens?: string[] }>(req);
  if (!b.chain_id || !b.wallet || !Array.isArray(b.tokens) || b.tokens.length === 0) {
    return fail("chain_id/wallet/tokens 必填");
  }
  if (!/^0x[a-fA-F0-9]{40}$/.test(b.wallet)) return fail("wallet 地址非法");
  if (b.tokens.length > 20) return fail("tokens 最多 20 个");

  const { client } = getClient(b.chain_id);
  const wallet = b.wallet as `0x${string}`;

  try {
    const balances = await Promise.all(
      b.tokens.map(async (raw) => {
        const addr = (raw ?? "").trim().toLowerCase();
        try {
          if (addr === "__native__") {
            // 原生币余额
            const v = await client.getBalance({ address: wallet });
            return v.toString();
          }
          if (!/^0x[a-f0-9]{40}$/.test(addr)) return "0";
          const v = await client.readContract({
            address: addr as `0x${string}`,
            abi: ERC20_BALANCE_ABI,
            functionName: "balanceOf",
            args: [wallet],
          }) as bigint;
          return v.toString();
        } catch {
          return "0";
        }
      })
    );
    return ok({ balances });
  } catch (e: any) {
    return fail(`余额查询失败：${String(e?.message ?? e).slice(0, 150)}`, 502);
  }
}
