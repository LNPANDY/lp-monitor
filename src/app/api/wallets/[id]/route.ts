import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{ label?: string; enabled?: number }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.label !== undefined) { sets.push("label=?"); args.push(b.label); }
  if (b.enabled !== undefined) { sets.push("enabled=?"); args.push(b.enabled ? 1 : 0); }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  db.prepare(`UPDATE wallets SET ${sets.join(", ")} WHERE id=?`).run(...args);
  return ok();
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  db.prepare("DELETE FROM wallets WHERE id=?").run(params.id);
  return ok();
}
