"use client";
import { useWallet } from "@/lib/wallet/use-wallet";

/**
 * 顶栏「连接钱包」按钮。
 *
 * 未连接：显示「连接钱包」，点击触发 EIP-1193 授权（OKX 优先）。
 * 已连接：显示截断地址，点击断开。
 */
export function WalletConnect() {
  const { address, status, error, connect, disconnect, walletName } = useWallet();

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  if (status === "connected" && address) {
    return (
      <div className="flex items-center gap-2">
        {walletName && (
          <span className="hidden text-[11px] text-ink-soft sm:inline">{walletName}</span>
        )}
        <button
          className="rounded border border-slate-200 bg-white px-2.5 py-1 text-xs hover:bg-slate-50"
          title={`${address} · 点击断开`}
          onClick={disconnect}
        >
          {short(address)}
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        className="rounded bg-ink px-3 py-1 text-xs text-white hover:bg-ink/90 disabled:opacity-50"
        disabled={status === "connecting"}
        onClick={connect}
      >
        {status === "connecting" ? "连接中…" : "连接钱包"}
      </button>
      {error && (
        <span className="max-w-[200px] truncate text-[11px] text-warn" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
