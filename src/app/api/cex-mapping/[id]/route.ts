import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** PATCH: 更新一条 CEX 匹配（cex_symbol / token_symbol / enabled / fixed_price / quote / inverted）。 */
export async function PATCH(req: Request, { params }: { params: { id: string } }) {
  const b = await getBody<{
    cex_symbol?: string;
    token_symbol?: string;
    enabled?: number;
    fixed_price?: number | null;
    quote?: string;
    inverted?: number | boolean;
  }>(req);
  const db = getDb();
  const sets: string[] = [];
  const args: any[] = [];
  if (b.cex_symbol !== undefined) {
    sets.push("cex_symbol=?");
    args.push(b.cex_symbol.toUpperCase());
  }
  if (b.token_symbol !== undefined) {
    sets.push("token_symbol=?");
    args.push(b.token_symbol.trim());
  }
  if (b.enabled !== undefined) {
    sets.push("enabled=?");
    args.push(b.enabled ? 1 : 0);
  }
  if (b.fixed_price !== undefined) {
    const fp = b.fixed_price !== null && b.fixed_price > 0 ? Number(b.fixed_price) : null;
    sets.push("fixed_price=?");
    args.push(fp);
  }
  if (b.quote !== undefined) {
    sets.push("quote=?");
    args.push((b.quote || "").trim().toUpperCase());
  }
  if (b.inverted !== undefined) {
    sets.push("inverted=?");
    args.push(b.inverted ? 1 : 0);
  }
  if (sets.length === 0) return fail("无更新字段");
  args.push(params.id);
  const r = db.prepare(`UPDATE token_symbols SET ${sets.join(", ")} WHERE id=?`).run(...args);
  if (r.changes === 0) return fail("未找到该匹配", 404);
  return ok({ updated: r.changes });
}

/** DELETE: 删除一条 CEX 匹配。 */
export async function DELETE(_req: Request, { params }: { params: { id: string } }) {
  const db = getDb();
  const r = db.prepare("DELETE FROM token_symbols WHERE id=?").run(params.id);
  if (r.changes === 0) return fail("未找到该匹配", 404);
  return ok({ deleted: r.changes });
}
