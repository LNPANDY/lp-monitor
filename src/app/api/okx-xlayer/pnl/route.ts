import { ok, fail, getBody } from "@/lib/api";
import {
  addOkxLedgerEntry,
  deleteOkxLedgerEntry,
  fetchOkxXLayerPortfolioPnl,
  type OkxLedgerEntryType,
} from "@/lib/okx/xlayer-service";

export const dynamic = "force-dynamic";

const ALLOWED_TYPES = new Set<OkxLedgerEntryType>([
  "deposit",
  "withdraw",
  "rwa_buy_cost",
  "lp_fee_realized",
  "okx_bonus",
]);

/** 读取指定钱包在 X Layer 上的实时活跃 V3 仓位、钱包滞留 RWA/主流币余额及台账真实总收益汇总。 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const wallet = url.searchParams.get("wallet") || undefined;
  try {
    const data = await fetchOkxXLayerPortfolioPnl(wallet);
    return ok(data);
  } catch (e: any) {
    return fail(e?.message ?? "读取 X Layer 收益台账失败", 500);
  }
}

/** 新增一条资金/买 RWA 成本/已领 LP 手续费/OKX 奖励金流水记录。 */
export async function POST(req: Request) {
  const b = await getBody<{
    walletAddress?: string;
    entryType?: OkxLedgerEntryType;
    amountUsd?: number;
    poolName?: string;
    tokenId?: string;
    note?: string;
    occurredAt?: string;
  }>(req).catch(() => ({} as any));

  const wallet = (b.walletAddress || "").trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return fail("请填写有效的钱包地址（0x...）", 400);
  }
  if (!b.entryType || !ALLOWED_TYPES.has(b.entryType)) {
    return fail("无效的流水类型", 400);
  }
  const amt = Number(b.amountUsd);
  if (!Number.isFinite(amt) || amt <= 0) {
    return fail("金额必须大于 0", 400);
  }

  try {
    addOkxLedgerEntry({
      walletAddress: wallet,
      entryType: b.entryType,
      amountUsd: amt,
      poolName: b.poolName,
      tokenId: b.tokenId,
      note: b.note,
      occurredAt: b.occurredAt,
    });
    const data = await fetchOkxXLayerPortfolioPnl(wallet);
    return ok(data);
  } catch (e: any) {
    return fail(e?.message ?? "保存台账记录失败", 500);
  }
}

/** 删除一条台账流水记录。 */
export async function DELETE(req: Request) {
  const url = new URL(req.url);
  const id = Number(url.searchParams.get("id"));
  const wallet = url.searchParams.get("wallet") || undefined;
  if (!Number.isFinite(id) || id <= 0) {
    return fail("缺少有效的记录 id", 400);
  }
  try {
    deleteOkxLedgerEntry(id);
    const data = await fetchOkxXLayerPortfolioPnl(wallet);
    return ok(data);
  } catch (e: any) {
    return fail(e?.message ?? "删除记录失败", 500);
  }
}
