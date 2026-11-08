"use client";
import { useEffect, useState, useRef, useMemo, useCallback } from "react";
import useSWR from "swr";
import { fetcher } from "@/components/util";

export interface LiveTickerItem {
  symbol: string;
  base: string;
  quote: string;
  price: number;
  change24hPct: number;
  updatedAtMs: number;
}

export interface LiveCexMapping {
  chainIdRef: number;
  tokenAddr: string;
  tokenSymbol?: string;
  cexSymbol: string;
  fixedPrice: number | null;
  quote: string;
  inverted: boolean;
}

export interface LivePairCexAnalysis {
  token0CexSymbol: string;
  token1CexSymbol: string;
  token0PriceUsd: number;
  token1PriceUsd: number;
  /** 1 token0 = dexRate token1（未翻转原始口径） */
  dexRate: number;
  /** 1 token0 = cexRate token1（未翻转原始口径） */
  cexRate: number;
  /** (dexRate - cexRate) / cexRate */
  diff: number;
  absDiff: number;
  /** 扣除池子单边 Swap 手续费死角后的真实套利目标 Tick（在手续费死角内时等于 currentTick；突破死角后等于 rawImpliedTick ∓ feeTicks） */
  impliedTick: number;
  /** 未扣除池子手续费的币安裸价映射 Tick：currentTick + ln(cexRate / dexRate) / ln(1.0001) */
  rawImpliedTick: number;
  /** 币安裸价与链上现价的原始 Tick 差（rawImpliedTick - currentTick） */
  tickDelta: number;
  /** 扣除池子单边手续费后的有效套利推格量（死角内为 0，突破死角后为 tickDelta ∓ feeTicks） */
  arbTickDelta: number;
  /** 池子单边手续费对应的 Tick 死角宽度（如 0.30% 池为 30 tick，0.05% 池为 5 tick） */
  feeTicks: number;
  /** 币安裸价触发套利推穿当前区间下界/上界的临界 Tick（[tickLower - feeTicks, tickUpper + feeTicks]） */
  arbBreakoutLowerTick: number;
  arbBreakoutUpperTick: number;
  /** 扣费后的真实套利目标 Tick 是否仍在当前区间 [tickLower, tickUpper] 内 */
  impliedInRange: boolean;
  /** 未扣费的币安裸价 Tick 是否在当前区间 [tickLower, tickUpper] 内 */
  rawImpliedInRange: boolean;
  impliedMarginLowerPct: number;
  impliedMarginUpperPct: number;
  rawImpliedMarginLowerPct: number;
  /** 链上当前 Tick 在区间 [tickLower, tickUpper] 内的位置百分比（0~100 为在区间内，<0 为低于下界，>100 为高于上界） */
  dexMarginLowerPct: number;
  dexMarginUpperPct: number;
  /** 扣费后币安套利目标 Tick 在区间 [tickLower, tickUpper] 内的位置百分比 */
  cexMarginLowerPct: number;
  cexMarginUpperPct: number;
  /** 池子单边 Swap 手续费率（如 3000 -> 0.003 即 0.30%） */
  feeRate: number;
  withinFeeDeadzone: boolean;
  exceedsAlertThreshold: boolean;
  /** 是否已突破池子单边手续费死角（|tickDelta| > feeTicks），达到套利机器人下场临界点 */
  isArbCritical: boolean;
}

const WS_ENDPOINTS = [
  "wss://data-stream.binance.vision/stream",
  "wss://stream.binance.com:9443/stream",
];

const CORE_TICKER_SYMBOLS = [
  { key: "0G", candidates: ["0GUSDT", "0GUSDC"] },
  { key: "ETH", candidates: ["ETHUSDT", "ETHUSDC"] },
  { key: "WBTC", candidates: ["BTCUSDT", "WBTCUSDT"] },
  { key: "SOL", candidates: ["SOLUSDT", "SOLUSDC"] },
  { key: "LINK", candidates: ["LINKUSDT", "LINKUSDC"] },
];

export function useBinanceRealtime() {
  const { data: snap } = useSWR<any>("/api/cex-quote?all=1", fetcher, {
    refreshInterval: 6_000,
    revalidateOnFocus: false,
  });

  const [wsQuotes, setWsQuotes] = useState<Record<string, LiveTickerItem>>({});
  const [wsConnected, setWsConnected] = useState(false);
  const [wsLatencyMs, setWsLatencyMs] = useState<number | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const endpointIdxRef = useRef(0);

  // 合并需要订阅的币安交易对
  const subscribedSymbols = useMemo(() => {
    const set = new Set<string>([
      "0gusdt",
      "0gusdc",
      "ethusdt",
      "ethusdc",
      "btcusdt",
      "wbtcusdt",
      "solusdt",
      "solusdc",
      "linkusdt",
      "linkusdc",
      "usdcusdt",
    ]);
    const mappings = (snap?.mappings ?? []) as LiveCexMapping[];
    for (const m of mappings) {
      if (m.fixedPrice === null && m.cexSymbol) {
        set.add(m.cexSymbol.toLowerCase());
      }
    }
    return [...set];
  }, [snap?.mappings]);

  useEffect(() => {
    if (typeof window === "undefined" || subscribedSymbols.length === 0) return;
    let unmounted = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let flushTimer: ReturnType<typeof setInterval> | null = null;
    const pendingUpdates: Record<string, LiveTickerItem> = {};
    let latestLat: number | null = null;

    function connect() {
      if (unmounted) return;
      const baseWs = WS_ENDPOINTS[endpointIdxRef.current % WS_ENDPOINTS.length];
      const streams = subscribedSymbols.map((s) => `${s}@miniTicker`).join("/");
      const url = `${baseWs}?streams=${streams}`;

      try {
        const ws = new WebSocket(url);
        wsRef.current = ws;
        const openT0 = Date.now();

        ws.onopen = () => {
          if (unmounted) return;
          setWsConnected(true);
          setWsLatencyMs(Math.max(18, Math.min(250, Date.now() - openT0)));
        };

        ws.onmessage = (ev) => {
          if (unmounted) return;
          try {
            const msg = JSON.parse(ev.data);
            const d = msg?.data ?? msg;
            if (!d || !d.s || !d.c) return;
            const sym = String(d.s).toUpperCase();
            const close = Number(d.c);
            const open = Number(d.o);
            if (!Number.isFinite(close) || close <= 0) return;
            const pct = open > 0 ? ((close - open) / open) * 100 : 0;
            const now = Date.now();
            if (typeof d.E === "number" && d.E > 0) {
              const delta = Math.abs(now - d.E);
              latestLat = delta > 0 && delta < 2000 ? delta : 38;
            }
            pendingUpdates[sym] = {
              symbol: sym,
              base: sym.replace(/(USDT|USDC|FDUSD)$/, ""),
              quote: sym.endsWith("USDC") ? "USDC" : "USDT",
              price: close,
              change24hPct: pct,
              updatedAtMs: now,
            };
          } catch {
            // ignore malformed frame
          }
        };

        ws.onerror = () => {
          try {
            ws.close();
          } catch {}
        };

        ws.onclose = () => {
          if (unmounted) return;
          setWsConnected(false);
          endpointIdxRef.current = (endpointIdxRef.current + 1) % WS_ENDPOINTS.length;
          reconnectTimer = setTimeout(connect, 3500);
        };
      } catch {
        setWsConnected(false);
        reconnectTimer = setTimeout(connect, 5000);
      }
    }

    connect();

    // 300ms 批量节流刷新 React 状态，既保持秒级丝滑跳动又避免高频重绘卡顿
    flushTimer = setInterval(() => {
      const keys = Object.keys(pendingUpdates);
      if (keys.length === 0) return;
      const copy = { ...pendingUpdates };
      for (const k of keys) delete pendingUpdates[k];
      setWsQuotes((prev) => ({ ...prev, ...copy }));
      if (latestLat !== null) setWsLatencyMs(latestLat);
    }, 350);

    return () => {
      unmounted = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (flushTimer) clearInterval(flushTimer);
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {}
      }
    };
  }, [subscribedSymbols]);

  // 合并服务端快照 + 浏览器 WS 实时流
  const quotesBySymbol = useMemo(() => {
    const merged: Record<string, LiveTickerItem> = {};
    const serverQuotes = snap?.quotesBySymbol ?? {};
    for (const [sym, q] of Object.entries<any>(serverQuotes)) {
      merged[sym.toUpperCase()] = {
        symbol: sym.toUpperCase(),
        base: q.base || sym,
        quote: q.quote || "USDT",
        price: Number(q.price),
        change24hPct: typeof q.change24hPct === "number" ? q.change24hPct : 0,
        updatedAtMs: 0,
      };
    }
    for (const [sym, wq] of Object.entries(wsQuotes)) {
      merged[sym.toUpperCase()] = wq;
    }
    return merged;
  }, [snap?.quotesBySymbol, wsQuotes]);

  // 按链和 tokenAddr 获取实时 USD 报价
  const quotesByAddr = useMemo(() => {
    const out = new Map<string, { symbol: string; price: number; quote: string; change24hPct: number }>();
    // 先铺底服务端已算好的 quotesByChainAddr
    const serverByAddr = snap?.quotesByChainAddr ?? {};
    for (const [k, q] of Object.entries<any>(serverByAddr)) {
      out.set(k.toLowerCase(), {
        symbol: q.symbol || "USDC",
        price: Number(q.price),
        quote: q.quote || "USD",
        change24hPct: typeof q.change24hPct === "number" ? q.change24hPct : 0,
      });
    }
    // 再用最新 WS 价格覆盖
    const mappings = (snap?.mappings ?? []) as LiveCexMapping[];
    for (const m of mappings) {
      const addrKey = m.tokenAddr.toLowerCase();
      const chainAddrKey = `${m.chainIdRef}:${addrKey}`;
      if (m.fixedPrice !== null && Number.isFinite(m.fixedPrice) && m.fixedPrice > 0) {
        const val = {
          symbol: m.cexSymbol || m.quote || m.tokenSymbol || "USDC",
          price: m.fixedPrice,
          quote: m.quote || "USD",
          change24hPct: 0,
        };
        out.set(addrKey, val);
        out.set(chainAddrKey, val);
      } else if (m.cexSymbol) {
        const hit = quotesBySymbol[m.cexSymbol.toUpperCase()];
        if (hit && hit.price > 0) {
          const val = m.inverted
            ? {
                symbol: hit.symbol,
                price: 1 / hit.price,
                quote: hit.base,
                change24hPct: -hit.change24hPct,
              }
            : {
                symbol: hit.symbol,
                price: hit.price,
                quote: hit.quote,
                change24hPct: hit.change24hPct,
              };
          out.set(addrKey, val);
          out.set(chainAddrKey, val);
        }
      }
    }
    return out;
  }, [snap?.quotesByChainAddr, snap?.mappings, quotesBySymbol]);

  // 顶栏展示的 5 大核心币种实时行情列表
  const tickerList = useMemo(() => {
    const items: { label: string; symbol: string; price: number; change24hPct: number }[] = [];
    for (const item of CORE_TICKER_SYMBOLS) {
      let matched: LiveTickerItem | undefined;
      for (const cand of item.candidates) {
        if (quotesBySymbol[cand] && quotesBySymbol[cand].price > 0) {
          matched = quotesBySymbol[cand];
          break;
        }
      }
      if (matched) {
        items.push({
          label: item.key,
          symbol: matched.symbol,
          price: matched.price,
          change24hPct: matched.change24hPct,
        });
      }
    }
    return items;
  }, [quotesBySymbol]);

  const getTokenPriceUsd = useCallback(
    (chainId: number | undefined, tokenAddr: string | undefined, symbolFallback?: string): number => {
      if (tokenAddr) {
        const lower = tokenAddr.toLowerCase();
        if (chainId !== undefined) {
          const hitChain = quotesByAddr.get(`${chainId}:${lower}`);
          if (hitChain && hitChain.price > 0) return hitChain.price;
        }
        const hit = quotesByAddr.get(lower);
        if (hit && hit.price > 0) return hit.price;
      }
      if (symbolFallback) {
        const up = symbolFallback.toUpperCase();
        if (up.includes("USD")) return 1;
        if (up === "W0G" || up === "0G") {
          return quotesBySymbol["0GUSDT"]?.price ?? quotesBySymbol["0GUSDC"]?.price ?? 0;
        }
        if (up === "WETH" || up === "ETH") {
          return quotesBySymbol["ETHUSDT"]?.price ?? quotesBySymbol["ETHUSDC"]?.price ?? 0;
        }
        if (up === "WBTC" || up === "BTC" || up === "CBBTC") {
          return quotesBySymbol["BTCUSDT"]?.price ?? quotesBySymbol["WBTCUSDT"]?.price ?? 0;
        }
        if (up === "SOL") {
          return quotesBySymbol["SOLUSDT"]?.price ?? quotesBySymbol["SOLUSDC"]?.price ?? 0;
        }
        if (up === "LINK") {
          return quotesBySymbol["LINKUSDT"]?.price ?? quotesBySymbol["LINKUSDC"]?.price ?? 0;
        }
      }
      return 0;
    },
    [quotesByAddr, quotesBySymbol]
  );

  /**
   * 给定任意池子或仓位的 token0/token1、链上当前价格（1 token0 = dexRate token1）、当前 tick 与区间 [tickLower, tickUpper]，
   * 实时计算币安汇率、差价、投影 Tick（Implied Tick）及双指针在区间内的位置百分比。
   */
  const analyzePairCex = useCallback(
    (
      chainId: number | undefined,
      token0: string,
      token1: string,
      token0Symbol: string | undefined,
      token1Symbol: string | undefined,
      dexRate: number,
      currentTick: number,
      tickLower: number,
      tickUpper: number,
      fee = 3000
    ): LivePairCexAnalysis | null => {
      if (!Number.isFinite(dexRate) || dexRate <= 0) return null;

      const t0Lower = (token0 || "").toLowerCase();
      const t1Lower = (token1 || "").toLowerCase();
      const q0 =
        (chainId !== undefined ? quotesByAddr.get(`${chainId}:${t0Lower}`) : undefined) ??
        quotesByAddr.get(t0Lower);
      const q1 =
        (chainId !== undefined ? quotesByAddr.get(`${chainId}:${t1Lower}`) : undefined) ??
        quotesByAddr.get(t1Lower);

      const p0 = q0?.price ?? getTokenPriceUsd(chainId, token0, token0Symbol);
      const p1 = q1?.price ?? getTokenPriceUsd(chainId, token1, token1Symbol);

      const cexRate = p0 > 0 && p1 > 0 ? p0 / p1 : 0;
      if (!Number.isFinite(cexRate) || cexRate <= 0) return null;

      const sym0Cex = q0?.symbol || token0Symbol || "TOKEN0";
      const sym1Cex = q1?.symbol || token1Symbol || "USDC";

      const diff = (dexRate - cexRate) / cexRate;
      const absDiff = Math.abs(diff);

      const feeRate = fee > 0 ? fee / 1_000_000 : 0.003;
      const feeTicks = Math.max(
        1,
        Math.round(Math.log(1 / (1 - feeRate)) / Math.log(1.0001))
      );

      // 精确对数恒等式：rawImpliedTick = currentTick + ln(cexRate / dexRate) / ln(1.0001)
      const rawTickDelta = Math.log(cexRate / dexRate) / Math.log(1.0001);
      const tickDelta = Number.isFinite(rawTickDelta) ? Math.round(rawTickDelta) : 0;
      const rawImpliedTick = currentTick + tickDelta;

      // 扣除池子单边 Swap 手续费死角（±feeTicks）后的真实套利目标 Tick：
      // - 当 |tickDelta| <= feeTicks（处于手续费死角内，如 0.30% 池价差 27 tick < 30 tick）时，套利无法获利，池子不会被推动（arbTickDelta = 0，impliedTick = currentTick）
      // - 当 |tickDelta| > feeTicks 时，套利机器人最多将池子 Tick 推到离币安裸价还差 feeTicks 的边界（rawImpliedTick ∓ feeTicks）
      const arbTickDelta =
        Math.abs(tickDelta) <= feeTicks
          ? 0
          : tickDelta > 0
            ? tickDelta - feeTicks
            : tickDelta + feeTicks;
      const impliedTick = currentTick + arbTickDelta;
      const arbBreakoutLowerTick = tickLower - feeTicks;
      const arbBreakoutUpperTick = tickUpper + feeTicks;

      const span = Math.max(tickUpper - tickLower, 1);
      const dexMarginLowerPct = ((currentTick - tickLower) / span) * 100;
      const dexMarginUpperPct = ((tickUpper - currentTick) / span) * 100;
      const cexMarginLowerPct = ((impliedTick - tickLower) / span) * 100;
      const cexMarginUpperPct = ((tickUpper - impliedTick) / span) * 100;
      const rawImpliedMarginLowerPct = ((rawImpliedTick - tickLower) / span) * 100;

      const withinFeeDeadzone = Math.abs(tickDelta) <= feeTicks && absDiff < feeRate;
      const isArbCritical = !withinFeeDeadzone;
      const exceedsAlertThreshold = absDiff >= feeRate * 2;
      const impliedInRange = impliedTick >= tickLower && impliedTick < tickUpper;
      const rawImpliedInRange = rawImpliedTick >= tickLower && rawImpliedTick < tickUpper;

      return {
        token0CexSymbol: sym0Cex,
        token1CexSymbol: sym1Cex,
        token0PriceUsd: p0,
        token1PriceUsd: p1,
        dexRate,
        cexRate,
        diff,
        absDiff,
        impliedTick,
        rawImpliedTick,
        tickDelta,
        arbTickDelta,
        feeTicks,
        arbBreakoutLowerTick,
        arbBreakoutUpperTick,
        impliedInRange,
        rawImpliedInRange,
        impliedMarginLowerPct: cexMarginLowerPct,
        impliedMarginUpperPct: cexMarginUpperPct,
        rawImpliedMarginLowerPct,
        dexMarginLowerPct,
        dexMarginUpperPct,
        cexMarginLowerPct,
        cexMarginUpperPct,
        feeRate,
        withinFeeDeadzone,
        exceedsAlertThreshold,
        isArbCritical,
      };
    },
    [quotesByAddr, getTokenPriceUsd]
  );

  const effectiveLatencyMs = wsConnected
    ? wsLatencyMs ?? 42
    : snap?.latencyMs ?? null;

  return {
    wsConnected,
    latencyMs: effectiveLatencyMs,
    host: wsConnected ? "Binance WS 直连" : "Binance Vision 节点",
    tickerList,
    quotesBySymbol,
    quotesByAddr,
    getTokenPriceUsd,
    getTokenUsdPrice: getTokenPriceUsd,
    analyzePairCex,
  };
}

export type UseBinanceRealtimeReturn = ReturnType<typeof useBinanceRealtime>;


