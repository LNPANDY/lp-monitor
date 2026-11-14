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
import {
  getInjectedProvider,
  detectWalletName,
  hasRabbyInstalled,
  type EIP1193Provider,
  type WalletPreference,
} from "./provider";

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
const boundProviders = new WeakSet<EIP1193Provider>();
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
  if (boundProviders.has(p)) return;
  boundProviders.add(p);
  p.on?.("accountsChanged", (accounts: string[]) => {
    if (provider !== p) return;
    const addr = accounts?.[0] ?? null;
    setState({ address: addr, status: addr ? "connected" : "disconnected" });
  });
  p.on?.("chainChanged", (chainIdHex: string) => {
    if (provider !== p) return;
    setState({ chainId: hexToChainId(chainIdHex) });
  });
}

function hexToChainId(hex: string): number {
  return typeof hex === "string" ? parseInt(hex, 16) : Number(hex);
}

/** 初始化：尝试用已授权账户静默恢复（用户之前连过则不弹窗）。 */
async function tryEagerConnect() {
  let pref: WalletPreference = "auto";
  try {
    const saved = window.localStorage.getItem("lp_wallet_pref");
    if (saved === "rabby" || saved === "okx") pref = saved;
  } catch {}
  const p = getInjectedProvider(pref);
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

/** 触发连接（会弹钱包授权窗）。支持指定钱包偏好（如 "rabby"）。 */
async function connect(pref: WalletPreference = "auto"): Promise<string | null> {
  const p = getInjectedProvider(pref);
  if (!p) {
    const name = detectWalletName();
    setState({
      error:
        pref === "rabby"
          ? "未检测到 Rabby 钱包扩展，请确认浏览器已启用 Rabby"
          : name
            ? `检测到 ${name} 但无法连接，请检查钱包扩展`
            : "未检测到钱包扩展，请先安装 Rabby / OKX / MetaMask",
    });
    return null;
  }
  provider = p;
  bindProviderEvents(p);
  try {
    window.localStorage.setItem("lp_wallet_pref", pref);
  } catch {}
  setState({ status: "connecting", error: "" });
  try {
    const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
    const chainIdHex = (await p.request({ method: "eth_chainId" })) as string;
    const addr = accounts?.[0] ?? null;
    setState({
      address: addr,
      chainId: hexToChainId(chainIdHex),
      status: addr ? "connected" : "disconnected",
      error: "",
    });
    return addr;
  } catch (e: any) {
    setState({ status: "disconnected", error: e?.message || "连接被拒绝" });
    return null;
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
    nativeCurrency?: { name: string; symbol: string; decimals: number };
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
            nativeCurrency: chainParams.nativeCurrency ?? {
              name: "ETH",
              symbol: "ETH",
              decimals: 18,
            },
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
 * @param gas   可选预设 gas limit，加速非 multicall 连续交易的钱包弹窗响应
 */
async function sendTx(opts: {
  to: string;
  data: string;
  value?: bigint;
  gas?: bigint;
}): Promise<string> {
  if (!provider || !state.address) throw new Error("钱包未连接");

  const from = state.address;
  const params: any = {
    from,
    to: opts.to,
    data: opts.data,
  };
  if (opts.value && opts.value > 0n) {
    params.value = "0x" + opts.value.toString(16);
  }
  if (opts.gas && opts.gas > 0n) {
    params.gas = "0x" + opts.gas.toString(16);
  }

  try {
    const txHash = (await provider.request({
      method: "eth_sendTransaction",
      params: [params],
    })) as string;
    return txHash;
  } catch (error: any) {
    if (error.code === 4001) {
      throw new Error("用户拒绝了交易");
    }
    throw error;
  }
}

/**
 * 带「钱包取消/失败后立即重试确认」的交易发送器。
 * 当用户在钱包弹窗中点击“取消/拒绝”或遇到临时 RPC 错误时，弹窗询问是否立即重发当前步骤；
 * 若用户选择“确定”则直接重弹钱包签名，无需从头重走已完成的步骤。
 */
export async function sendTxWithCancelRetry(
  opts: {
    to: string;
    data: string;
    value?: bigint;
    gas?: bigint;
  },
  stepLabel: string
): Promise<string> {
  while (true) {
    try {
      return await sendTx(opts);
    } catch (e: any) {
      const msg = e?.message || String(e);
      const isUserCancel =
        e?.code === 4001 ||
        /拒绝|取消|rejected|denied|canceled|cancelled/i.test(msg);
      const confirmText = isUserCancel
        ? `⚠️ 您在钱包中取消了「${stepLabel}」操作。\n\n是否立即重新弹出钱包重试「${stepLabel}」？\n\n• 点击「确定」：立即重弹钱包继续当前步骤\n• 点击「取消」：暂停操作（您仍可点击页面上的「🔄 重试」按钮继续）`
        : `⚠️ 「${stepLabel}」未完成：${msg}\n\n是否立即重试「${stepLabel}」？`;
      const shouldRetry =
        typeof window !== "undefined" ? window.confirm(confirmText) : false;
      if (!shouldRetry) {
        throw e;
      }
    }
  }
}

/**
 * 极速读取链上 NFT 的实时归属（ownerOf）、单次/全局授权状态及当前剩余流动性与待领代币，
 * 用于在「取消后重试 / 断点续签」时精准跳过已完成的解质押、NFT 授权或减仓步骤。
 */
export async function readNftOnChainStatus(
  npm: string,
  tokenId: bigint,
  walletAddr?: string,
  stakerAddr?: string
): Promise<{
  owner: string | null;
  isStakedOnChain: boolean | null;
  singleApprovedToStaker: boolean;
  approvedForAllToStaker: boolean;
  liquidity: bigint | null;
  hasTokensOwed: boolean;
}> {
  const p = provider || getInjectedProvider();
  if (!p || !npm) {
    return {
      owner: null,
      isStakedOnChain: null,
      singleApprovedToStaker: false,
      approvedForAllToStaker: false,
      liquidity: null,
      hasTokensOwed: false,
    };
  }
  const tokenHex = tokenId.toString(16).padStart(64, "0");
  const stakerLower = (stakerAddr || "").toLowerCase();
  const walletLower = (walletAddr || "").toLowerCase();

  try {
    const ownerCall = p
      .request({
        method: "eth_call",
        params: [{ to: npm, data: `0x6352211e${tokenHex}` }, "latest"],
      })
      .catch(() => null) as Promise<string | null>;

    const approvedCall = stakerLower
      ? (p
          .request({
            method: "eth_call",
            params: [{ to: npm, data: `0x081812fc${tokenHex}` }, "latest"],
          })
          .catch(() => null) as Promise<string | null>)
      : Promise.resolve(null);

    const approvedForAllCall =
      stakerLower && walletLower
        ? (p
            .request({
              method: "eth_call",
              params: [
                {
                  to: npm,
                  data: `0xe985e9c5${walletLower
                    .replace(/^0x/, "")
                    .padStart(64, "0")}${stakerLower
                    .replace(/^0x/, "")
                    .padStart(64, "0")}`,
                },
                "latest",
              ],
            })
            .catch(() => null) as Promise<string | null>)
        : Promise.resolve(null);

    const posCall = p
      .request({
        method: "eth_call",
        params: [{ to: npm, data: `0x99fbab88${tokenHex}` }, "latest"],
      })
      .catch(() => null) as Promise<string | null>;

    const [ownerRaw, approvedRaw, allRaw, posRaw] = await Promise.all([
      ownerCall,
      approvedCall,
      approvedForAllCall,
      posCall,
    ]);

    let owner: string | null = null;
    if (ownerRaw && ownerRaw.length >= 66) {
      owner = ("0x" + ownerRaw.slice(-40)).toLowerCase();
    }

    let isStakedOnChain: boolean | null = null;
    if (owner) {
      if (stakerLower && owner === stakerLower) {
        isStakedOnChain = true;
      } else if (walletLower && owner === walletLower) {
        isStakedOnChain = false;
      }
    }

    let singleApprovedToStaker = false;
    if (approvedRaw && approvedRaw.length >= 66 && stakerLower) {
      const apprAddr = ("0x" + approvedRaw.slice(-40)).toLowerCase();
      singleApprovedToStaker = apprAddr === stakerLower;
    }

    let approvedForAllToStaker = false;
    if (allRaw && allRaw.length >= 66) {
      approvedForAllToStaker = allRaw.slice(-1) === "1";
    }

    let liquidity: bigint | null = null;
    let hasTokensOwed = false;
    if (posRaw && posRaw.length >= 2 + 64 * 12) {
      const clean = posRaw.replace(/^0x/, "");
      const liqWord = clean.slice(64 * 7, 64 * 8);
      const owed0Word = clean.slice(64 * 10, 64 * 11);
      const owed1Word = clean.slice(64 * 11, 64 * 12);
      try {
        liquidity = BigInt("0x" + liqWord);
        const owed0 = BigInt("0x" + owed0Word);
        const owed1 = BigInt("0x" + owed1Word);
        hasTokensOwed = owed0 > 0n || owed1 > 0n;
      } catch {}
    }

    return {
      owner,
      isStakedOnChain,
      singleApprovedToStaker,
      approvedForAllToStaker,
      liquidity,
      hasTokensOwed,
    };
  } catch {
    return {
      owner: null,
      isStakedOnChain: null,
      singleApprovedToStaker: false,
      approvedForAllToStaker: false,
      liquidity: null,
      hasTokensOwed: false,
    };
  }
}

/**
 * 极速轮询交易回执（350ms 间隔），一旦上链确认立即返回 receipt，避免死等固定延迟。
 */
export async function waitForTxReceipt(txHash: string, timeoutMs = 45000): Promise<any | null> {
  const p = provider || getInjectedProvider();
  if (!p || !txHash) return null;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const receipt = await p.request({
        method: "eth_getTransactionReceipt",
        params: [txHash],
      });
      if (receipt) {
        if ((receipt as any).status === "0x0") {
          throw new Error(`交易执行失败 (reverted): ${txHash.slice(0, 12)}…`);
        }
        return receipt;
      }
    } catch (e: any) {
      if (e?.message?.includes("reverted")) throw e;
    }
    await new Promise((r) => setTimeout(r, 350));
  }
  return null;
}

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

/**
 * 等待 Mint 交易回执并从 ERC721 Transfer(0x0, recipient, tokenId) 日志中提取新鑄造的 NFT tokenId。
 */
export async function extractMintedTokenIdFromReceipt(
  txHash: string,
  recipientAddr: string,
  npmAddr: string,
  timeoutMs = 45000
): Promise<bigint | null> {
  const receipt = await waitForTxReceipt(txHash, timeoutMs);
  if (!receipt || !Array.isArray(receipt.logs)) return null;
  const npmLower = npmAddr.toLowerCase();
  const recLower = recipientAddr.toLowerCase().replace(/^0x/, "");
  for (const log of receipt.logs) {
    if ((log.address || "").toLowerCase() !== npmLower) continue;
    const topics: string[] = log.topics || [];
    if (
      topics.length >= 4 &&
      topics[0]?.toLowerCase() === TRANSFER_TOPIC &&
      topics[2]?.toLowerCase().endsWith(recLower)
    ) {
      try {
        return BigInt(topics[3]);
      } catch {}
    }
  }
  return null;
}

/**
 * 质押前强校验 NFT 的 (token0, token1, fee) 是否与当前目标池子严格一致，
 * 彻底杜绝将 A/B 交易对的 NFT 存入 C/D 质押合约的风险。
 */
export async function verifyNftPoolMatch(
  npm: string,
  tokenId: bigint,
  expectedToken0: string,
  expectedToken1: string,
  expectedFee: number
): Promise<{ valid: boolean; reason?: string }> {
  const p = provider || getInjectedProvider();
  if (!p) return { valid: true };
  try {
    // positions(uint256) selector: 0x99fbab88
    const data = "0x99fbab88" + tokenId.toString(16).padStart(64, "0");
    const raw = (await p.request({
      method: "eth_call",
      params: [{ to: npm, data }, "latest"],
    })) as string;
    if (!raw || raw.length < 2 + 64 * 5) {
      return { valid: true };
    }
    const clean = raw.replace(/^0x/, "");
    // word 0: nonce, word 1: operator, word 2: token0, word 3: token1, word 4: fee
    const word2 = clean.slice(64 * 2, 64 * 3);
    const word3 = clean.slice(64 * 3, 64 * 4);
    const word4 = clean.slice(64 * 4, 64 * 5);
    const actualToken0 = ("0x" + word2.slice(24)).toLowerCase();
    const actualToken1 = ("0x" + word3.slice(24)).toLowerCase();
    const actualFee = parseInt(word4, 16);

    const exp0 = expectedToken0.toLowerCase();
    const exp1 = expectedToken1.toLowerCase();
    if (actualToken0 !== exp0 || actualToken1 !== exp1) {
      return {
        valid: false,
        reason: `安全拦截：NFT #${tokenId} 的代币对 (${actualToken0.slice(0, 6)}…/${actualToken1.slice(0, 6)}…) 与目标质押池不匹配！`,
      };
    }
    if (expectedFee > 0 && actualFee !== expectedFee) {
      return {
        valid: false,
        reason: `安全拦截：NFT #${tokenId} 的费率档位 (${actualFee}) 与目标质押池 (${expectedFee}) 不匹配！`,
      };
    }
    return { valid: true };
  } catch {
    return { valid: true };
  }
}

/** 导出 Hook：组件用此订阅钱包状态。 */
export function useWallet() {
  // useSyncExternalStore 保证多组件状态一致 + 避免 tearing
  const syncState = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const [hasRabby, setHasRabby] = useState(false);

  useEffect(() => {
    setHasRabby(hasRabbyInstalled());
    const t = setTimeout(() => setHasRabby(hasRabbyInstalled()), 500);
    return () => clearTimeout(t);
  }, []);

  const doConnect = useCallback(() => connect("auto"), []);
  const doConnectRabby = useCallback(() => connect("rabby"), []);
  const doDisconnect = useCallback(() => disconnect(), []);
  const doSwitchChain = useCallback(
    (id: number, params?: Parameters<typeof switchChain>[1]) => switchChain(id, params),
    []
  );
  const doSendTx = useCallback((o: Parameters<typeof sendTx>[0]) => sendTx(o), []);
  const doSendTxWithRetry = useCallback(
    (o: Parameters<typeof sendTx>[0], stepLabel: string) =>
      sendTxWithCancelRetry(o, stepLabel),
    []
  );

  return {
    address: syncState.address,
    chainId: syncState.chainId,
    status: syncState.status,
    error: syncState.error,
    walletName: detectWalletName(provider),
    hasRabby,
    connect: doConnect,
    connectRabby: doConnectRabby,
    disconnect: doDisconnect,
    switchChain: doSwitchChain,
    sendTx: doSendTx,
    sendTxWithRetry: doSendTxWithRetry,
  };
}

