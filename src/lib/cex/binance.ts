/**
 * 币安（Binance）现货报价模块。
 *
 * 用途：扫描时按链上 token 地址查到用户配置的币安交易对（如 0G token → '0GUSDT'），
 * 拉取实时报价，与 DEX 池子里由 tick 推算的价格对比，价差超阈值即告警。
 *
 * 设计要点：
 *  - 一次扫描可能涉及很多 token，但它们映射出的币安 symbol 往往高度重复（同一计价币种），
 *    所以「去重 + 一次性批量拉取 + 进程内短期缓存」是关键，避免对币安接口打太多请求。
 *  - 币安没有按 symbol 数组批量取价的官方 REST，但 ticker/price 接口支持单 symbol，
 *    且 `exchangeInfo` 能列全部。这里采用「按需逐 symbol 取 /ticker/price?symbols=[...]」，
 *    该接口接受方括号包裹的数组查询参数，一次最多 1000 个，单次请求拿到多个报价。
 *  - 报价统一用「1 base = x quote」的含义（quote 为计价币种，通常 USDT/USDC/FDUSD 等）。
 *  - 失败不抛错，返回 null 让调用方降级（CEX 价缺失时跳过对比，不影响主流程）。
 *
 * 该模块不依赖 viem / better-sqlite3，纯网络 + DB 读取，方便单测与复用。
 */
import { getDb } from "../db";

/** 币安 REST 域名。国内访问不稳时可在 .env.local 里覆盖。 */
const BINANCE_HOST = process.env.BINANCE_HOST ?? "https://api.binance.com";

/** 报价缓存的存活时间。扫描间隔通常 ≥1 分钟，缓存 30s 足够跨 token 复用又不过期。 */
const CACHE_TTL_MS = 30_000;

/** 一条 token→CEX 报价的映射记录（对应 token_symbols 表）。 */
export interface CexMapping {
  chainIdRef: number;
  tokenAddr: string; // 小写
  cexSymbol: string; // 大写，如 '0GUSDT'。固定价时此字段仅用于展示，不查币安
  /** 固定价。非 null 时走固定价（如 USDC.e=1），不再查币安接口 */
  fixedPrice: number | null;
  /** 计价币种，如 'USDT'/'USDC'。固定价时必填；走币安时从 cex_symbol 推导（留空则自动切分） */
  quote: string;
}

/** 币安报价结果：1 base = price quote。 */
export interface CexQuote {
  symbol: string; // '0GUSDT'
  price: number; // 1 base = price quote
  /** 计价币种符号（从 symbol 中按已知稳定币集合切出），如 'USDT' / 'USDC' / 'FDUSD' / 'BTC' */
  quote: string;
  /** base 币种符号，如 '0G' / 'ETH' / 'WBTC' */
  base: string;
}

// ===== 进程内缓存：symbol → { quote, ts } =====
const _priceCache = new Map<string, { quote: CexQuote; ts: number }>();

// 已知币安计价币种（用于把 '0GUSDT' 切成 base='0G' / quote='USDT'）。
// 顺序无所谓，但优先匹配长的（如 USDC 优先于 USD —— 币安现货基本无 USD 计价，留作兜底）。
const KNOWN_QUOTES = ["USDT", "USDC", "FDUSD", "TUSD", "BUSD", "BTC", "ETH", "BNB", "EUR", "TRY", "BRL"];

/** 把 '0GUSDT' 切成 { base:'0G', quote:'USDT' }。切不出（无已知计价币种）时 quote 留空。 */
export function splitSymbol(symbol: string): { base: string; quote: string } {
  const up = symbol.toUpperCase();
  for (const q of KNOWN_QUOTES) {
    if (up.endsWith(q) && up.length > q.length) {
      return { base: up.slice(0, up.length - q.length), quote: q };
    }
  }
  return { base: up, quote: "" };
}

/**
 * 加载所有启用的 token→CEX 映射（按链分组返回，方便扫描时按 wallet.chain_id_ref 取）。
 * key = chainIdRef，value = 该链上 token_addr(小写) → CexMapping 列表。
 * 固定价（fixedPrice 非空）的映射也会加载，扫描时直接用固定价不查币安。
 */
export function loadAllMappings(): Map<number, CexMapping[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chain_id_ref, token_addr, cex_symbol, fixed_price, quote
       FROM token_symbols WHERE enabled=1`
    )
    .all() as {
      chain_id_ref: number;
      token_addr: string;
      cex_symbol: string;
      fixed_price: number | null;
      quote: string;
    }[];
  const out = new Map<number, CexMapping[]>();
  for (const r of rows) {
    const arr = out.get(r.chain_id_ref) ?? [];
    arr.push({
      chainIdRef: r.chain_id_ref,
      tokenAddr: r.token_addr.toLowerCase(),
      cexSymbol: r.cex_symbol.toUpperCase(),
      fixedPrice: r.fixed_price !== null ? r.fixed_price : null,
      quote: (r.quote || "").toUpperCase(),
    });
    out.set(r.chain_id_ref, arr);
  }
  return out;
}

/**
 * 批量获取多个币安 symbol 的当前报价（去重 + 进程内缓存 + 单次 REST）。
 *
 * @param symbols 大写 symbol 数组，如 ['0GUSDT','WETHUSDT','WETHUSDT']（重复会被去重）
 * @returns symbol → CexQuote。拉取失败的 symbol 不会出现在结果里。
 */
export async function fetchQuotes(symbols: string[]): Promise<Map<string, CexQuote>> {
  const out = new Map<string, CexQuote>();
  // 去重 + 大写
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  if (uniq.length === 0) return out;

  const now = Date.now();
  const todo: string[] = [];
  for (const s of uniq) {
    const hit = _priceCache.get(s);
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      out.set(s, hit.quote);
    } else {
      todo.push(s);
    }
  }
  if (todo.length === 0) return out;

  // 币安 /api/v3/ticker/price 支持 symbols=[...] 数组查询（URL 里是方括号包裹的 JSON 字符串数组）。
  // 一次请求拿回多个 symbol 的最新成交价。失败则整体降级（逐个重试成本高，直接放弃本次报价）。
  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(todo));
    const url = `${BINANCE_HOST}/api/v3/ticker/price?symbols=${symbolsParam}`;
    const resp = await fetch(url, { headers: { Accept: "application/json" } });
    if (!resp.ok) throw new Error(`binance status ${resp.status}`);
    const data = (await resp.json()) as Array<{ symbol: string; price: string }>;
    for (const item of data) {
      const price = Number(item.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const { base, quote } = splitSymbol(item.symbol);
      const q: CexQuote = { symbol: item.symbol.toUpperCase(), price, base, quote };
      out.set(q.symbol, q);
      _priceCache.set(q.symbol, { quote: q, ts: now });
    }
  } catch {
    // 整批失败：保持缓存不动，本次没拿到的 symbol 在 out 里就不存在，调用方降级跳过。
  }

  return out;
}

/** 单 symbol 快捷取价（带缓存）。扫描器内部一般用 fetchQuotes 批量，此函数便于复用/调试。 */
export async function fetchQuote(symbol: string): Promise<CexQuote | null> {
  const m = await fetchQuotes([symbol]);
  return m.get(symbol.toUpperCase()) ?? null;
}

/**
 * 按一条链的映射构造 token_addr(小写) → CexQuote。
 * 固定价映射（fixedPrice 非空）直接构造报价，不查币安；币安映射批量去拉。
 * 用于扫描器：一次性拿到本链所有 token 的报价，无需区分固定/币安来源。
 */
export async function buildQuotesByAddr(mappings: CexMapping[]): Promise<Map<string, CexQuote>> {
  const out = new Map<string, CexQuote>();
  // 1) 固定价：直接构造，base 取 token_symbol（映射里没存，用 cex_symbol 切分兜底），quote 用 quote 字段
  const binanceSymbols = new Set<string>();
  for (const m of mappings) {
    if (m.fixedPrice !== null && Number.isFinite(m.fixedPrice) && m.fixedPrice > 0) {
      const { base } = splitSymbol(m.cexSymbol);
      const q: CexQuote = {
        symbol: m.cexSymbol, // 展示用
        price: m.fixedPrice,
        base,
        quote: m.quote || "USD",
      };
      out.set(m.tokenAddr, q);
    } else {
      if (m.cexSymbol) binanceSymbols.add(m.cexSymbol);
    }
  }
  // 2) 币安映射：批量拉价，回填到 byAddr
  if (binanceSymbols.size > 0) {
    const fresh = await fetchQuotes([...binanceSymbols]);
    for (const m of mappings) {
      if (m.fixedPrice !== null) continue;
      const q = fresh.get(m.cexSymbol);
      if (q) out.set(m.tokenAddr, q);
    }
  }
  return out;
}

/** 清空报价缓存（配置变更/测试时调用）。 */
export function invalidateQuoteCache() {
  _priceCache.clear();
}
