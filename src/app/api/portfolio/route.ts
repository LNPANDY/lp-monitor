import { ok, fail } from "@/lib/api";
import { getChain } from "@/lib/chains";
import { computePortfolio } from "@/lib/wallet/portfolio";

export const dynamic = "force-dynamic";

/**
 * GET /api/portfolio?chain_id=N&address=0x...
 * 实时统计指定钱包在某条链上的资产组合（GAS 余额 + 直接持有的 LP）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = Number(url.searchParams.get("chain_id") ?? 0);
  const address = (url.searchParams.get("address") ?? "").trim();

  if (!chainId) return fail("chain_id 必填");
  const chain = getChain(chainId);
  if (!chain) return fail("链不存在");
  if (!chain.enabled) return fail("该链已禁用");
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return fail("address 格式非法");

  try {
    const result = await computePortfolio(chainId, address);
    return ok(result);
  } catch (e: any) {
    return fail(e?.message ?? "统计失败", 500);
  }
}
