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
          className="rounded border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs hover:bg-white/[0.08]"
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
        className="btn-primary rounded px-3 py-1 text-xs"
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
