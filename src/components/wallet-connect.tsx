"use client";
import { useWallet } from "@/lib/wallet/use-wallet";

/**
 * 顶栏「连接钱包」按钮。
 */
export function WalletConnect() {
  const { address, status, error, connect, disconnect, walletName } = useWallet();

  const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

  if (status === "connected" && address) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          className="inline-flex items-center gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1.5 font-mono text-xs font-medium text-emerald-200 transition hover:border-emerald-400/50 hover:bg-emerald-500/15"
          title={`${walletName ? walletName + " · " : ""}${address}（点击断开）`}
          onClick={disconnect}
        >
          <span className="h-2 w-2 rounded-full bg-emerald-400 shadow-[0_0_8px_#10b981]" />
          <span>{short(address)}</span>
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <button
        className="btn-primary px-3 py-1.5 text-xs"
        disabled={status === "connecting"}
        onClick={connect}
      >
        <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
          <path strokeLinecap="round" strokeLinejoin="round" d="M21 12V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2h14a2 2 0 002-2v-5zm-6 0h6" />
        </svg>
        {status === "connecting" ? "连接中…" : "连接钱包"}
      </button>
      {error && (
        <span className="max-w-[180px] truncate text-[11px] text-rose-400" title={error}>
          {error}
        </span>
      )}
    </div>
  );
}
