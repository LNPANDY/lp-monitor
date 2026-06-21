"use client";
import { useEffect } from "react";

/**
 * 浏览器扩展错误拦截器。
 *
 * MetaMask / 其他钱包扩展会向每个页面注入 inpage.js 脚本，当扩展的 background
 * 连接失败时会抛出 "Failed to connect to MetaMask" 错误。这类错误被 Next.js
 * 的错误处理捕获后，可能显示为红色全屏崩溃。
 *
 * 本组件在客户端最早期注册 window.error / unhandledrejection 监听器，
 * 凡是来源自 chrome-extension:// 的错误一律静默吞掉，避免污染应用错误边界。
 */
export function ExtensionGuard() {
  useEffect(() => {
    const isExtensionError = (msg: string, stack?: string) => {
      const text = `${msg} ${stack ?? ""}`;
      return (
        text.includes("chrome-extension") ||
        text.includes("MetaMask") ||
        text.includes("inpage.js") ||
        text.includes("contentscript") ||
        text.includes("Failed to connect")
      );
    };

    const onError = (event: ErrorEvent) => {
      if (isExtensionError(event.message, event.error?.stack)) {
        // 阻止默认错误处理（包括 Next.js 的错误覆盖层）
        event.preventDefault();
        event.stopImmediatePropagation();
        return true;
      }
    };

    const onUnhandled = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const msg = typeof reason === "string" ? reason : reason?.message ?? "";
      const stack = reason?.stack ?? "";
      if (isExtensionError(msg, stack)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("error", onError, true);
    window.addEventListener("unhandledrejection", onUnhandled, true);

    return () => {
      window.removeEventListener("error", onError, true);
      window.removeEventListener("unhandledrejection", onUnhandled, true);
    };
  }, []);

  return null;
}
