import { ok, fail, getBody } from "@/lib/api";
import {
  fetchAllActivePositionFees,
  resetPositionFeeSince,
} from "@/lib/monitor/position-fees";

export const dynamic = "force-dynamic";

/** 返回所有活跃仓位的精确链上未领手续费、ActiveL 占比与理论日产。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const force = url.searchParams.get("force") === "1";
  try {
    const data = await fetchAllActivePositionFees({ force });
    return ok(data);
  } catch (e: any) {
    return fail(e?.message ?? "读取仓位手续费失败", 500);
  }
}

/** 支持手动重置某仓位的已实现手续费计息起点（领完手续费后点一次即可）。 */
export async function POST(req: Request) {
  const b = await getBody<{ action?: string; positionId?: number }>(req).catch(() => ({} as any));
  if (b.action === "reset_since" && typeof b.positionId === "number" && b.positionId > 0) {
    resetPositionFeeSince(b.positionId);
    const data = await fetchAllActivePositionFees({ force: true });
    return ok(data);
  }
  return fail("不支持的操作", 400);
}
