"use client";

/**
 * 全局错误边界。捕获第三方浏览器扩展（如 MetaMask inpage.js）抛出的非业务错误，
 * 展示一个低调的提示而非红色全屏崩溃。
 * 点击「继续使用」恢复页面渲染。
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // MetaMask / 其他钱包扩展的错误特征
  const isExtension =
    error?.message?.includes("MetaMask") ||
    error?.message?.includes("inpage.js") ||
    error?.message?.includes("chrome-extension");

  if (isExtension) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="card max-w-md p-6 text-center">
          <div className="mb-3 text-4xl">🔌</div>
          <h2 className="mb-2 text-lg font-semibold">浏览器扩展检测到非致命错误</h2>
          <p className="mb-1 text-sm text-ink-soft">
            检测到钱包扩展（如 MetaMask）在注入页面时抛出了错误。
            这是扩展自身的问题，<strong>不影响 LP Monitor 的正常使用</strong>。
          </p>
          <p className="mb-4 text-xs text-ink-soft">
            如果重复出现，可尝试在浏览器扩展管理中禁用钱包扩展后再刷新本页，
            或忽略此提示直接继续使用。
          </p>
          <button
            className="btn-primary"
            onClick={() => {
              // 忽略该错误，恢复渲染
              reset();
            }}
          >
            继续使用 LP Monitor
          </button>
        </div>
      </div>
    );
  }

  // 其他未知错误的兜底
  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="card max-w-md p-6 text-center">
        <div className="mb-3 text-4xl">💥</div>
        <h2 className="mb-2 text-lg font-semibold">页面出错了</h2>
        <p className="mb-4 text-sm text-ink-soft break-all">
          {error?.message ?? "未知错误"}
        </p>
        <div className="flex gap-2 justify-center">
          <button className="btn-primary" onClick={reset}>重试</button>
          <button className="btn-ghost" onClick={() => (window.location.href = "/")}>回到首页</button>
        </div>
      </div>
    </div>
  );
}
