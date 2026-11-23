/**
 * 仓位真实收益成本台账引擎（开仓投入 vs 当前持仓 + 已领手续费 + 待领手续费）
 *
 * 自动链上追溯流程（支持 Ethereum / Base / Optimism / Arbitrum / Polygon / Unichain）：
 *   1. 通过 Blockscout v2 NFT Transfer 接口查 tokenId 的 Mint 交易（0x0 -> owner）
 *   2. 解析该交易中的原生币（tx.value - 退回 internal tx）与 ERC20 转账，得出精确开仓投入 (entryAmt0, entryAmt1)
 *   3. 用 Binance 历史 1m K 线拉取开仓那一分钟的精确历史币价，算出开仓投入总 USD 价值 (entryValueUsd)
 *   4. 增量扫描 owner 之后发往 PositionManager 的交易，自动累计：
 *      - V4 ModifyLiquidity (liquidityDelta == 0 领费 / >0 加仓 / <0 减仓)
 *      - V3 IncreaseLiquidity / DecreaseLiquidity / Collect
 *   5. 不支持 Blockscout 的链自动回退为首次发现快照 + 领费回落自动累加，同时支持前端手动校准与一键重查。
 */
import { formatUnits, pad, toHex } from "viem";
import { getDb } from "../db";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

const BLOCKSCOUT_API_MAP: Record<number, string> = {
  1: "https://eth.blockscout.com/api/v2",
  10: "https://optimism.blockscout.com/api/v2",
  130: "https://unichain.blockscout.com/api/v2",
  137: "https://polygon.blockscout.com/api/v2",
  8453: "https://base.blockscout.com/api/v2",
  42161: "https://arbitrum.blockscout.com/api/v2",
};

// Event topic0 hashes
const TOPIC_V4_MODIFY_LIQ =
  "0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec";
const TOPIC_V3_INCREASE_LIQ =
  "0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f";
const TOPIC_V3_DECREASE_LIQ =
  "0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4";
const TOPIC_V3_COLLECT =
  "0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01";

const STABLE_SYMBOLS = new Set([
  "USDC",
  "USDC.E",
  "USDBC",
  "USDT",
  "DAI",
  "USDS",
  "BOLD",
  "USDG",
  "FDUSD",
  "PYUSD",
  "FRAX",
  "CRVUSD",
  "USDE",
]);

const BINANCE_SYMBOL_ALIASES: Record<string, string> = {
  ETH: "ETHUSDT",
  WETH: "ETHUSDT",
  STETH: "ETHUSDT",
  WBTC: "BTCUSDT",
  BTC: "BTCUSDT",
  CBBTC: "BTCUSDT",
  TBTC: "BTCUSDT",
  SOL: "SOLUSDT",
  WSOL: "SOLUSDT",
  BNB: "BNBUSDT",
  WBNB: "BNBUSDT",
  POL: "POLUSDT",
  WPOL: "POLUSDT",
  MATIC: "POLUSDT",
  WMATIC: "POLUSDT",
  ARB: "ARBUSDT",
  OP: "OPUSDT",
  LINK: "LINKUSDT",
  UNI: "UNIUSDT",
  AAVE: "AAVEUSDT",
  AVAX: "AVAXUSDT",
  WAVAX: "AVAXUSDT",
  "0G": "0GUSDT",
  W0G: "0GUSDT",
};

export interface PositionCostBasis {
  positionId: number;
  entryTxHash: string;
  entryTimestamp: number;
  entryAmt0: number;
  entryAmt1: number;
  entryPrice0Usd: number;
  entryPrice1Usd: number;
  entryValueUsd: number;
  claimedFees0: number;
  claimedFees1: number;
  claimedFeesUsd: number;
  lastSyncedBlock: number;
  source: "onchain" | "snapshot" | "manual";
  updatedAt: string;
}

interface CostBasisDbRow {
  position_id: number;
  entry_tx_hash: string;
  entry_timestamp: number;
  entry_amt0: number;
  entry_amt1: number;
  entry_price0_usd: number;
  entry_price1_usd: number;
  entry_value_usd: number;
  claimed_fees0: number;
  claimed_fees1: number;
  claimed_fees_usd: number;
  last_synced_block: number;
  source: string;
  updated_at: string;
}

function rowToModel(r: CostBasisDbRow): PositionCostBasis {
  return {
    positionId: r.position_id,
    entryTxHash: r.entry_tx_hash || "",
    entryTimestamp: Number(r.entry_timestamp) || 0,
    entryAmt0: Number(r.entry_amt0) || 0,
    entryAmt1: Number(r.entry_amt1) || 0,
    entryPrice0Usd: Number(r.entry_price0_usd) || 0,
    entryPrice1Usd: Number(r.entry_price1_usd) || 0,
    entryValueUsd: Number(r.entry_value_usd) || 0,
    claimedFees0: Number(r.claimed_fees0) || 0,
    claimedFees1: Number(r.claimed_fees1) || 0,
    claimedFeesUsd: Number(r.claimed_fees_usd) || 0,
    lastSyncedBlock: Number(r.last_synced_block) || 0,
    source: (r.source === "onchain" || r.source === "manual" ? r.source : "snapshot"),
    updatedAt: r.updated_at || "",
  };
}

export function getCostBasis(positionId: number): PositionCostBasis | null {
  const db = getDb();
  const row = db
    .prepare("SELECT * FROM position_cost_basis WHERE position_id=?")
    .get(positionId) as CostBasisDbRow | undefined;
  return row ? rowToModel(row) : null;
}

export function upsertCostBasis(b: PositionCostBasis): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO position_cost_basis
      (position_id, entry_tx_hash, entry_timestamp, entry_amt0, entry_amt1,
       entry_price0_usd, entry_price1_usd, entry_value_usd,
       claimed_fees0, claimed_fees1, claimed_fees_usd,
       last_synced_block, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(position_id) DO UPDATE SET
       entry_tx_hash=excluded.entry_tx_hash,
       entry_timestamp=excluded.entry_timestamp,
       entry_amt0=excluded.entry_amt0,
       entry_amt1=excluded.entry_amt1,
       entry_price0_usd=excluded.entry_price0_usd,
       entry_price1_usd=excluded.entry_price1_usd,
       entry_value_usd=excluded.entry_value_usd,
       claimed_fees0=excluded.claimed_fees0,
       claimed_fees1=excluded.claimed_fees1,
       claimed_fees_usd=excluded.claimed_fees_usd,
       last_synced_block=excluded.last_synced_block,
       source=excluded.source,
       updated_at=datetime('now')`
  ).run(
    b.positionId,
    b.entryTxHash,
    b.entryTimestamp,
    b.entryAmt0,
    b.entryAmt1,
    b.entryPrice0Usd,
    b.entryPrice1Usd,
    b.entryValueUsd,
    b.claimedFees0,
    b.claimedFees1,
    b.claimedFeesUsd,
    b.lastSyncedBlock,
    b.source
  );
}

/** 前端手动校准开仓成本与已领手续费（标记为 manual，不被自动覆盖）。 */
export function saveManualCostBasis(input: {
  positionId: number;
  entryAmt0: number;
  entryAmt1: number;
  entryValueUsd: number;
  entryPrice0Usd?: number;
  entryPrice1Usd?: number;
  claimedFees0: number;
  claimedFees1: number;
  claimedFeesUsd?: number;
  entryTimestamp?: number;
}): PositionCostBasis {
  const existing = getCostBasis(input.positionId);
  const next: PositionCostBasis = {
    positionId: input.positionId,
    entryTxHash: existing?.entryTxHash || "",
    entryTimestamp:
      input.entryTimestamp && input.entryTimestamp > 0
        ? input.entryTimestamp
        : existing?.entryTimestamp || Date.now(),
    entryAmt0: Math.max(0, Number(input.entryAmt0) || 0),
    entryAmt1: Math.max(0, Number(input.entryAmt1) || 0),
    entryPrice0Usd:
      input.entryPrice0Usd !== undefined
        ? Math.max(0, Number(input.entryPrice0Usd) || 0)
        : existing?.entryPrice0Usd || 0,
    entryPrice1Usd:
      input.entryPrice1Usd !== undefined
        ? Math.max(0, Number(input.entryPrice1Usd) || 0)
        : existing?.entryPrice1Usd || 0,
    entryValueUsd: Math.max(0, Number(input.entryValueUsd) || 0),
    claimedFees0: Math.max(0, Number(input.claimedFees0) || 0),
    claimedFees1: Math.max(0, Number(input.claimedFees1) || 0),
    claimedFeesUsd:
      input.claimedFeesUsd !== undefined
        ? Math.max(0, Number(input.claimedFeesUsd) || 0)
        : existing?.claimedFeesUsd || 0,
    lastSyncedBlock: existing?.lastSyncedBlock || 0,
    source: "manual",
    updatedAt: new Date().toISOString(),
  };
  upsertCostBasis(next);
  return next;
}

async function fetchJson(url: string, timeoutMs = 9_000): Promise<any | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 查指定时间戳（毫秒）某代币在 Binance 的历史 1 分钟收盘价（USD）。 */
export async function fetchHistoricalUsdPrice(symbol: string, timestampMs: number): Promise<number> {
  const sym = (symbol || "").trim().toUpperCase();
  if (!sym) return 0;
  if (STABLE_SYMBOLS.has(sym)) return 1;

  const pair = BINANCE_SYMBOL_ALIASES[sym] || `${sym.replace(/^W(?=[A-Z]{2,})/, "")}USDT`;
  const start = Math.max(0, Math.floor(timestampMs) - 60_000);
  const klines = await fetchJson(
    `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(pair)}&interval=1m&startTime=${start}&limit=2`,
    6_000
  );
  if (Array.isArray(klines) && klines.length > 0) {
    const closePrice = Number(klines[0]?.[4]);
    if (Number.isFinite(closePrice) && closePrice > 0) return closePrice;
  }
  // 回退查实时价
  const spot = await fetchJson(
    `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(pair)}`,
    5_000
  );
  const spotPrice = Number(spot?.price);
  return Number.isFinite(spotPrice) && spotPrice > 0 ? spotPrice : 0;
}

/**
 * 解析一笔交易中 owner 相对于池子/NPM 的净流出（正数=用户投入，负数=用户收回）。
 */
async function extractTxNetFlows(
  baseUrl: string,
  txHash: string,
  ownerLower: string,
  token0Lower: string,
  token1Lower: string,
  dec0: number,
  dec1: number
): Promise<{ netOut0: number; netOut1: number; timestampMs: number } | null> {
  const [txInfo, ttRes, itxRes] = await Promise.all([
    fetchJson(`${baseUrl}/transactions/${txHash}`),
    fetchJson(`${baseUrl}/transactions/${txHash}/token-transfers`),
    fetchJson(`${baseUrl}/transactions/${txHash}/internal-transactions`),
  ]);
  if (!txInfo) return null;

  const timestampMs = Date.parse(txInfo.timestamp || "") || Date.now();
  const transfers: any[] = Array.isArray(ttRes?.items) ? ttRes.items : [];
  const internals: any[] = Array.isArray(itxRes?.items) ? itxRes.items : [];

  const calcFlow = (tokenAddrLower: string, decimals: number): number => {
    if (tokenAddrLower === ZERO_ADDR) {
      let sent = 0n;
      let recv = 0n;
      if ((txInfo.from?.hash || "").toLowerCase() === ownerLower) {
        sent += BigInt(txInfo.value || "0");
      }
      for (const it of internals) {
        const val = BigInt(it.value || "0");
        if (val <= 0n) continue;
        const from = (it.from?.hash || "").toLowerCase();
        const to = (it.to?.hash || "").toLowerCase();
        if (to === ownerLower && from !== ownerLower) recv += val;
        else if (from === ownerLower && to !== ownerLower) sent += val;
      }
      const diff = sent - recv;
      return diff >= 0n
        ? Number(formatUnits(diff, decimals))
        : -Number(formatUnits(-diff, decimals));
    }

    let sent = 0n;
    let recv = 0n;
    for (const t of transfers) {
      const addr = (t.token?.address_hash || t.token?.address || "").toLowerCase();
      if (addr !== tokenAddrLower) continue;
      const rawStr = t.total?.value;
      if (!rawStr || !/^\d+$/.test(String(rawStr))) continue;
      const val = BigInt(rawStr);
      const from = (t.from?.hash || "").toLowerCase();
      const to = (t.to?.hash || "").toLowerCase();
      if (from === ownerLower && to !== ownerLower) sent += val;
      else if (to === ownerLower && from !== ownerLower) recv += val;
    }
    const diff = sent - recv;
    return diff >= 0n
      ? Number(formatUnits(diff, decimals))
      : -Number(formatUnits(-diff, decimals));
  };

  return {
    netOut0: calcFlow(token0Lower, dec0),
    netOut1: calcFlow(token1Lower, dec1),
    timestampMs,
  };
}

function readSignedInt256Hex(hex64: string): bigint {
  const u = BigInt("0x" + hex64);
  const signBit = 1n << 255n;
  return u >= signBit ? u - (1n << 256n) : u;
}

function readUint256Hex(hex64: string): bigint {
  return BigInt("0x" + hex64);
}

const GLOBAL_PNL_SYNC_KEY = "__lpMonitorPnlSyncTs__";
const PNL_SYNC_INTERVAL_MS = 10 * 60_000; // 常规 10 分钟增量同步一次，避免高频打 Blockscout

function getSyncTsMap(): Record<number, number> {
  const g = globalThis as any;
  if (!g[GLOBAL_PNL_SYNC_KEY]) g[GLOBAL_PNL_SYNC_KEY] = {};
  return g[GLOBAL_PNL_SYNC_KEY] as Record<number, number>;
}

export interface SyncCostBasisParams {
  positionId: number;
  chainId: number;
  dexType: string;
  npm: string;
  ownerAddress: string;
  tokenId: string;
  token0: string;
  token1: string;
  symbol0: string;
  symbol1: string;
  dec0: number;
  dec1: number;
  /** 当不支持 Blockscout 时，用于首次快照兜底 */
  fallbackAmt0?: number;
  fallbackAmt1?: number;
  fallbackCreatedMs?: number;
  forceResync?: boolean;
}

/**
 * 获取并按需增量同步某仓位的真实开仓成本与累计已领取手续费。
 */
export async function ensurePositionCostBasis(
  params: SyncCostBasisParams
): Promise<PositionCostBasis | null> {
  const existing = getCostBasis(params.positionId);

  // 手动校准模式除非用户显式要求强制重查，否则绝不覆盖
  if (existing && existing.source === "manual" && !params.forceResync) {
    return existing;
  }

  const syncMap = getSyncTsMap();
  const now = Date.now();
  if (
    existing &&
    !params.forceResync &&
    syncMap[params.positionId] &&
    now - syncMap[params.positionId] < PNL_SYNC_INTERVAL_MS
  ) {
    return existing;
  }
  syncMap[params.positionId] = now;

  const baseUrl = BLOCKSCOUT_API_MAP[params.chainId];
  const token0Lower = params.token0.toLowerCase();
  const token1Lower = params.token1.toLowerCase();
  const npmLower = params.npm.toLowerCase();

  // 无 Blockscout 的链：若还没有台账，自动落一条首次快照
  if (!baseUrl) {
    if (existing) return existing;
    if (
      params.fallbackAmt0 !== undefined &&
      params.fallbackAmt1 !== undefined &&
      (params.fallbackAmt0 > 0 || params.fallbackAmt1 > 0)
    ) {
      const ts = params.fallbackCreatedMs || now;
      const [p0, p1] = await Promise.all([
        fetchHistoricalUsdPrice(params.symbol0, ts),
        fetchHistoricalUsdPrice(params.symbol1, ts),
      ]);
      const snap: PositionCostBasis = {
        positionId: params.positionId,
        entryTxHash: "",
        entryTimestamp: ts,
        entryAmt0: params.fallbackAmt0,
        entryAmt1: params.fallbackAmt1,
        entryPrice0Usd: p0,
        entryPrice1Usd: p1,
        entryValueUsd: params.fallbackAmt0 * p0 + params.fallbackAmt1 * p1,
        claimedFees0: 0,
        claimedFees1: 0,
        claimedFeesUsd: 0,
        lastSyncedBlock: 0,
        source: "snapshot",
        updatedAt: new Date(now).toISOString(),
      };
      upsertCostBasis(snap);
      return snap;
    }
    return null;
  }

  try {
    let basis: PositionCostBasis | null =
      !params.forceResync && existing && existing.source === "onchain" ? { ...existing } : null;
    let ownerLower = (params.ownerAddress || "").toLowerCase();

    // 1. 若尚未建立链上开仓成本（或用户点强制重查），先查 Mint 交易
    if (!basis) {
      const transfersRes = await fetchJson(
        `${baseUrl}/tokens/${params.npm}/instances/${params.tokenId}/transfers`
      );
      const items: any[] = Array.isArray(transfersRes?.items) ? transfersRes.items : [];
      const mintItem = items.find(
        (x) => (x.from?.hash || "").toLowerCase() === ZERO_ADDR
      );
      if (!mintItem?.transaction_hash) {
        return existing;
      }

      if (mintItem.to?.hash) ownerLower = mintItem.to.hash.toLowerCase();
      const mintTxHash: string = mintItem.transaction_hash;
      const mintBlock: number = Number(mintItem.block_number) || 0;

      const flow = await extractTxNetFlows(
        baseUrl,
        mintTxHash,
        ownerLower,
        token0Lower,
        token1Lower,
        params.dec0,
        params.dec1
      );
      if (!flow) return existing;

      const entryAmt0 = Math.max(0, flow.netOut0);
      const entryAmt1 = Math.max(0, flow.netOut1);
      const [p0, p1] = await Promise.all([
        fetchHistoricalUsdPrice(params.symbol0, flow.timestampMs),
        fetchHistoricalUsdPrice(params.symbol1, flow.timestampMs),
      ]);

      basis = {
        positionId: params.positionId,
        entryTxHash: mintTxHash,
        entryTimestamp: flow.timestampMs,
        entryAmt0,
        entryAmt1,
        entryPrice0Usd: p0,
        entryPrice1Usd: p1,
        entryValueUsd: entryAmt0 * p0 + entryAmt1 * p1,
        claimedFees0: 0,
        claimedFees1: 0,
        claimedFeesUsd: 0,
        lastSyncedBlock: mintBlock,
        source: "onchain",
        updatedAt: new Date(now).toISOString(),
      };
    }

    // 2. 增量扫描 mint 之后 owner 发往 PositionManager 的交易，累计已领手续费 / 加减仓
    if (ownerLower && /^0x[0-9a-f]{40}$/.test(ownerLower)) {
      const txListRes = await fetchJson(`${baseUrl}/addresses/${ownerLower}/transactions`);
      const txs: any[] = Array.isArray(txListRes?.items) ? txListRes.items : [];
      const candidates = txs
        .filter((t) => {
          const blk = Number(t.block_number) || 0;
          const to = (t.to?.hash || "").toLowerCase();
          return (
            blk > basis!.lastSyncedBlock &&
            to === npmLower &&
            (t.result === "success" || t.status === "ok")
          );
        })
        .sort((a, b) => (Number(a.block_number) || 0) - (Number(b.block_number) || 0));

      const tokenIdBig = BigInt(params.tokenId);
      const tokenIdTopic = pad(toHex(tokenIdBig), { size: 32 }).toLowerCase();
      const tokenIdHex64 = tokenIdTopic.slice(2);
      let maxSeenBlock = basis.lastSyncedBlock;

      for (const tx of candidates) {
        const blk = Number(tx.block_number) || 0;
        if (blk > maxSeenBlock) maxSeenBlock = blk;

        const logsRes = await fetchJson(`${baseUrl}/transactions/${tx.hash}/logs`);
        const logs: any[] = Array.isArray(logsRes?.items) ? logsRes.items : [];
        if (logs.length === 0) continue;

        if (params.dexType === "v4") {
          let touched = false;
          let totalLiqDelta = 0n;
          for (const lg of logs) {
            const topic0 = (lg.topics?.[0] || "").toLowerCase();
            if (topic0 !== TOPIC_V4_MODIFY_LIQ) continue;
            const rawData = (lg.data || "").replace(/^0x/, "").toLowerCase();
            if (rawData.length < 256) continue;
            // data = tickLower(64) + tickUpper(64) + liquidityDelta(64) + salt(64)
            const saltHex = rawData.slice(192, 256);
            if (saltHex !== tokenIdHex64) continue;
            touched = true;
            totalLiqDelta += readSignedInt256Hex(rawData.slice(128, 192));
          }
          if (!touched) continue;

          const flow = await extractTxNetFlows(
            baseUrl,
            tx.hash,
            ownerLower,
            token0Lower,
            token1Lower,
            params.dec0,
            params.dec1
          );
          if (!flow) continue;
          const [p0, p1] = await Promise.all([
            fetchHistoricalUsdPrice(params.symbol0, flow.timestampMs),
            fetchHistoricalUsdPrice(params.symbol1, flow.timestampMs),
          ]);

          if (totalLiqDelta === 0n) {
            // 纯领取手续费：netOut < 0 表示用户净收到
            const c0 = Math.max(0, -flow.netOut0);
            const c1 = Math.max(0, -flow.netOut1);
            basis.claimedFees0 += c0;
            basis.claimedFees1 += c1;
            basis.claimedFeesUsd += c0 * p0 + c1 * p1;
          } else if (totalLiqDelta > 0n) {
            // 加仓
            const add0 = Math.max(0, flow.netOut0);
            const add1 = Math.max(0, flow.netOut1);
            basis.entryAmt0 += add0;
            basis.entryAmt1 += add1;
            basis.entryValueUsd += add0 * p0 + add1 * p1;
          } else {
            // 减仓（可能伴随领费，直接按净回流扣减投入成本，确保总真实收益公式恒等精确）
            const out0 = Math.max(0, -flow.netOut0);
            const out1 = Math.max(0, -flow.netOut1);
            basis.entryAmt0 = Math.max(0, basis.entryAmt0 - out0);
            basis.entryAmt1 = Math.max(0, basis.entryAmt1 - out1);
            basis.entryValueUsd = Math.max(0, basis.entryValueUsd - (out0 * p0 + out1 * p1));
          }
        } else {
          // V3: 直接解析 IncreaseLiquidity / DecreaseLiquidity / Collect 事件
          let inc0 = 0n, inc1 = 0n;
          let dec0Raw = 0n, dec1Raw = 0n;
          let col0 = 0n, col1 = 0n;
          let touched = false;

          for (const lg of logs) {
            const t0 = (lg.topics?.[0] || "").toLowerCase();
            const t1 = (lg.topics?.[1] || "").toLowerCase();
            if (t1 !== tokenIdTopic) continue;
            const rawData = (lg.data || "").replace(/^0x/, "");
            if (rawData.length < 192) continue;

            if (t0 === TOPIC_V3_INCREASE_LIQ) {
              touched = true;
              inc0 += readUint256Hex(rawData.slice(64, 128));
              inc1 += readUint256Hex(rawData.slice(128, 192));
            } else if (t0 === TOPIC_V3_DECREASE_LIQ) {
              touched = true;
              dec0Raw += readUint256Hex(rawData.slice(64, 128));
              dec1Raw += readUint256Hex(rawData.slice(128, 192));
            } else if (t0 === TOPIC_V3_COLLECT) {
              touched = true;
              col0 += readUint256Hex(rawData.slice(64, 128));
              col1 += readUint256Hex(rawData.slice(128, 192));
            }
          }
          if (!touched) continue;

          const tsMs = Date.parse(tx.timestamp || "") || now;
          const [p0, p1] = await Promise.all([
            fetchHistoricalUsdPrice(params.symbol0, tsMs),
            fetchHistoricalUsdPrice(params.symbol1, tsMs),
          ]);

          if (inc0 > 0n || inc1 > 0n) {
            const a0 = Number(formatUnits(inc0, params.dec0));
            const a1 = Number(formatUnits(inc1, params.dec1));
            basis.entryAmt0 += a0;
            basis.entryAmt1 += a1;
            basis.entryValueUsd += a0 * p0 + a1 * p1;
          }
          if (dec0Raw > 0n || dec1Raw > 0n) {
            const d0 = Number(formatUnits(dec0Raw, params.dec0));
            const d1 = Number(formatUnits(dec1Raw, params.dec1));
            basis.entryAmt0 = Math.max(0, basis.entryAmt0 - d0);
            basis.entryAmt1 = Math.max(0, basis.entryAmt1 - d1);
            basis.entryValueUsd = Math.max(0, basis.entryValueUsd - (d0 * p0 + d1 * p1));
          }
          const fee0Raw = col0 > dec0Raw ? col0 - dec0Raw : 0n;
          const fee1Raw = col1 > dec1Raw ? col1 - dec1Raw : 0n;
          if (fee0Raw > 0n || fee1Raw > 0n) {
            const f0 = Number(formatUnits(fee0Raw, params.dec0));
            const f1 = Number(formatUnits(fee1Raw, params.dec1));
            basis.claimedFees0 += f0;
            basis.claimedFees1 += f1;
            basis.claimedFeesUsd += f0 * p0 + f1 * p1;
          }
        }
      }

      basis.lastSyncedBlock = maxSeenBlock;
    }

    basis.updatedAt = new Date(now).toISOString();
    upsertCostBasis(basis);
    return basis;
  } catch {
    return existing;
  }
}

/**
 * 兜底：对于非 Blockscout 链（source === 'snapshot'），当检测到未领手续费突然回落（已领取）时，
 * 自动把上次记录的未领手续费累加进 claimed_fees0/1。
 */
export function recordFallbackClaimedFees(
  positionId: number,
  deltaFees0: number,
  deltaFees1: number,
  p0Usd = 0,
  p1Usd = 0
): void {
  const existing = getCostBasis(positionId);
  if (!existing || existing.source !== "snapshot") return;
  existing.claimedFees0 += Math.max(0, deltaFees0);
  existing.claimedFees1 += Math.max(0, deltaFees1);
  existing.claimedFeesUsd += Math.max(0, deltaFees0) * p0Usd + Math.max(0, deltaFees1) * p1Usd;
  upsertCostBasis(existing);
}
