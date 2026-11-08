import type { Metadata } from "next";
import Link from "next/link";
import { ExtensionGuard } from "@/components/extension-guard";
import { WalletConnect } from "@/components/wallet-connect";
import { TokenBridge } from "@/components/token-bridge";
import { ToastContainer } from "@/components/toast";
import "./globals.css";

export const metadata: Metadata = {
  title: "LP Terminal — 集中流动性监控与秒级作业台",
  description: "多链集中流动性 LP 实时区间监控、CEX 差价捕捉、一键建仓质押与秒级撤池终端",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <TokenBridge />
        <ExtensionGuard />
        <ToastContainer />
        <header className="glass-header sticky top-0 z-40">
          <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 py-2.5 md:px-6">
            <Link href="/" className="flex items-center gap-2.5 font-semibold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg border border-cyan-400/30 bg-cyan-500/10 text-cyan-300 shadow-[0_0_15px_rgba(34,211,238,0.2)]">
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5l5-5 4 4 6-6.5 3 3" />
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15 6h6v6" />
                </svg>
              </span>
              <div className="flex items-baseline gap-2">
                <span className="text-sm font-bold text-white">LP TERMINAL</span>
                <span className="hidden rounded border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-emerald-300 sm:inline-block">
                  PRO V3/V4
                </span>
                <span className="rounded border border-cyan-400/30 bg-cyan-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-cyan-200">
                  v0.22.0
                </span>
              </div>
            </Link>
            <nav className="flex items-center gap-1.5 text-xs text-slate-300 md:gap-2">
              <Link
                href="/"
                className="rounded-lg px-3 py-1.5 font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                主控终端
              </Link>
              <Link
                href="/alerts"
                className="rounded-lg px-3 py-1.5 font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                告警日志
              </Link>
              <Link
                href="/config"
                className="rounded-lg px-3 py-1.5 font-medium text-slate-300 transition hover:bg-white/[0.06] hover:text-white"
              >
                系统配置
              </Link>
              <div className="mx-1 h-4 w-px bg-white/10" />
              <WalletConnect />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-3 py-4 md:px-6">{children}</main>
      </body>
    </html>
  );
}
