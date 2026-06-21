import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{ platform?: string; pair_label?: string; contract?: string; read_type?: string; enabled?: number }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.platform !== undefined) { sets.push("platform=?"); args.push(b.platform); }
  if (b.pair_label !== undefined) { sets.push("pair_label=?"); args.push(b.pair_label); }
  if (b.contract !== undefined) { sets.push("contract=?"); args.push(b.contract.toLowerCase()); }
  if (b.read_type !== undefined) { sets.push("read_type=?"); args.push(b.read_type); }
  if (b.enabled !== undefined) { sets.push("enabled=?"); args.push(b.enabled ? 1 : 0); }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  db.prepare(`UPDATE staking_contracts SET ${sets.join(", ")} WHERE id=?`).run(...args);
  return ok();
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  getDb().prepare("DELETE FROM staking_contracts WHERE id=?").run(params.id);
  return ok();
}
