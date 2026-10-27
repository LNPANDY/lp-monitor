import type { Metadata } from "next";
import Link from "next/link";
import { ExtensionGuard } from "@/components/extension-guard";
import { WalletConnect } from "@/components/wallet-connect";
import { TokenBridge } from "@/components/token-bridge";
import "./globals.css";

export const metadata: Metadata = {
  title: "LP Monitor — 流动性区间监控",
  description: "监控多链钱包在 DEX 的集中流动性 LP 是否越界，越界即告警",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>
        <TokenBridge />
        <ExtensionGuard />
        <header className="glass-header sticky top-0 z-40">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold">
              <span className="text-lg">💧</span>
              <span className="text-brand-gradient">LP Monitor</span>
            </Link>
            <nav className="flex items-center gap-4 text-sm text-slate-300">
              <Link href="/" className="hover:text-white transition-colors">仪表盘</Link>
              <Link href="/alerts" className="hover:text-white transition-colors">告警</Link>
              <Link href="/config" className="hover:text-white transition-colors">配置</Link>
              <WalletConnect />
            </nav>
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 md:px-6">{children}</main>
      </body>
    </html>
  );
}
