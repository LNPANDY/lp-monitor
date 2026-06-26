import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 更新收藏（label / staker / npm / sort_order 任一）。 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{ label?: string; pool?: string; staker?: string; npm?: string; sort_order?: number }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.label !== undefined) { sets.push("label=?"); args.push(String(b.label).trim()); }
  if (b.pool !== undefined) { sets.push("pool_addr=?"); args.push(String(b.pool).trim().toLowerCase()); }
  if (b.staker !== undefined) { sets.push("staker_addr=?"); args.push(String(b.staker).trim().toLowerCase()); }
  if (b.npm !== undefined) { sets.push("npm_addr=?"); args.push(String(b.npm).trim().toLowerCase()); }
  if (b.sort_order !== undefined) { sets.push("sort_order=?"); args.push(Number(b.sort_order) || 0); }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  db.prepare(`UPDATE liquidity_favorites SET ${sets.join(", ")} WHERE id=?`).run(...args);
  return ok();
}

/** 删除收藏。 */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  getDb().prepare("DELETE FROM liquidity_favorites WHERE id=?").run(params.id);
  return ok();
}
