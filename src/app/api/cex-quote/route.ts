import { ok, fail } from "@/lib/api";
import { fetchQuote, splitSymbol, getLiveCexSnapshot } from "@/lib/cex/binance";

export const dynamic = "force-dynamic";

/**
 * GET:
 *   1) ?all=1（或无 symbol 参数）：返回全局币安实时报价快照（含 24h 涨跌幅、tokenAddr 映射、延迟 ms），供顶栏与双指针雷达使用。
 *   2) ?symbol=0GUSDT：拉取单个币安交易对报价（配置页「测试报价」按钮用）。
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("symbol") ?? "").trim().toUpperCase();
  if (!raw || url.searchParams.get("all") === "1") {
    const snap = await getLiveCexSnapshot(url.searchParams.get("force") === "1");
    return ok(snap);
  }
  if (!/^[A-Z0-9]{2,20}$/.test(raw)) return fail("symbol 格式非法（应为如 0GUSDT 的大写字母数字）");

  const q = await fetchQuote(raw);
  if (!q) {
    return fail(`无法从币安获取 ${raw} 的报价：交易对可能不存在，或币安接口暂时不可达`, 400);
  }
  const { base, quote } = splitSymbol(q.symbol);
  return ok({ symbol: q.symbol, price: q.price, base, quote });
}

