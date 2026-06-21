import { getDb } from "@/lib/db";
import { invalidateClients } from "@/lib/chains";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{ name?: string; rpc_urls?: string[] | string; explorer_url?: string; symbol?: string; enabled?: number }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.name !== undefined) { sets.push("name=?"); args.push(b.name); }
  if (b.explorer_url !== undefined) { sets.push("explorer_url=?"); args.push(b.explorer_url); }
  if (b.symbol !== undefined) { sets.push("symbol=?"); args.push(b.symbol); }
  if (b.enabled !== undefined) { sets.push("enabled=?"); args.push(b.enabled ? 1 : 0); }
  if (b.rpc_urls !== undefined) {
    const urls = Array.isArray(b.rpc_urls) ? b.rpc_urls : [b.rpc_urls];
    const valid = urls.filter((u) => /^https?:\/\//.test(u));
    if (valid.length === 0) return fail("至少需要一个合法 RPC URL");
    sets.push("rpc_urls=?"); args.push(JSON.stringify(valid));
  }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  db.prepare(`UPDATE chains SET ${sets.join(", ")} WHERE id=?`).run(...args);
  invalidateClients();
  return ok();
}

export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const chain = db.prepare("SELECT is_default FROM chains WHERE id=?").get(params.id) as any;
  if (chain?.is_default) return fail("内置默认链不可删除", 400);
  db.prepare("DELETE FROM chains WHERE id=?").run(params.id);
  invalidateClients();
  return ok();
}
