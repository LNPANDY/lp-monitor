/**
 * 链上资产统计聚合服务。
 *
 * 给定一条链 + 一个钱包地址，统计该钱包在该链上的全部资产价值：
 *   1. 原生 GAS 代币余额（eth_getBalance）
 *   2. ERC20 代币余额（自动发现：positions 表 token0/token1 + token_symbols 表已配置代币）
 *   3. 直接持有的 V3 LP 仓位（按 token0/token1 数量 × CEX 报价累加）
 *
 * 价值口径：CEX 报价（币安或固定价）视为 USD（1U）。
 * 未匹配到 CEX 报价的资产仍展示数量，但不计入总价值（valueUsd = null）。
 *
 * 第一版仅统计直接持有的 LP（source=direct）；质押溯源仓位（source=staking）暂不统计，
 * 因为需遍历 vault 合约，复杂度较高。
 *
 * 更新：质押仓位也在扫描时通过同一 adapter 写入了 last_liquidity/pool/tick 等字段，
 * 故直接放开 source 过滤即可一并统计（含 direct + staking）。
 */
import type { PublicClient } from "viem";
import { getDb } from "../db";
import { getClient, getChain } from "../chains";
import { resolveTokens } from "../chains/tokens";
import { loadAllMappings, buildQuotesByAddr, type CexQuote } from "../cex/binance";
import { getAmountsForLiquidity, tickToSqrtPriceX96 } from "../v3/math";
import { V3_POOL_ABI } from "../adapters/v3-fork";

/** ERC20 balanceOf ABI（仅需要这一个方法）。 */
const ERC20_BALANCE_ABI = [
  { name: "balanceOf", type: "function", stateMutability: "view", inputs: [{ name: "owner", type: "address" }], outputs: [{ name: "balance", type: "uint256" }] },
] as const;

/** 单项资产。 */
export interface AssetItem {
  kind: "native" | "erc20" | "lp";
  symbol: string;          // 展示符号（0G / USDC.e / ZIA·#4132(USDC.e/LINK)）
  amount: string;          // 数量（保留 6 位小数，去尾零）
  valueUsd: number | null; // 价值（U），null=未匹配报价
  subItems?: { symbol: string; amount: string; valueUsd: number | null }[];
}

/** 资产统计结果。 */
export interface PortfolioResult {
  items: AssetItem[];
  totalUsd: number;
  nativeSymbol: string;
  /** 统计过程中发生的非致命错误（如某仓位 RPC 读取失败）。 */
  warnings: string[];
}

/** 保留至多 n 位小数并去掉尾随 0。 */
function fmtAmount(v: number, maxDecimals = 6): string {
  if (!Number.isFinite(v)) return "0";
  const fixed = v.toFixed(maxDecimals);
  return fixed.replace(/(?:\.0+|(\.\d*?)0+)$/, "$1");
}

/** 读取 pool 当前 sqrtPriceX96（用于反算 LP token 数量）。 */
async function readSqrtPrice(client: PublicClient, pool: `0x${string}`): Promise<bigint | null> {
  try {
    const slot0 = await client.readContract({ address: pool, abi: V3_POOL_ABI, functionName: "slot0" });
    const arr = slot0 as unknown as any[];
    return arr[0] as bigint;
  } catch {
    return null;
  }
}

/**
 * 计算指定链 + 钱包的资产组合。
 * @param chainDbId  chains 表 id
 * @param address    钱包地址（0x…）
 */
export async function computePortfolio(chainDbId: number, address: string): Promise<PortfolioResult> {
  const chain = getChain(chainDbId);
  if (!chain) throw new Error("链不存在");
  const { client } = getClient(chainDbId);
  const nativeSymbol = chain.symbol || "ETH";
  const addr = address.toLowerCase() as `0x${string}`;
  const warnings: string[] = [];

  // ===== 1. 加载该链 CEX 报价（含 __native__ 的 GAS 报价） =====
  const allMappings = loadAllMappings();
  const chainMappings = allMappings.get(chainDbId) ?? [];
  const quoteByAddr = await buildQuotesByAddr(chainMappings);

  // ===== 2. 原生 GAS 余额 =====
  const items: AssetItem[] = [];
  let totalUsd = 0;
  try {
    const balanceWei = await client.getBalance({ address: addr });
    const nativeAmount = Number(balanceWei) / 1e18;
    const nativeQuote = quoteByAddr.get("__native__");
    const nativeValue = nativeQuote ? nativeAmount * nativeQuote.price : null;
    items.push({
      kind: "native",
      symbol: nativeSymbol,
      amount: fmtAmount(nativeAmount),
      valueUsd: nativeValue,
    });
    if (nativeValue !== null) totalUsd += nativeValue;
  } catch (e: any) {
    warnings.push(`读取 GAS 余额失败：${e?.message ?? e}`);
  }

  // ===== 2. ERC20 代币余额（自动发现） =====
  // 从 positions 表和 token_symbols 表中提取该链上已知代币地址，批量查询 balanceOf
  try {
    const erc20Addrs = new Set<string>();

    // 来源 A：positions 表中该链所有 token0/token1 地址
    const posTokens = getDb().prepare(
      "SELECT DISTINCT token0, token1 FROM positions WHERE chain_id_ref=?"
    ).all(chainDbId) as { token0: string; token1: string }[];
    for (const row of posTokens) {
      const t0 = row.token0.toLowerCase();
      const t1 = row.token1.toLowerCase();
      if (t0.startsWith("0x")) erc20Addrs.add(t0);
      if (t1.startsWith("0x")) erc20Addrs.add(t1);
    }

    // 来源 B：token_symbols 表中该链已配置 CEX 报价的代币（排除 __native__）
    const cexTokens = getDb().prepare(
      "SELECT DISTINCT token_addr FROM token_symbols WHERE chain_id_ref=? AND token_addr != '__native__'"
    ).all(chainDbId) as { token_addr: string }[];
    for (const row of cexTokens) {
      const a = row.token_addr.toLowerCase();
      if (a.startsWith("0x")) erc20Addrs.add(a);
    }

    if (erc20Addrs.size > 0) {
      // 批量解析 token 元数据（带缓存）
      const tokenMeta = await resolveTokens(client, chainDbId, [...erc20Addrs]);

      // 并发查询每个代币的 balanceOf
      const results = await Promise.all(
        [...erc20Addrs].map(async (tokenAddr) => {
          const meta = tokenMeta.get(tokenAddr);
          const decimals = meta?.decimals ?? 18;
          try {
            const balanceRaw = await client.readContract({
              address: tokenAddr as `0x${string}`,
              abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf",
              args: [addr],
            }) as bigint;
            const amount = Number(balanceRaw) / 10 ** decimals;
            const symbol = meta?.symbol || tokenAddr;
            const quote = quoteByAddr.get(tokenAddr);
            const value = quote ? amount * quote.price : null;
            return { symbol, amount, value, balanceRaw, decimals };
          } catch {
            return null;
          }
        })
      );

      // 过滤掉余额为 0 的代币，添加到资产列表
      for (const r of results) {
        if (!r || r.balanceRaw === 0n) continue;
        items.push({
          kind: "erc20",
          symbol: r.symbol,
          amount: fmtAmount(r.amount),
          valueUsd: r.value,
        });
        if (r.value !== null) totalUsd += r.value;
      }
    }
  } catch (e: any) {
    warnings.push(`读取 ERC20 代币余额失败：${e?.message ?? e}`);
  }

  // ===== 3. LP 仓位（直接持有 + 质押溯源） =====
  // 按 wallet.address 查 positions（钱包地址小写匹配）
  const walletRow = getDb().prepare(
    "SELECT id FROM wallets WHERE chain_id_ref=? AND lower(address)=?"
  ).get(chainDbId, addr) as { id?: number } | undefined;

  if (walletRow?.id) {
    const positions = getDb().prepare(
      `SELECT * FROM positions
       WHERE wallet_id=? AND chain_id_ref=? AND notify_state!='closed'
       AND last_liquidity != '' AND CAST(last_liquidity AS INTEGER) > 0`
    ).all(walletRow.id, chainDbId) as any[];

    // 解析 token decimals（批量）
    const allTokenAddrs = new Set<string>();
    for (const p of positions) {
      allTokenAddrs.add(p.token0.toLowerCase());
      allTokenAddrs.add(p.token1.toLowerCase());
    }
    const tokenMeta = allTokenAddrs.size > 0
      ? await resolveTokens(client, chainDbId, [...allTokenAddrs])
      : new Map<string, { symbol: string; decimals: number }>();

    for (const p of positions) {
      try {
        const liquidity = BigInt(p.last_liquidity);
        if (liquidity === 0n) continue;
        const pool = p.pool as `0x${string}`;
        if (!pool) continue;

        const sqrtPrice = await readSqrtPrice(client, pool);
        if (sqrtPrice === null) {
          warnings.push(`仓位 #${p.token_id} 读取池子 ${pool} 价格失败，跳过`);
          continue;
        }
        const dec0 = tokenMeta.get(p.token0.toLowerCase())?.decimals ?? 18;
        const dec1 = tokenMeta.get(p.token1.toLowerCase())?.decimals ?? 18;
        const sym0 = p.token0_symbol || tokenMeta.get(p.token0.toLowerCase())?.symbol || "T0";
        const sym1 = p.token1_symbol || tokenMeta.get(p.token1.toLowerCase())?.symbol || "T1";

        const sqrtA = tickToSqrtPriceX96(p.tick_lower);
        const sqrtB = tickToSqrtPriceX96(p.tick_upper);
        const { amount0, amount1 } = getAmountsForLiquidity(sqrtPrice, sqrtA, sqrtB, liquidity, dec0, dec1);

        const amt0 = Number(amount0);
        const amt1 = Number(amount1);
        const q0 = quoteByAddr.get(p.token0.toLowerCase());
        const q1 = quoteByAddr.get(p.token1.toLowerCase());
        const v0 = q0 ? amt0 * q0.price : null;
        const v1 = q1 ? amt1 * q1.price : null;

        // 仓位价值：token0 价值 + token1 价值（任一缺报价则该项为 null）
        let positionValue: number | null = null;
        if (v0 !== null && v1 !== null) {
          positionValue = v0 + v1;
          totalUsd += positionValue;
        } else if (v0 !== null && amt1 === 0) {
          positionValue = v0;
          totalUsd += positionValue;
        } else if (v1 !== null && amt0 === 0) {
          positionValue = v1;
          totalUsd += positionValue;
        }
        // else：两端都有量但至少一端缺报价 → 无法估值

        const sourceTag = p.source === "staking" ? "·质押" : "";
        items.push({
          kind: "lp",
          symbol: `LP·#${p.token_id}(${sym0}/${sym1})${sourceTag}`,
          amount: fmtAmount(0), // LP 总量无单一数量概念，置空
          valueUsd: positionValue,
          subItems: [
            { symbol: sym0, amount: fmtAmount(amt0), valueUsd: v0 },
            { symbol: sym1, amount: fmtAmount(amt1), valueUsd: v1 },
          ],
        });
      } catch (e: any) {
        warnings.push(`仓位 #${p.token_id} 计算失败：${e?.message ?? e}`);
      }
    }
  }

  return { items, totalUsd, nativeSymbol, warnings };
}
