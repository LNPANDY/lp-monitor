/**
 * EIP-1193 注入钱包 provider 探测（含 EIP-6963 多钱包发现与 Rabby 精准匹配）。
 */

/** EIP-1193 provider 最小子集（本应用只用到的几个方法 + 事件）。 */
export interface EIP1193Provider {
  request: (args: { method: string; params?: unknown[] | object }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
  /** 各扩展钱包注入的识别标志位 */
  isRabby?: boolean;
  isOKXWallet?: boolean;
  isMetaMask?: boolean;
  isCoinbaseWallet?: boolean;
  providers?: EIP1193Provider[];
}

export type WalletPreference = "auto" | "rabby" | "okx";

interface EIP6963ProviderDetail {
  info: {
    uuid: string;
    name: string;
    icon: string;
    rdns: string;
  };
  provider: EIP1193Provider;
}

const eip6963Providers: EIP6963ProviderDetail[] = [];
let eip6963Initialized = false;

export function initEip6963Discovery() {
  if (typeof window === "undefined" || eip6963Initialized) return;
  eip6963Initialized = true;
  window.addEventListener("eip6963:announceProvider", ((event: CustomEvent<EIP6963ProviderDetail>) => {
    const detail = event.detail;
    if (!detail?.provider?.request) return;
    if (!eip6963Providers.some((item) => item.info?.uuid === detail.info?.uuid)) {
      eip6963Providers.push(detail);
    }
  }) as EventListener);
  window.dispatchEvent(new Event("eip6963:requestProvider"));
}

if (typeof window !== "undefined") {
  initEip6963Discovery();
}

function findRabbyProvider(): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  initEip6963Discovery();
  // 1. EIP-6963 精准命中 Rabby
  const announced = eip6963Providers.find(
    (d) =>
      d.info?.rdns === "io.rabby" ||
      /rabby/i.test(d.info?.name || "") ||
      d.provider?.isRabby
  );
  if (announced?.provider) return announced.provider;

  // 2. window.ethereum.providers 多钱包数组
  const w = window as any;
  if (Array.isArray(w.ethereum?.providers)) {
    const r = w.ethereum.providers.find((p: EIP1193Provider) => p?.isRabby);
    if (r?.request) return r;
  }

  // 3. window.ethereum 直接挂载（Rabby 会置 isRabby = true）
  if (w.ethereum?.isRabby && w.ethereum?.request) return w.ethereum as EIP1193Provider;
  // 4. 兜底 window.ethereum
  if (w.ethereum?.request) return w.ethereum as EIP1193Provider;
  return null;
}

export function hasRabbyInstalled(): boolean {
  if (typeof window === "undefined") return false;
  initEip6963Discovery();
  if (
    eip6963Providers.some(
      (d) => d.info?.rdns === "io.rabby" || /rabby/i.test(d.info?.name || "") || d.provider?.isRabby
    )
  ) {
    return true;
  }
  const w = window as any;
  if (Array.isArray(w.ethereum?.providers) && w.ethereum.providers.some((p: any) => p?.isRabby)) {
    return true;
  }
  return Boolean(w.ethereum?.isRabby);
}

/**
 * 获取注入的 EIP-1193 provider。
 * 在 SSR（无 window）或未安装钱包时返回 null。
 */
export function getInjectedProvider(pref: WalletPreference = "auto"): EIP1193Provider | null {
  if (typeof window === "undefined") return null;
  initEip6963Discovery();

  if (pref === "rabby") {
    return findRabbyProvider();
  }

  const w = window as any;
  if (pref === "okx") {
    if (w.okxwallet?.request) return w.okxwallet as EIP1193Provider;
  }

  // 默认 auto：兼容原逻辑，优先 OKX 钱包专属注入，其次 window.ethereum（Rabby / MetaMask 等）
  if (w.okxwallet?.request) return w.okxwallet as EIP1193Provider;
  if (w.ethereum?.request) return w.ethereum as EIP1193Provider;
  return null;
}

/** 探测到的钱包展示名（注意 Rabby 也会置 isMetaMask=true，需先判断 isRabby）。 */
export function detectWalletName(targetProvider?: EIP1193Provider | null): string {
  const p = targetProvider ?? getInjectedProvider();
  if (!p) return "";
  if (p.isRabby) return "Rabby";
  if (p.isOKXWallet) return "OKX";
  if (p.isMetaMask) return "MetaMask";
  if (p.isCoinbaseWallet) return "Coinbase";
  return "钱包";
}

