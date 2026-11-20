/**
 * Zia / 0G Merkl 新奖励抢跑监控哨兵（Zia Incentive Watcher）
 *
 * 极轻量监控 0G 主网（chainId=16661）的 Zia 奖励重启信号，命中后立即通过 notifyAll 推送：
 *   1. Zia 历史 Merkl 发奖钱包（0x1CaABe35...522C）：
 *      - nonce 递增（说明刚刚发起了存 W0G / approve / 建 Merkl 活动交易）
 *      - 0G 或 W0G 余额单次净增 ≥ 5,000（说明上游金库 0x0b4cff... 刚刚拨款备弹药）
 *   2. 0G 基金会/Encompassing 发奖钱包（0x075682dF...dB37）：
 *      - nonce 递增（账上趴着 ~143 万 0G，一旦动账大概率开启新激励）
 *   3. Merkl API 0G 链（chainId=16661）出现任何新的 LIVE 或 SOON 活动：
 *      - 立即推送池名、状态（LIVE/SOON）、日奖励与 APR，第一时间抢头矿
 *
 * 状态持久化在 SQLite app_settings（key: zia_watcher_state_v1），防重启误报与重复刷屏。
 */
import { createPublicClient, formatUnits, http, parseAbi, type Address, type PublicClient } from "viem";
import { getClient, listChains } from "../chains";
import { getSetting, setSetting } from "../db/settings";
import { notifyAll } from "../notify";

const OG_CHAIN_ID = 16661;
const OG_FALLBACK_RPC = "https://evmrpc.0g.ai";
const W0G_ADDRESS: Address = "0x1Cd0690fF9a693f5EF2dD976660a8dAFc81A109c";

const WATCHED_WALLETS: ReadonlyArray<{
  key: string;
  label: string;
  address: Address;
  /** 仅关注 nonce 变化，还是同时关注大额入账（0G/W0G 净增 >= threshold） */
  inflowAlertThresholdOg: number;
}> = [
  {
    key: "zia_creator",
    label: "Zia Merkl 发奖钱包",
    address: "0x1CaABe35c02Bd63E216438BAeD632D29820c522C",
    inflowAlertThresholdOg: 5_000,
  },
  {
    key: "og_foundation_creator",
    label: "0G Merkl 基金会发奖钱包",
    address: "0x075682dF0244525Ede907990C5F0ED521300dB37",
    inflowAlertThresholdOg: 50_000,
  },
];

const ERC20_BALANCE_ABI = parseAbi([
  "function balanceOf(address) view returns (uint256)",
]);

const SETTING_STATE_KEY = "zia_watcher_state_v1";
const SETTING_ENABLED_KEY = "zia_watcher_enabled";
const MIN_SCAN_INTERVAL_MS = 60_000; // 最快每 60 秒检查一次，避免 30s 合并扫描造成额外负担
const GLOBAL_WATCHER_KEY = "__lpMonitorZiaIncentiveWatcher__";

interface PersistedWalletSnapshot {
  nonce: number;
  og: number;
  w0g: number;
}

interface PersistedWatcherState {
  wallets: Record<string, PersistedWalletSnapshot>;
  seenOppIds: string[];
  initializedAt: string;
  updatedAt: string;
}

export interface WatchedWalletStatus {
  key: string;
  label: string;
  address: string;
  nonce: number;
  og: number;
  w0g: number;
}

export interface ZiaMerklOppBrief {
  id: string;
  name: string;
  status: "LIVE" | "SOON";
  dailyRewards: number;
  tvl: number;
  apr: number;
}

export interface ZiaIncentiveWatcherSummary {
  enabled: boolean;
  checkedAt: string;
  durationMs: number;
  wallets: WatchedWalletStatus[];
  liveOpportunities: ZiaMerklOppBrief[];
  soonOpportunities: ZiaMerklOppBrief[];
  alertsSent: number;
  events: string[];
  error?: string;
}

interface WatcherGlobalState {
  lastSummary: ZiaIncentiveWatcherSummary | null;
  lastRunMs: number;
  running: boolean;
  fallbackClient: PublicClient | null;
}

function getGlobalState(): WatcherGlobalState {
  const g = globalThis as any;
  if (!g[GLOBAL_WATCHER_KEY]) {
    g[GLOBAL_WATCHER_KEY] = {
      lastSummary: null,
      lastRunMs: 0,
      running: false,
      fallbackClient: null,
    } as WatcherGlobalState;
  }
  return g[GLOBAL_WATCHER_KEY] as WatcherGlobalState;
}

export function isZiaWatcherEnabled(): boolean {
  // 默认开启；如需关闭可在 app_settings 将 zia_watcher_enabled 设为 "0"
  return getSetting(SETTING_ENABLED_KEY, "1") !== "0";
}

export function getLastZiaIncentiveSummary(): ZiaIncentiveWatcherSummary | null {
  return getGlobalState().lastSummary;
}

function loadPersistedState(): PersistedWatcherState | null {
  const raw = getSetting(SETTING_STATE_KEY, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.wallets && Array.isArray(parsed.seenOppIds)) {
      return parsed as PersistedWatcherState;
    }
  } catch {
    // 忽略损坏 JSON，重新初始化基线
  }
  return null;
}

function savePersistedState(state: PersistedWatcherState): void {
  setSetting(SETTING_STATE_KEY, JSON.stringify(state));
}

function getOgClient(): PublicClient {
  try {
    const chains = listChains(false);
    const og = chains.find((c) => c.chain_id === OG_CHAIN_ID);
    if (og) {
      return getClient(og.id).client;
    }
  } catch {
    // 回退到默认 0G 公共 RPC
  }
  const gs = getGlobalState();
  if (!gs.fallbackClient) {
    gs.fallbackClient = createPublicClient({
      transport: http(OG_FALLBACK_RPC, { timeout: 12_000, retryCount: 1 }),
    });
  }
  return gs.fallbackClient;
}

async function fetchMerkl0gOpps(status: "LIVE" | "SOON"): Promise<ZiaMerklOppBrief[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(
      `https://api.merkl.xyz/v4/opportunities?chainId=${OG_CHAIN_ID}&status=${status}&items=30`,
      { signal: controller.signal, cache: "no-store" }
    );
    if (!res.ok) throw new Error(`Merkl HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) return [];
    return data.map((o: any) => ({
      id: String(o.id ?? ""),
      name: String(o.name ?? "Unknown Pool"),
      status,
      dailyRewards: Number(o.dailyRewards ?? 0) || 0,
      tvl: Number(o.tvl ?? 0) || 0,
      apr: Number(o.apr ?? 0) || 0,
    })).filter((o) => o.id.length > 0);
  } finally {
    clearTimeout(timer);
  }
}

function fmtNum(n: number, decimals = 0): string {
  return n.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * 执行一次 Zia / 0G Merkl 新奖励监测（带 60 秒节流；传 force=true 可立即检查）。
 */
export async function scanZiaIncentiveWatcher(opts?: { force?: boolean }): Promise<ZiaIncentiveWatcherSummary> {
  const gs = getGlobalState();
  const nowMs = Date.now();
  const enabled = isZiaWatcherEnabled();

  if (!enabled) {
    const disabledSummary: ZiaIncentiveWatcherSummary = {
      enabled: false,
      checkedAt: new Date(nowMs).toISOString(),
      durationMs: 0,
      wallets: [],
      liveOpportunities: [],
      soonOpportunities: [],
      alertsSent: 0,
      events: [],
    };
    gs.lastSummary = disabledSummary;
    return disabledSummary;
  }

  if (!opts?.force && gs.lastSummary && nowMs - gs.lastRunMs < MIN_SCAN_INTERVAL_MS) {
    return gs.lastSummary;
  }
  if (gs.running && gs.lastSummary) {
    return gs.lastSummary;
  }

  gs.running = true;
  const t0 = Date.now();
  const events: string[] = [];
  let alertsSent = 0;
  let errMsg: string | undefined;

  const walletStatuses: WatchedWalletStatus[] = [];
  let liveOpps: ZiaMerklOppBrief[] = [];
  let soonOpps: ZiaMerklOppBrief[] = [];

  try {
    const prev = loadPersistedState();
    const isColdStart = !prev;
    const nextWallets: Record<string, PersistedWalletSnapshot> = { ...(prev?.wallets ?? {}) };
    const seenOppIds = new Set<string>(prev?.seenOppIds ?? []);

    const client = getOgClient();

    // 1. 并行检查 0G 发奖钱包链上状态 + Merkl LIVE/SOON 活动
    const [walletSettled, liveSettled, soonSettled] = await Promise.allSettled([
      Promise.all(
        WATCHED_WALLETS.map(async (w) => {
          const [nonce, natBal, w0gBal] = await Promise.all([
            client.getTransactionCount({ address: w.address }),
            client.getBalance({ address: w.address }),
            client.readContract({
              address: W0G_ADDRESS,
              abi: ERC20_BALANCE_ABI,
              functionName: "balanceOf",
              args: [w.address],
            }),
          ]);
          return {
            cfg: w,
            nonce: Number(nonce),
            og: Number(formatUnits(natBal, 18)),
            w0g: Number(formatUnits(w0gBal, 18)),
          };
        })
      ),
      fetchMerkl0gOpps("LIVE"),
      fetchMerkl0gOpps("SOON"),
    ]);

    // 2. 处理钱包异动信号
    if (walletSettled.status === "fulfilled") {
      for (const item of walletSettled.value) {
        const { cfg, nonce, og, w0g } = item;
        walletStatuses.push({
          key: cfg.key,
          label: cfg.label,
          address: cfg.address,
          nonce,
          og,
          w0g,
        });

        const old = prev?.wallets?.[cfg.key];
        nextWallets[cfg.key] = { nonce, og, w0g };

        if (!isColdStart && old) {
          const nonceDelta = nonce - old.nonce;
          const totalPrev = old.og + old.w0g;
          const totalCurr = og + w0g;
          const totalDelta = totalCurr - totalPrev;
          const w0gDelta = w0g - old.w0g;

          const reasons: string[] = [];
          if (nonceDelta > 0) {
            reasons.push(`交易计数 nonce +${nonceDelta} (${old.nonce} → ${nonce})`);
          }
          if (totalDelta >= cfg.inflowAlertThresholdOg) {
            reasons.push(`收到大额 0G/W0G 拨款 +${fmtNum(totalDelta)} 0G`);
          } else if (w0gDelta >= cfg.inflowAlertThresholdOg && nonceDelta <= 0) {
            reasons.push(`W0G 余额净增 +${fmtNum(w0gDelta)} W0G`);
          }

          if (reasons.length > 0) {
            const eventDesc = `${cfg.label}: ${reasons.join("；")}`;
            events.push(eventDesc);
            const title = `🚀 ${cfg.label}有新动作！`;
            const body = [
              `检测到 Zia/0G 激励发奖地址异动，可能即将启动新一轮 Merkl 奖励：`,
              `• 触发原因：${reasons.join("；")}`,
              `• 当前余额：${fmtNum(og)} 0G + ${fmtNum(w0g)} W0G（合计 ${fmtNum(totalCurr)} 0G）`,
              `• 地址：${cfg.address}`,
              `• 浏览器：https://chainscan.0g.ai/address/${cfg.address}`,
            ].join("\n");
            const res = await notifyAll({
              title,
              body,
              url: `https://chainscan.0g.ai/address/${cfg.address}`,
              group: "zia-incentive",
            });
            if (res.sent.length > 0) alertsSent++;
          }
        }
      }
    } else {
      errMsg = `0G wallet check: ${walletSettled.reason?.message ?? walletSettled.reason}`;
    }

    // 3. 处理 Merkl 0G 新活动信号（LIVE / SOON）
    if (liveSettled.status === "fulfilled") liveOpps = liveSettled.value;
    else errMsg = [errMsg, `Merkl LIVE: ${liveSettled.reason?.message ?? liveSettled.reason}`].filter(Boolean).join("; ");

    if (soonSettled.status === "fulfilled") soonOpps = soonSettled.value;
    else errMsg = [errMsg, `Merkl SOON: ${soonSettled.reason?.message ?? soonSettled.reason}`].filter(Boolean).join("; ");

    const allActiveOpps = [...liveOpps, ...soonOpps];
    const newlyAppeared = allActiveOpps.filter((o) => !seenOppIds.has(`${o.status}:${o.id}`));

    if (newlyAppeared.length > 0) {
      for (const o of newlyAppeared) {
        seenOppIds.add(`${o.status}:${o.id}`);
      }
      const lines = newlyAppeared
        .sort((a, b) => b.dailyRewards - a.dailyRewards)
        .slice(0, 8)
        .map(
          (o) =>
            `• [${o.status}] ${o.name} | 日奖 $${fmtNum(o.dailyRewards)} | TVL $${fmtNum(o.tvl)} | APR ${o.apr.toFixed(1)}%`
        );
      if (newlyAppeared.length > 8) {
        lines.push(`• ... 其余 ${newlyAppeared.length - 8} 个池请前往 Merkl 查看`);
      }

      events.push(`Merkl 0G 发现 ${newlyAppeared.length} 个新活动`);
      const res = await notifyAll({
        title: `🎯 0G / Zia Merkl 上线 ${newlyAppeared.length} 个新奖励！`,
        body: [
          `0G 链（16661）Merkl 检测到新激励池，可第一时间查看抢头矿：`,
          ...lines,
          `链接：https://app.merkl.xyz/?chain=${OG_CHAIN_ID}`,
        ].join("\n"),
        url: `https://app.merkl.xyz/?chain=${OG_CHAIN_ID}`,
        group: "zia-incentive",
      });
      if (res.sent.length > 0) alertsSent++;
    }

    // 仅保留当前仍处于 LIVE/SOON 的 ID（若将来一轮结束后再次重开同 ID 活动也能再次提醒）
    const activeKeySet = new Set(allActiveOpps.map((o) => `${o.status}:${o.id}`));
    const cleanedSeenIds = [...seenOppIds].filter((k) => activeKeySet.has(k));

    const nowIso = new Date().toISOString();
    savePersistedState({
      wallets: nextWallets,
      seenOppIds: cleanedSeenIds,
      initializedAt: prev?.initializedAt ?? nowIso,
      updatedAt: nowIso,
    });
  } catch (e: any) {
    errMsg = e?.message ?? String(e);
  } finally {
    gs.running = false;
    gs.lastRunMs = Date.now();
  }

  const summary: ZiaIncentiveWatcherSummary = {
    enabled: true,
    checkedAt: new Date().toISOString(),
    durationMs: Date.now() - t0,
    wallets: walletStatuses,
    liveOpportunities: liveOpps,
    soonOpportunities: soonOpps,
    alertsSent,
    events,
    error: errMsg,
  };
  gs.lastSummary = summary;
  return summary;
}
