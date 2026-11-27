import { ok, fail } from "@/lib/api";
import { fetchOkxXLayerPoolsSnapshot } from "@/lib/okx/xlayer-service";

export const dynamic = "force-dynamic";

/** 返回全部 51 个 OKX X-Liquidity V3 池的实时链上状态、有效集中度、8% 等价深度与推荐资金区间。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  try {
    const data = await fetchOkxXLayerPoolsSnapshot({ force });
    return ok(data);
  } catch (e: any) {
    return fail(e?.message ?? "拉取 X Layer OKX 池子数据失败", 500);
  }
}
