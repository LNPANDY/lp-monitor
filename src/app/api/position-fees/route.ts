import { ok, fail, getBody } from "@/lib/api";
import {
  fetchAllActivePositionFees,
  invalidatePositionFeesCache,
  resetPositionFeeSince,
  syncPositionPnlNow,
} from "@/lib/monitor/position-fees";
import { saveManualCostBasis } from "@/lib/monitor/position-pnl";

export const dynamic = "force-dynamic";

/** 返回所有活跃仓位的精确链上未领手续费、ActiveL 占比、理论日产与真实收益成本台账。 */
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

/** 支持链上重查成本台账、手动校准开仓成本/已领手续费，以及重置计息起点。 */
export async function POST(req: Request) {
  const b = await getBody<{
    action?: string;
    positionId?: number;
    entryAmt0?: number;
    entryAmt1?: number;
    entryValueUsd?: number;
    claimedFees0?: number;
    claimedFees1?: number;
    claimedFeesUsd?: number;
    entryTimestamp?: number;
  }>(req).catch(() => ({} as any));

  const posId = Number(b.positionId);
  if (!Number.isFinite(posId) || posId <= 0) {
    return fail("缺少有效的 positionId", 400);
  }

  try {
    if (b.action === "reset_since") {
      resetPositionFeeSince(posId);
      const data = await fetchAllActivePositionFees({ force: true });
      return ok(data);
    }

    if (b.action === "sync_pnl") {
      await syncPositionPnlNow(posId);
      const data = await fetchAllActivePositionFees({ force: true });
      return ok(data);
    }

    if (b.action === "save_cost_basis") {
      saveManualCostBasis({
        positionId: posId,
        entryAmt0: Number(b.entryAmt0) || 0,
        entryAmt1: Number(b.entryAmt1) || 0,
        entryValueUsd: Number(b.entryValueUsd) || 0,
        claimedFees0: Number(b.claimedFees0) || 0,
        claimedFees1: Number(b.claimedFees1) || 0,
        claimedFeesUsd: b.claimedFeesUsd !== undefined ? Number(b.claimedFeesUsd) || 0 : undefined,
        entryTimestamp: b.entryTimestamp ? Number(b.entryTimestamp) : undefined,
      });
      invalidatePositionFeesCache();
      const data = await fetchAllActivePositionFees({ force: true });
      return ok(data);
    }

    return fail("不支持的操作", 400);
  } catch (e: any) {
    return fail(e?.message ?? "操作失败", 500);
  }
}
