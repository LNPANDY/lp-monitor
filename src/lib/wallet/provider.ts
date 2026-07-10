/**
 * EIP-1193 注入钱包 provider 探测。
 *
 * 探测顺序（同步，最简单可靠；EIP-6963 异步发现留作未来扩展）：
 *   1. window.okxwallet  —— OKX 钱包专属注入，不与 MetaMask 的 window.ethereum 冲突
 *   2. window.ethereum   —— MetaMask / 其他 EVM 钱包通用注入
 *
 * OKX 钱包同时注入 window.okxwallet 和 window.ethereum（兼容），
 * 优先取 okxwallet 避免在多钱包环境里误连到其它扩展。
 */

/** EIP-1193 provider 最小子集（本应用只用到的几个方法 + 事件）。 */
export interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  /** OKX / MetaMask 等注入的标志位（非标准，仅用于展示钱包名） */
  isOKXWallet?: boolean;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
}

/**
 * 获取注入的 EIP-1193 provider。
 * 在 SSR（无 window）或未安装钱包时返回 null。
 */
export function getInjectedProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  const w = window as any;
  // OKX 钱包专属注入优先
  if (w.okxwallet?.request) return w.okxwallet as EIP1193Provider;
  // 通用 window.ethereum 兜底（MetaMask 等）
  if (w.ethereum?.request) return w.ethereum as EIP1193Provider;
  return null;
}

/** 探测到的钱包展示名（用于 UI 提示「请用 OKX 钱包连接」等）。 */
export function detectWalletName(): string {
  const p = getInjectedProvider();
  if (!p) return "";
  if (p.isOKXWallet) return "OKX";
  if (p.isMetaMask) return "MetaMask";
  if (p.isCoinbaseWallet) return "Coinbase";
  return "钱包";
}
