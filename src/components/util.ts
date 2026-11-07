"use client";
import { useEffect, useRef } from "react";

export function short(a?: string) {
  if (!a) return "";
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

export function timeAgo(iso?: string) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  if (s < 86400) return `${Math.floor(s / 3600)}h 前`;
  return `${Math.floor(s / 86400)}d 前`;
}

/**
 * 从浏览器全局取 API Token（由 TokenBridge 注入，由 NEXT_PUBLIC_API_TOKEN 环境变量提供）。
 * 用 window.__API_TOKEN__ 简单可靠，不依赖 localStorage（SSR 不友好）。
 */
function getAuthToken(): string {
  if (typeof window === "undefined") return "";
  return (window as any).__API_TOKEN__ ?? "";
}

/** 构造请求 headers，如有 token 则带 Authorization。 */
export function authHeaders(extra?: Record<string, string>): Record<string, string> {
  const token = getAuthToken();
  const h: Record<string, string> = { ...extra };
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

/** SWR fetcher。统一处理 { ok, data } 返回结构。GET 也带 header 确保 middleware 不拦。 */
export async function fetcher<T = any>(url: string): Promise<T> {
  const r = await fetch(url, { headers: authHeaders() });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "request failed");
  return j.data as T;
}

/** 简单轮询 Hook，用于非 SWR 场景。 */
export function useInterval(cb: () => void, ms: number) {
  const ref = useRef(cb);
  useEffect(() => { ref.current = cb; }, [cb]);
  useEffect(() => {
    const id = setInterval(() => ref.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}

/**
 * 价格展示：完全展开小数，绝不使用科学计数法，同时消除 IEEE-754 双精度浮点尾数噪音
 * （如 0.14740000000000003 → 0.1474，0.14759227999999992 → 0.147592）。
 */
export function fmtFull(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  let cleaned: number;
  if (abs >= 1000) {
    cleaned = Number(n.toFixed(2));
  } else if (abs >= 1) {
    cleaned = Number(n.toFixed(6));
  } else {
    // 对 < 1 的价格（如 W0G ≈ 0.1474 或 W0G/WETH 汇率）保留 6 位有效数字，彻底消除 .00000000003 / .999999992 浮点噪音
    cleaned = Number(n.toPrecision(6));
  }
  let s =
    Math.abs(cleaned) < 1 && cleaned !== 0
      ? cleaned.toFixed(12)
      : cleaned.toFixed(6);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  if (/[eE]/.test(s)) s = numberToString(cleaned);
  return s === "" || s === "-" ? "0" : s;
}

/**
 * 代币数量可读格式化：避免 18 位精度代币（如 W0G）直接输出 1327.060654922942105068。
 */
export function fmtTokenAmount(val: string | number | undefined | null, maxDecimals = 2): string {
  if (val === undefined || val === null || val === "") return "0";
  const n = typeof val === "number" ? val : Number(val);
  if (!Number.isFinite(n) || n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 100) {
    return n.toLocaleString("en-US", { maximumFractionDigits: maxDecimals });
  }
  if (abs >= 1) {
    return n.toLocaleString("en-US", { maximumFractionDigits: Math.max(maxDecimals, 4) });
  }
  return fmtFull(n);
}

/**
 * 任意 number 转成不含科学计数法的字符串。
 * 原生 toString 对极大/极小数会用科学计数法，这里手动按小数点移位展开。
 */
export function numberToString(num: number): string {
  if (!Number.isFinite(num)) return "—";
  if (num === 0) return "0";
  const sign = num < 0 ? "-" : "";
  const str = Math.abs(num).toString();
  if (!/[eE]/.test(str)) return sign + str;
  const [mantissa, expStr] = str.split(/[eE]/);
  const exp = Number(expStr);
  const [intPart, decPart = ""] = mantissa.split(".");
  const digits = intPart + decPart;
  const point = intPart.length + exp;
  if (point <= 0) {
    return sign + "0." + "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    return sign + digits + "0".repeat(point - digits.length);
  } else {
    return sign + digits.slice(0, point) + "." + digits.slice(point);
  }
}

