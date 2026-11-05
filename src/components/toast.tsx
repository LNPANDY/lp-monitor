"use client";
import { useEffect, useState } from "react";

export type ToastKind = "success" | "error" | "info" | "warn";

export interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  detail?: string;
}

let nextId = 1;
let toasts: ToastItem[] = [];
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function pushToast(kind: ToastKind, title: string, detail?: string, durationMs = 4500) {
  const id = nextId++;
  toasts = [...toasts, { id, kind, title, detail }];
  notify();
  if (durationMs > 0 && typeof window !== "undefined") {
    setTimeout(() => {
      toasts = toasts.filter((t) => t.id !== id);
      notify();
    }, durationMs);
  }
}

export const toast = {
  success: (title: string, detail?: string) => pushToast("success", title, detail, 4000),
  error: (title: string, detail?: string) => pushToast("error", title, detail, 6000),
  warn: (title: string, detail?: string) => pushToast("warn", title, detail, 5000),
  info: (title: string, detail?: string) => pushToast("info", title, detail, 3500),
};

export function ToastContainer() {
  const [items, setItems] = useState<ToastItem[]>([]);

  useEffect(() => {
    const sync = () => setItems([...toasts]);
    listeners.add(sync);
    return () => {
      listeners.delete(sync);
    };
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-5 right-5 z-50 flex max-w-sm flex-col gap-2.5">
      {items.map((item) => {
        const tone =
          item.kind === "success"
            ? "border-emerald-500/35 bg-[#0a1915]/95 text-emerald-300 shadow-[0_8px_30px_rgba(16,185,129,0.18)]"
            : item.kind === "error"
              ? "border-rose-500/40 bg-[#1c0c11]/95 text-rose-300 shadow-[0_8px_30px_rgba(244,63,94,0.2)]"
              : item.kind === "warn"
                ? "border-amber-500/40 bg-[#1a1409]/95 text-amber-300 shadow-[0_8px_30px_rgba(245,158,11,0.18)]"
                : "border-cyan-500/35 bg-[#091520]/95 text-cyan-200 shadow-[0_8px_30px_rgba(6,182,212,0.18)]";

        return (
          <div
            key={item.id}
            className={`pointer-events-auto flex items-start gap-2.5 rounded-xl border px-3.5 py-2.5 text-xs backdrop-blur-md transition-all ${tone}`}
          >
            <span className="mt-0.5 shrink-0">
              {item.kind === "success" ? (
                <svg className="h-4 w-4 text-emerald-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.857-9.809a.75.75 0 00-1.214-.882l-3.483 4.79-1.88-1.88a.75.75 0 10-1.06 1.061l2.5 2.5a.75.75 0 001.137-.089l4-5.5z" clipRule="evenodd" />
                </svg>
              ) : item.kind === "error" ? (
                <svg className="h-4 w-4 text-rose-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.28 7.22a.75.75 0 00-1.06 1.06L8.94 10l-1.72 1.72a.75.75 0 101.06 1.06L10 11.06l1.72 1.72a.75.75 0 101.06-1.06L11.06 10l1.72-1.72a.75.75 0 00-1.06-1.06L10 8.94 8.28 7.22z" clipRule="evenodd" />
                </svg>
              ) : (
                <svg className="h-4 w-4 text-cyan-400" viewBox="0 0 20 20" fill="currentColor">
                  <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a.75.75 0 000 1.5h.253a.25.25 0 01.244.304l-.459 2.066A1.75 1.75 0 0010.747 15H11a.75.75 0 000-1.5h-.253a.25.25 0 01-.244-.304l.459-2.066A1.75 1.75 0 009.253 9H9z" clipRule="evenodd" />
                </svg>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <div className="font-semibold leading-snug text-slate-100">{item.title}</div>
              {item.detail && (
                <div className="mt-0.5 break-words text-[11px] leading-relaxed text-slate-300/90">
                  {item.detail}
                </div>
              )}
            </div>
            <button
              className="shrink-0 rounded p-0.5 text-slate-400 hover:bg-white/10 hover:text-white"
              onClick={() => {
                toasts = toasts.filter((t) => t.id !== item.id);
                notify();
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
    </div>
  );
}
