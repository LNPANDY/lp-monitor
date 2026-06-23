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

/** SWR fetcher。统一处理 { ok, data } 返回结构。 */
export async function fetcher<T = any>(url: string): Promise<T> {
  const r = await fetch(url);
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
 * 价格展示：完全展开小数，绝不使用科学计数法（如 2.3815542e+15 → 2381554200000000）。
 * 小数尾部无意义的 0 会被 trim 掉。
 */
export function fmtFull(n: number): string {
  if (!Number.isFinite(n)) return "—";
  // 先用足够多的小数位展开，再 trim 末尾 0
  let s = Math.abs(n) < 1 && n !== 0 ? n.toFixed(18) : n.toFixed(8);
  if (s.indexOf(".") >= 0) s = s.replace(/0+$/, "").replace(/\.$/, "");
  // 防御性：万一仍含 e/E，转成全数字
  if (/[eE]/.test(s)) s = numberToString(n);
  return s === "" || s === "-" ? "0" : s;
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
