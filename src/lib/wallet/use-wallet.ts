"use client";
/**
 * 钱包连接 React Hook（全局单例）。
 *
 * 基于 EIP-1193 provider（OKX / MetaMask 等），用 module-level state + 订阅模式
 * 保证多个组件实例共享同一份状态（顶栏的 WalletConnect 和卡片里的移除按钮都要读）。
 *
 * 提供：
 *   - connect / disconnect
 *   - address / chainId / status
 *   - switchChain(targetChainId, chainParams?)  —— 切链，失败自动 addEthereumChain
 *   - sendTx({ to, data, value })               —— eth_sendTransaction，返回 txHash
 *
 * 全部写交易由用户在钱包里手动确认（provider 会弹窗），本应用不持有私钥。
 */
import { useEffect, useState, useCallback, useSyncExternalStore } from "react";
import { getInjectedProvider, detectWalletName, type EIP1193Provider } from "./provider";

type Status = "disconnected" | "connecting" | "connected";

interface WalletState {
  address: string | null;
  chainId: number | null; // EVM chainId（十进制，如 16661）
  status: Status;
  error: string;
}

const initialState: WalletState = {
  address: null,
  chainId: null,
  status: "disconnected",
  error: "",
};

// ===== module-level 单例 =====
let state: WalletState = initialState;
let provider: EIP1193Provider | null = null;
const listeners = new Set<() => void>();

function setState(patch: Partial<WalletState>) {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function getSnapshot() {
  return state;
}

/** 绑定 provider 事件，自动同步账户/链变化。 */
function bindProviderEvents(p: EIP1193Provider) {
  p.on?.("accountsChanged", (accounts: string[]) => {
    const addr = accounts?.[0] ?? null;
    setState({ address: addr, status: addr ? "connected" : "disconnected" });
  });
  p.on?.("chainChanged", (chainIdHex: string) => {
    setState({ chainId: hexToChainId(chainIdHex) });
  });
}

function hexToChainId(hex: string): number {
  return typeof hex === "string" ? parseInt(hex, 16) : Number(hex);
}

/** 初始化：尝试用已授权账户静默恢复（用户之前连过则不弹窗）。 */
async function tryEagerConnect() {
  const p = getInjectedProvider();
  if (!p) return;
  provider = p;
  bindProviderEvents(p);
  try {
    const accounts = (await p.request({ method: "eth_accounts" })) as string[];
    if (accounts && accounts.length > 0) {
      const chainIdHex = (await p.request({ method: "eth_chainId" })) as string;
      setState({
        address: accounts[0],
        chainId: hexToChainId(chainIdHex),
        status: "connected",
        error: "",
      });
    }
  } catch {
    // 静默失败：保持 disconnected
  }
}

// 模块加载时尝试恢复（仅在浏览器侧）
if (typeof window !== "undefined") {
  // 等 provider 注入完成（钱包扩展注入有延迟）
  if ((window as any).okxwallet || (window as any).ethereum) {
    tryEagerConnect();
  } else {
    window.addEventListener("load", () => tryEagerConnect());
  }
}

/** 触发连接（会弹钱包授权窗）。 */
async function connect() {
  const p = getInjectedProvider();
  if (!p) {
    const name = detectWalletName();
    setState({
      error: name
        ? `检测到 ${name} 但无法连接，请检查钱包扩展`
        : "未检测到钱包扩展，请先安装 OKX 钱包或 MetaMask",
    });
    return;
  }
  provider = p;
  bindProviderEvents(p);
  setState({ status: "connecting", error: "" });
  try {
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
    const chainIdHex = (await p.request({ method: "eth_chainId" })) as string;
    setState({
      address: accounts?.[0] ?? null,
      chainId: hexToChainId(chainIdHex),
      status: accounts?.[0] ? "connected" : "disconnected",
      error: "",
    });
  } catch (e: any) {
    setState({ status: "disconnected", error: e?.message || "连接被拒绝" });
  }
}

function disconnect() {
  // EIP-1193 没有标准断开，清空本地状态即可（钱包侧权限仍在，下次连接会直接恢复）
  setState({ address: null, status: "disconnected", error: "" });
}

/**
 * 切换到目标链。失败时尝试 addEthereumChain（带 RPC 参数）。
 * @param targetChainId EVM chainId（十进制）
 * @param chainParams   addEthereumChain 所需参数（链不存在于钱包时用）
 */
async function switchChain(
  targetChainId: number,
  chainParams?: {
    chainName: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
    rpcUrls: string[];
    blockExplorerUrls?: string[];
  }
): Promise<void> {
  if (!provider) throw new Error("钱包未连接");
  const chainIdHex = "0x" + targetChainId.toString(16);
  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: chainIdHex }],
    });
    setState({ chainId: targetChainId });
  } catch (switchError: any) {
    // 4902: 钱包里没有这条链，尝试添加
    if (switchError?.code === 4902 && chainParams) {
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [
          {
            chainId: chainIdHex,
            chainName: chainParams.chainName,
            nativeCurrency: chainParams.nativeCurrency,
            rpcUrls: chainParams.rpcUrls,
            blockExplorerUrls: chainParams.blockExplorerUrls ?? [],
          },
        ],
      });
      setState({ chainId: targetChainId });
    } else {
      throw switchError;
    }
  }
}

/**
   * 发送交易（用户在钱包确认）。返回 txHash。
   * @param to   目标合约地址
   * @param data 已编码的 calldata（0x...）
   * @param value 原生代币金额（wei，可选）
   */
  async function sendTx(opts: {
    to: string;
    data: string;
    value?: bigint;
  }): Promise<string> {
    if (!provider || !state.address) throw new Error("钱包未连接");
    
    // 获取当前链ID并检查是否匹配目标链
    const currentChainIdHex = (await provider.request({ method: "eth_chainId" })) as string;
    const currentChainId = parseInt(currentChainIdHex, 16);
    
    console.log("Sending transaction:", {
      to: opts.to,
      from: state.address,
      currentChainId,
      value: opts.value
    });
    
    const from = state.address;
    const params: any = {
      from,
      to: opts.to,
      data: opts.data,
    };
    if (opts.value && opts.value > 0n) {
      params.value = "0x" + opts.value.toString(16);
    }
    
    try {
      const txHash = (await provider.request({
        method: "eth_sendTransaction",
        params: [params],
      })) as string;
      console.log("Transaction sent:", txHash);
      return txHash;
    } catch (error: any) {
      console.error("Transaction failed:", error);
      if (error.code === 4001) {
        throw new Error("用户拒绝了交易");
      }
      throw error;
    }
  }

/** 导出 Hook：组件用此订阅钱包状态。 */
export function useWallet() {
  // useSyncExternalStore 保证多组件状态一致 + 避免 tearing
  const syncState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const doConnect = useCallback(() => connect(), []);
  const doDisconnect = useCallback(() => disconnect(), []);
  const doSwitchChain = useCallback(
    (id: number, params?: Parameters<typeof switchChain>[1]) => switchChain(id, params),
    []
  );
  const doSendTx = useCallback((o: Parameters<typeof sendTx>[0]) => sendTx(o), []);

  return {
    address: syncState.address,
    chainId: syncState.chainId,
    status: syncState.status,
    error: syncState.error,
    walletName: detectWalletName(),
    connect: doConnect,
    disconnect: doDisconnect,
    switchChain: doSwitchChain,
    sendTx: doSendTx,
  };
}
