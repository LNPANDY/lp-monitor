import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{ name?: string; factory?: string; npm?: string; enabled?: number }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.name !== undefined) { sets.push("name=?"); args.push(b.name); }
  if (b.factory !== undefined) { sets.push("factory=?"); args.push(b.factory.toLowerCase()); }
  if (b.npm !== undefined) { sets.push("npm=?"); args.push(b.npm.toLowerCase()); }
  if (b.enabled !== undefined) { sets.push("enabled=?"); args.push(b.enabled ? 1 : 0); }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  db.prepare(`UPDATE dexes SET ${sets.join(", ")} WHERE id=?`).run(...args);
  return ok();
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  getDb().prepare("DELETE FROM dexes WHERE id=?").run(params.id);
  return ok();
}
