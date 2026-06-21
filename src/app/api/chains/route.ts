import { getDb } from "@/lib/db";
import { invalidateClients } from "@/lib/chains";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = getDb().prepare("SELECT * FROM chains ORDER BY is_default DESC, name").all();
  return ok(rows.map(parseChain));
}

function parseChain(r: any) {
  let urls: string[] = [];
  try { urls = JSON.parse(r.rpc_urls); } catch { urls = r.rpc_urls ? [r.rpc_urls] : []; }
  return { ...r, rpc_urls: urls };
}

/** 添加自定义链。body: { key, name, chain_id, rpc_urls[], explorer_url, symbol } */
export async function POST(req: Request) {
  const b = await getBody<{
    key?: string; name?: string; chain_id?: number;
    rpc_urls?: string[] | string; explorer_url?: string; symbol?: string;
  }>(req);
  if (!b.key || !b.name || !b.chain_id) return fail("key/name/chain_id 必填");
  const urls = Array.isArray(b.rpc_urls) ? b.rpc_urls : (b.rpc_urls ? [b.rpc_urls] : []);
  const valid = urls.filter((u) => /^https?:\/\//.test(u));
  if (valid.length === 0) return fail("至少需要一个合法 http(s) RPC URL");
  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO chains (key, name, chain_id, rpc_urls, explorer_url, symbol, enabled, is_default)
       VALUES (?,?,?,?,?,?,1,0)`
    ).run(b.key.trim(), b.name.trim(), b.chain_id, JSON.stringify(valid), b.explorer_url?.trim() ?? "", b.symbol?.trim() || "ETH");
    invalidateClients();
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("key 或 chain_id 已存在", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
