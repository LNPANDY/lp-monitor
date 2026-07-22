"use client";

/**
 * 将 NEXT_PUBLIC_API_TOKEN 环境变量注入到 window.__API_TOKEN__，
 * 供前端所有 fetch 的 authHeaders() 读取使用。
 *
 * 必须是 client component（在 layout.tsx 中渲染），
 * 因为服务端组件没有 window 对象。
 *
 * Token 通过 NEXT_PUBLIC_ 前缀暴露给浏览器端（Next.js 内置机制）。
 * 未配置时为空串——middleware 也会跳过校验（本地开发向后兼容）。
 */
export function TokenBridge() {
  if (typeof window !== "undefined") {
    (window as any).__API_TOKEN__ = process.env.NEXT_PUBLIC_API_TOKEN ?? "";
  }
  return null;
}