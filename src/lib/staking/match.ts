/**
 * 质押合约（ZiaVault / V3 Staker）精确池子匹配器。
 *
 * 解决痛点：
 *   同一交易对（如 W0G/USDC、WBTC/W0G、W0G/WETH）在 0G ZIA 上往往同时存在 0.3% (3000) 与 1% (10000)
 *   两个独立的质押合约，且配置里的 pair_label 可能完全同名（例如两个都叫 "W0G/USDC"）。
 *   若仅按币种符号模糊匹配，极易把 0.3% 的 LP 匹配到 1% 的质押合约导致 deposit Revert。
 *
 * 方案：
 *   1. ZiaVault 字节码自带只读函数：
 *      - poolToken0() [0xa73bf6df] -> address
 *      - poolToken1() [0x4758af8a] -> address
 *      - poolFee()    [0x089fe6aa] -> uint24
 *   2. 首次读取后永久缓存在进程内存 + SQLite settings 表（`staker_pool_meta_<chainId>_<addr>`）。
 *   3. 匹配时优先按链上 `(token0, token1, fee)` 三元组 100% 精确命中；
 *      对尚未缓存或非 ZiaVault 合约，结合 pair_label 内的费率数字（如 "0.3" -> 3000）消歧。
 */
import type { PublicClient, Address } from "viem";
import type { StakingRow } from "../chains/dexes";
import { getSetting, setSetting } from "../db/settings";

export interface StakerPoolMeta {
  token0: string;
  token1: string;
  fee: number;
}

const ZIA_VAULT_META_ABI = [
  {
    name: "poolToken0",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "poolToken1",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
  },
  {
    name: "poolFee",
    type: "function",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint24" }],
  },
] as const;

function getMetaCache(): Map<string, StakerPoolMeta | null> {
  const g = globalThis as any;
  if (!g.__lpMonitorStakerPoolMeta__) {
    g.__lpMonitorStakerPoolMeta__ = new Map<string, StakerPoolMeta | null>();
  }
  return g.__lpMonitorStakerPoolMeta__;
}

function makeCacheKey(chainIdRef: number, contract: string): string {
  return `${chainIdRef}:${contract.toLowerCase()}`;
}

function makeSettingKey(chainIdRef: number, contract: string): string {
  return `staker_pool_meta_${chainIdRef}_${contract.toLowerCase()}`;
}

/** 同步读取某个质押合约已缓存的 (token0, token1, fee) 元数据（内存 + SQLite，0 RPC） */
export function getCachedStakerPoolMeta(
  chainIdRef: number,
  contract: string
): StakerPoolMeta | null | undefined {
  const key = makeCacheKey(chainIdRef, contract);
  const cache = getMetaCache();
  if (cache.has(key)) return cache.get(key);

  const raw = getSetting(makeSettingKey(chainIdRef, contract), "");
  if (!raw) return undefined;
  if (raw === "none") {
    cache.set(key, null);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as StakerPoolMeta;
    if (parsed && parsed.token0 && parsed.token1 && typeof parsed.fee === "number") {
      cache.set(key, parsed);
      return parsed;
    }
  } catch {}
  return undefined;
}

/** 并发预热指定链上所有质押合约的 (poolToken0, poolToken1, poolFee) 元数据 */
export async function ensureStakingPoolMeta(
  client: PublicClient,
  chainIdRef: number,
  stakingRows: StakingRow[]
): Promise<void> {
  const cache = getMetaCache();
  const missing = stakingRows.filter(
    (s) =>
      s.chain_id_ref === chainIdRef &&
      /^0x[a-fA-F0-9]{40}$/.test(s.contract) &&
      getCachedStakerPoolMeta(chainIdRef, s.contract) === undefined
  );
  if (missing.length === 0) return;

  await Promise.all(
    missing.map(async (s) => {
      const addr = s.contract as Address;
      const key = makeCacheKey(chainIdRef, s.contract);
      const sKey = makeSettingKey(chainIdRef, s.contract);
      try {
        const [t0, t1, fee] = await Promise.all([
          client.readContract({
            address: addr,
            abi: ZIA_VAULT_META_ABI,
            functionName: "poolToken0",
          }),
          client.readContract({
            address: addr,
            abi: ZIA_VAULT_META_ABI,
            functionName: "poolToken1",
          }),
          client.readContract({
            address: addr,
            abi: ZIA_VAULT_META_ABI,
            functionName: "poolFee",
          }),
        ]);
        const meta: StakerPoolMeta = {
          token0: String(t0).toLowerCase(),
          token1: String(t1).toLowerCase(),
          fee: Number(fee),
        };
        cache.set(key, meta);
        setSetting(sKey, JSON.stringify(meta));
      } catch {
        cache.set(key, null);
        setSetting(sKey, "none");
      }
    })
  );
}

const normSym = (s: string) =>
  (s || "")
    .toLowerCase()
    .replace(/\.(e|b|c|m|w)$/i, "")
    .trim();

/** 从 pair_label 中提取显式标注的费率（例如 "W0G/WETH 0.3" -> 3000, "USDT/USDC 0.01%" -> 100） */
function parseLabelFeeHint(label: string): number | null {
  const tokens = (label || "").toLowerCase().split(/[\/\s,]+/);
  for (const t of tokens) {
    const m = t.match(/^(\d+(?:\.\d+)?)%?$/);
    if (m) {
      const pct = Number(m[1]);
      if (pct > 0 && pct <= 10) {
        return Math.round(pct * 10_000);
      }
    }
  }
  return null;
}

/**
 * 为指定池子筛选并排序匹配的质押合约（同步 0 RPC，自动利用已缓存的链上 poolToken0/poolToken1/poolFee）。
 */
export function matchStakingContractsForPool<
  T extends {
    id: number;
    chain_id_ref: number;
    platform: string;
    pair_label: string;
    contract: string;
    dex_id?: number | null;
  }
>(
  stakingRows: T[],
  opts: {
    chainIdRef: number;
    dexId?: number | null;
    token0?: string;
    token1?: string;
    symbol0?: string;
    symbol1?: string;
    fee?: number;
  }
): T[] {
  const t0 = (opts.token0 || "").toLowerCase();
  const t1 = (opts.token1 || "").toLowerCase();
  const base0 = normSym(opts.symbol0 || "");
  const base1 = normSym(opts.symbol1 || "");
  const targetFee = typeof opts.fee === "number" && opts.fee > 0 ? opts.fee : undefined;

  const sameChain = stakingRows.filter((s) => {
    if (s.chain_id_ref !== opts.chainIdRef) return false;
    if (s.dex_id && opts.dexId && s.dex_id !== opts.dexId) return false;
    return true;
  });

  // 1. 优先使用链上已缓存的 (poolToken0, poolToken1, poolFee) 做 100% 精确匹配
  if (t0 && t1) {
    const exactMatches: T[] = [];
    let anyHasMeta = false;
    for (const s of sameChain) {
      const meta = getCachedStakerPoolMeta(opts.chainIdRef, s.contract);
      if (meta) {
        anyHasMeta = true;
        const pairMatch =
          (meta.token0 === t0 && meta.token1 === t1) ||
          (meta.token0 === t1 && meta.token1 === t0);
        const feeMatch = targetFee === undefined || meta.fee === targetFee;
        if (pairMatch && feeMatch) {
          exactMatches.push(s);
        }
      }
    }
    if (exactMatches.length > 0) return exactMatches;
    // 如果同链所有质押合约都已经缓存了链上元数据，但没有任何一个的 (token0, token1, fee) 匹配该池子，
    // 说明该费率池确实没有配置对应的质押合约，直接返回空数组避免误匹配到其它费率池！
    if (anyHasMeta && sameChain.every((s) => !!getCachedStakerPoolMeta(opts.chainIdRef, s.contract))) {
      return [];
    }
  }

  // 2. 降级使用 pair_label 符号 + 费率数字提示匹配
  if (!base0 || !base1) return [];
  const labelCandidates = sameChain.filter((s) => {
    const meta = getCachedStakerPoolMeta(opts.chainIdRef, s.contract);
    // 如果该质押合约已有明确链上 fee 且与目标池子 fee 不一致，直接排除！
    if (meta && targetFee !== undefined && meta.fee !== targetFee) {
      return false;
    }
    const rawLabel = (s.pair_label || "").toLowerCase();
    if (!rawLabel) return false;
    const labelBases = rawLabel
      .split(/[\/\s,]+/)
      .map((t) => normSym(t))
      .filter((t) => t && !/^\d+(\.\d+)?%?$/.test(t));
    // 兼容 WBTC vs cbBTC 别名
    const expandAlias = (sym: string) =>
      sym === "wbtc" || sym === "cbbtc" ? ["wbtc", "cbbtc", "btc"] : [sym];
    const has0 = expandAlias(base0).some((a) => labelBases.includes(a));
    const has1 = expandAlias(base1).some((a) => labelBases.includes(a));
    return has0 && has1;
  });

  if (labelCandidates.length <= 1 || targetFee === undefined) {
    return labelCandidates;
  }

  // 当存在多个同名交易对质押合约时，按 label 中的费率提示排序/过滤
  const exactFeeHinted = labelCandidates.filter(
    (s) => parseLabelFeeHint(s.pair_label) === targetFee
  );
  if (exactFeeHinted.length > 0) return exactFeeHinted;

  const noConflictFeeHinted = labelCandidates.filter((s) => {
    const hint = parseLabelFeeHint(s.pair_label);
    return hint === null || hint === targetFee;
  });
  return noConflictFeeHinted.length > 0 ? noConflictFeeHinted : labelCandidates;
}
