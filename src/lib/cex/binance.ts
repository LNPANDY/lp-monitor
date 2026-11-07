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

/** 币安 REST 域名列表：优先使用官方无地域限制的纯行情加速节点 data-api.binance.vision（避免美区/云主机 HTTP 451），自动故障转移。 */
const BINANCE_HOSTS = process.env.BINANCE_HOST
  ? [process.env.BINANCE_HOST, "https://data-api.binance.vision", "https://api.binance.com"]
  : ["https://data-api.binance.vision", "https://api.binance.com", "https://api1.binance.com"];

let _preferredHostIdx = 0;
let _lastLatencyMs = 0;
let _lastHostUsed = BINANCE_HOSTS[0];

/** 报价缓存的存活时间。常规后台扫描缓存 15s；实时行情接口传 skipCache=true 或短缓存。 */
const CACHE_TTL_MS = 15_000;

/** 一条 token→CEX 报价的映射记录（对应 token_symbols 表）。 */
export interface CexMapping {
  chainIdRef: number;
  tokenAddr: string; // 小写
  tokenSymbol?: string; // 链上代币符号，如 'W0G' / 'USDC.e'
  cexSymbol: string; // 大写，如 '0GUSDT'。固定价时此字段仅用于展示，不查币安
  /** 固定价。非 null 时走固定价（如 USDC.e=1），不再查币安接口 */
  fixedPrice: number | null;
  /** 计价币种，如 'USDT'/'USDC'。固定价时必填；走币安时从 cex_symbol 推导（留空则自动切分） */
  quote: string;
  /** 翻转：true 时对币安报价取倒数并交换 base/quote。 */
  inverted: boolean;
}

/** 币安报价结果：1 base = price quote。 */
export interface CexQuote {
  symbol: string; // '0GUSDT'
  price: number; // 1 base = price quote
  /** 计价币种符号（从 symbol 中按已知稳定币集合切出），如 'USDT' / 'USDC' / 'FDUSD' / 'BTC' */
  quote: string;
  /** base 币种符号，如 '0G' / 'ETH' / 'WBTC' */
  base: string;
  /** 24 小时涨跌幅百分比（如 -1.24 表示 -1.24%），可选 */
  change24hPct?: number;
}

// ===== 进程内缓存：symbol → { quote, ts } =====
const _priceCache = new Map<string, { quote: CexQuote; ts: number }>();
const _change24hCache = new Map<string, { pct: number; ts: number }>();

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
 */
export function loadAllMappings(): Map<number, CexMapping[]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT chain_id_ref, token_addr, token_symbol, cex_symbol, fixed_price, quote, inverted
       FROM token_symbols WHERE enabled=1`
    )
    .all() as {
      chain_id_ref: number;
      token_addr: string;
      token_symbol?: string;
      cex_symbol: string;
      fixed_price: number | null;
      quote: string;
      inverted: number;
    }[];
  const out = new Map<number, CexMapping[]>();
  for (const r of rows) {
    const arr = out.get(r.chain_id_ref) ?? [];
    arr.push({
      chainIdRef: r.chain_id_ref,
      tokenAddr: r.token_addr.toLowerCase(),
      tokenSymbol: r.token_symbol || "",
      cexSymbol: (r.cex_symbol || "").toUpperCase(),
      fixedPrice: r.fixed_price !== null ? r.fixed_price : null,
      quote: (r.quote || "").toUpperCase(),
      inverted: r.inverted === 1,
    });
    out.set(r.chain_id_ref, arr);
  }
  return out;
}

/**
 * 内部辅助：带多节点自动故障转移的币安请求
 */
async function fetchFromBinanceHosts(pathAndQuery: string, timeoutMs = 3500): Promise<any | null> {
  for (let attempt = 0; attempt < BINANCE_HOSTS.length; attempt++) {
    const idx = (_preferredHostIdx + attempt) % BINANCE_HOSTS.length;
    const host = BINANCE_HOSTS[idx];
    const t0 = Date.now();
    try {
      const resp = await fetch(`${host}${pathAndQuery}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      _preferredHostIdx = idx;
      _lastLatencyMs = Date.now() - t0;
      _lastHostUsed = host;
      return data;
    } catch {
      // 切下一个备用域名
    }
  }
  return null;
}

/**
 * 批量获取多个币安 symbol 的当前报价（去重 + 进程内缓存 + 单次 REST + 自动节点切换）。
 */
export async function fetchQuotes(symbols: string[], skipCache = false): Promise<Map<string, CexQuote>> {
  const out = new Map<string, CexQuote>();
  const uniq = [...new Set(symbols.map((s) => s.toUpperCase()))].filter(Boolean);
  if (uniq.length === 0) return out;

  const now = Date.now();
  const todo: string[] = [];
  for (const s of uniq) {
    if (skipCache) {
      todo.push(s);
      continue;
    }
    const hit = _priceCache.get(s);
    if (hit && now - hit.ts < CACHE_TTL_MS) {
      out.set(s, hit.quote);
    } else {
      todo.push(s);
    }
  }
  if (todo.length === 0) return out;

  try {
    const symbolsParam = encodeURIComponent(JSON.stringify(todo));
    const data = (await fetchFromBinanceHosts(`/api/v3/ticker/price?symbols=${symbolsParam}`)) as Array<{
      symbol: string;
      price: string;
    }> | null;
    if (Array.isArray(data)) {
      for (const item of data) {
        const price = Number(item.price);
        if (!Number.isFinite(price) || price <= 0) continue;
        const { base, quote } = splitSymbol(item.symbol);
        const chg = _change24hCache.get(item.symbol.toUpperCase())?.pct;
        const q: CexQuote = {
          symbol: item.symbol.toUpperCase(),
          price,
          base,
          quote,
          ...(chg !== undefined ? { change24hPct: chg } : {}),
        };
        out.set(q.symbol, q);
        _priceCache.set(q.symbol, { quote: q, ts: now });
      }
    } else {
      // 若整批缓存过期但本次网络抖动，降级返回旧缓存值避免前端闪烁空白
      for (const s of todo) {
        const stale = _priceCache.get(s);
        if (stale) out.set(s, stale.quote);
      }
    }
  } catch {
    for (const s of todo) {
      const stale = _priceCache.get(s);
      if (stale) out.set(s, stale.quote);
    }
  }

  return out;
}

/** 单 symbol 快捷取价（带缓存）。 */
export async function fetchQuote(symbol: string): Promise<CexQuote | null> {
  const m = await fetchQuotes([symbol]);
  return m.get(symbol.toUpperCase()) ?? null;
}

/**
 * 按一条链的映射构造 token_addr(小写) → CexQuote。
 * 修复：当固定价映射（如 USDC.e fixedPrice=1）未填 cexSymbol 时，自动回退为 quote 或 tokenSymbol（如 'USDC'），
 * 彻底解决前端出现 `(0GUSDC/)` 残缺括号及仓位卡片漏显示 `CEX 汇率` 行的问题。
 */
export async function buildQuotesByAddr(mappings: CexMapping[], skipCache = false): Promise<Map<string, CexQuote>> {
  const out = new Map<string, CexQuote>();
  const binanceSymbols = new Set<string>();
  for (const m of mappings) {
    if (m.fixedPrice !== null && Number.isFinite(m.fixedPrice) && m.fixedPrice > 0) {
      const fallbackSym = m.cexSymbol || m.quote || m.tokenSymbol || "USDC";
      const { base } = splitSymbol(fallbackSym);
      const q: CexQuote = {
        symbol: fallbackSym,
        price: m.fixedPrice,
        base: base || m.tokenSymbol || "USDC",
        quote: m.quote || "USD",
        change24hPct: 0,
      };
      out.set(m.tokenAddr, q);
    } else {
      if (m.cexSymbol) binanceSymbols.add(m.cexSymbol);
    }
  }
  if (binanceSymbols.size > 0) {
    const fresh = await fetchQuotes([...binanceSymbols], skipCache);
    for (const m of mappings) {
      if (m.fixedPrice !== null) continue;
      const q = fresh.get(m.cexSymbol);
      if (!q) continue;
      if (m.inverted) {
        out.set(m.tokenAddr, {
          symbol: q.symbol,
          price: 1 / q.price,
          base: q.quote,
          quote: q.base,
          ...(q.change24hPct !== undefined ? { change24hPct: -q.change24hPct } : {}),
        });
      } else {
        out.set(m.tokenAddr, q);
      }
    }
  }
  return out;
}

/**
 * 获取全局实时 CEX 快照（含 24h 涨跌幅、各链 tokenAddr 报价映射、REST 延迟统计），
 * 供前端顶栏实时行情条首屏渲染及 WebSocket 断线兜底使用。
 */
let _lastSnapshotTs = 0;
let _lastSnapshotData: any = null;

export async function getLiveCexSnapshot(force = false) {
  const now = Date.now();
  if (!force && _lastSnapshotData && now - _lastSnapshotTs < 2_000) {
    return _lastSnapshotData;
  }

  const allByChain = loadAllMappings();
  const mappingsList: CexMapping[] = [];
  const symbolsSet = new Set<string>(["0GUSDT", "ETHUSDT", "BTCUSDT", "SOLUSDT", "LINKUSDT"]);
  for (const [, arr] of allByChain) {
    for (const m of arr) {
      mappingsList.push(m);
      if (m.fixedPrice === null && m.cexSymbol) {
        symbolsSet.add(m.cexSymbol.toUpperCase());
      }
    }
  }

  const symbols = [...symbolsSet];
  // 若距离上次 24hr 涨跌幅拉取已满 15s，则用 /api/v3/ticker/24hr?symbols=[...] 同时更新最新价与 24h 涨跌幅
  const need24hr = symbols.some((s) => {
    const c = _change24hCache.get(s);
    return !c || now - c.ts > 15_000;
  });

  if (need24hr && symbols.length > 0) {
    const param = encodeURIComponent(JSON.stringify(symbols));
    const data24 = (await fetchFromBinanceHosts(
      `/api/v3/ticker/24hr?symbols=${param}&type=MINI`,
      3500
    )) as Array<{
      symbol: string;
      lastPrice: string;
      openPrice: string;
    }> | null;
    if (Array.isArray(data24)) {
      for (const item of data24) {
        const sym = item.symbol.toUpperCase();
        const close = Number(item.lastPrice);
        const open = Number(item.openPrice);
        if (!Number.isFinite(close) || close <= 0) continue;
        const pct = open > 0 ? ((close - open) / open) * 100 : 0;
        _change24hCache.set(sym, { pct, ts: now });
        const { base, quote } = splitSymbol(sym);
        const q: CexQuote = { symbol: sym, price: close, base, quote, change24hPct: pct };
        _priceCache.set(sym, { quote: q, ts: now });
      }
    } else {
      await fetchQuotes(symbols, true);
    }
  } else {
    await fetchQuotes(symbols, true);
  }

  const quotesBySymbol: Record<string, CexQuote> = {};
  for (const s of symbols) {
    const hit = _priceCache.get(s);
    if (hit) quotesBySymbol[s] = hit.quote;
  }

  const quotesByChainAddr: Record<string, CexQuote> = {};
  for (const [chainId, arr] of allByChain) {
    const byAddr = await buildQuotesByAddr(arr, false);
    for (const [addr, q] of byAddr) {
      quotesByChainAddr[`${chainId}:${addr.toLowerCase()}`] = q;
      quotesByChainAddr[addr.toLowerCase()] = q;
    }
  }

  _lastSnapshotTs = now;
  _lastSnapshotData = {
    updatedAt: new Date(now).toISOString(),
    latencyMs: _lastLatencyMs,
    host: _lastHostUsed,
    quotesBySymbol,
    quotesByChainAddr,
    mappings: mappingsList,
  };
  return _lastSnapshotData;
}

/** 清空报价缓存（配置变更/测试时调用）。 */
export function invalidateQuoteCache() {
  _priceCache.clear();
  _change24hCache.clear();
  _lastSnapshotData = null;
}

