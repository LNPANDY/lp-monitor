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
