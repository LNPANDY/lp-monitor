import { getDb } from "@/lib/db";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * GET: 列出 CEX 报价匹配。
 *  - ?chain_id=N  按链过滤
 *  - 不带参数     返回全部
 * 关联 chains 表带出链名。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const chainId = url.searchParams.get("chain_id");
  const db = getDb();
  let sql =
    "SELECT t.*, c.name AS chain_name, c.key AS chain_key " +
    "FROM token_symbols t JOIN chains c ON c.id=t.chain_id_ref WHERE 1=1";
  const args: any[] = [];
  if (chainId) {
    sql += " AND t.chain_id_ref=?";
    args.push(chainId);
  }
  sql += " ORDER BY t.created_at DESC";
  return ok(db.prepare(sql).all(...args));
}

/**
 * POST: 新增一条 CEX 报价匹配。
 * body: { chain_id, token_addr, token_symbol?, cex_symbol, fixed_price?, quote?, inverted? }
 *  - token_addr: 链上 token 合约地址
 *  - cex_symbol: 币安交易对 symbol，如 '0GUSDT'（走币安时必填）；固定价时仅展示用
 *  - fixed_price: 固定价（如 USDC.e 填 1）。非空时走固定价，不查币安
 *  - quote: 计价币种，如 'USDT'/'USDC'（固定价时必填；走币安时从 cex_symbol 自动推导）
 *  - token_symbol: 可选，缓存的 ERC20 symbol（展示用，可留空）
 *  - inverted: 翻转（0/1）。币安没有反向交易对时用，如 USDT 配 USDCUSDT 并翻转
 */
export async function POST(req: Request) {
  const b = await getBody<{
    chain_id?: number;
    token_addr?: string;
    token_symbol?: string;
    cex_symbol?: string;
    fixed_price?: number | null;
    quote?: string;
    inverted?: number | boolean;
  }>(req);
  if (!b.chain_id || !b.token_addr) return fail("chain_id/token_addr 必填");
  const rawAddr = b.token_addr.trim();
  // __native__ 代表该链的原生 GAS 代币（无合约地址）；其余必须是合法 0x 地址
  const isNative = rawAddr === "__native__";
  if (!isNative && !/^0x[a-fA-F0-9]{40}$/.test(rawAddr)) return fail("token_addr 地址非法");

  const fixedPrice = b.fixed_price !== null && b.fixed_price !== undefined && b.fixed_price > 0
    ? Number(b.fixed_price) : null;
  const quote = (b.quote || "").trim().toUpperCase();
  const cexSymbol = (b.cex_symbol || "").trim().toUpperCase();
  const inverted = b.inverted ? 1 : 0;

  // 固定价模式：不需要 cex_symbol，但需要 quote
  if (fixedPrice !== null && !quote) return fail("固定价模式需同时填写计价币种（如 USDT）");
  // 币安模式：需要 cex_symbol
  if (fixedPrice === null && !cexSymbol) return fail("币安模式需填写 cex_symbol（如 0GUSDT）");
  if (fixedPrice === null && !/^[A-Z0-9]{2,20}$/.test(cexSymbol)) return fail("cex_symbol 格式非法");

  // GAS 代币：token_symbol 缺失时自动取该链的 symbol（如 ETH/0G/BNB）
  let tokenSymbol = b.token_symbol?.trim() ?? "";
  if (isNative && !tokenSymbol) {
    const chain = getDb().prepare("SELECT symbol FROM chains WHERE id=?").get(b.chain_id) as { symbol?: string } | undefined;
    tokenSymbol = chain?.symbol ?? "";
  }

  const db = getDb();
  try {
    const info = db.prepare(
      `INSERT INTO token_symbols (chain_id_ref, token_addr, token_symbol, cex_symbol, fixed_price, quote, inverted, enabled)
       VALUES (?,?,?,?,?,?,?,1)`
    ).run(
      b.chain_id,
      isNative ? "__native__" : rawAddr.toLowerCase(),
      tokenSymbol,
      cexSymbol,
      fixedPrice,
      quote,
      inverted
    );
    return ok({ id: info.lastInsertRowid });
  } catch (e: any) {
    if (String(e?.message).includes("UNIQUE")) return fail("该链上已存在此 token 的匹配", 409);
    return fail(e?.message ?? "insert failed", 500);
  }
}
