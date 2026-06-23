import { ok, fail } from "@/lib/api";
import { fetchQuote, splitSymbol } from "@/lib/cex/binance";

export const dynamic = "force-dynamic";

/**
 * GET: 实时拉取某个币安交易对的最新报价（配置页「测试报价」按钮用）。
 *   ?symbol=0GUSDT
 *
 * 返回：{ symbol, price, base, quote }
 * 失败（symbol 不存在 / 币安不可达）返回 400 + 错误信息。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!raw) return fail("缺少 symbol 参数");
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) return fail("symbol 格式非法（应为如 0GUSDT 的大写字母数字）");

  const q = await fetchQuote(raw);
  if (!q) {
    return fail(`无法从币安获取 ${raw} 的报价：交易对可能不存在，或币安接口暂时不可达`, 400);
  }
  const { base, quote } = splitSymbol(q.symbol);
  return ok({ symbol: q.symbol, price: q.price, base, quote });
}
