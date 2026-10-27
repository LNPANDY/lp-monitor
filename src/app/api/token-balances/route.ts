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

  // 读每个代币的 decimals（格式化余额用；原生币 18）
  const TOKEN_META_ABI = [
    { name: "decimals", type: "function", stateMutability: "view", inputs: [], outputs: [{ name: "", type: "uint8" }] },
  ] as const;

  try {
    const balances = await Promise.all(
      b.tokens.map(async (raw) => {
        const addr = (raw ?? "").trim().toLowerCase();
        // 读一次，失败重试一次（公共 RPC 并发限流时偶发失败，重试通常成功）
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            if (addr === "__native__") {
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
          } catch (e) {
            if (attempt === 1) return "0"; // 两次都失败才放弃
            await new Promise((r) => setTimeout(r, 400));
          }
        }
        return "0";
      })
    );
    // 并发读 decimals（失败回退 18）
    const decimals = await Promise.all(
      b.tokens.map(async (raw) => {
        const addr = (raw ?? "").trim().toLowerCase();
        if (addr === "__native__") return 18;
        try {
          const d = await client.readContract({
            address: addr as `0x${string}`,
            abi: TOKEN_META_ABI,
            functionName: "decimals",
          }) as number;
          return Number(d);
        } catch { return 18; }
      })
    );
    return ok({ balances, decimals });
  } catch (e: any) {
    return fail(`余额查询失败：${String(e?.message ?? e).slice(0, 150)}`, 502);
  }
}
