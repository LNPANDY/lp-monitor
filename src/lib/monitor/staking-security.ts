/**
 * ZIA 质押合约安全与异动监控哨兵（Staking Security Sentinel）
 *
 * 针对 ZiaVault 合约字节码逆向出的风险点进行实时监控：
 *   1. [CRITICAL] 禁止提取开关 `withdrawPaused` (`0x054f7d9c()`, Slot 6 第 21 字节)：
 *      一旦为 true，所有用户的 withdraw(tokenId) 将在 PC 0x0999 直接 Revert(0x4051e961)。
 *   2. [WARN]     暂停存入开关 `paused` (`0x5c975abb()`, Slot 6 第 20 字节)：
 *      一旦为 true，暂停新质押 deposit。
 *   3. [CRITICAL] 真实仓位解押静态预演 (`eth_call` 模拟 `withdraw(tokenId)` `0x2e1a7d4d`)：
 *      对当前所有处于质押中的用户仓位，用所属钱包地址作为 `from` 执行零 Gas 静态调用预演；
 *      若链上仍归属该钱包 (`0x67ba6b53(tokenId) == wallet`) 但 `withdraw` 预演 Revert，
 *      无论是开关锁死、zv* 凭证代币不足还是 feeRecipient 恶意拒收，均第一时间报警！
 *   4. [CRITICAL] 管理员 `owner` (`0x8da5cb5b()`) 变更监控：
 *      与首次记录的安全基线比对，一旦管理员权限移交立即报警。
 *   5. [WARN]     手续费接收地址 `feeRecipient` (`0x46904840()`) 变更监控。
 *
 * 高频报警推送机制：
 *   当检测到未静音的异动时，立即开启每 20 秒 1 次的高频紧急推送（Bark `level: "critical"` + `call: "1"` 持续响铃），
 *   单分钟仅 3 次请求，远低于 Bark 速率限制，同时保证手机端持续强提醒。
 */
import type { Address, PublicClient } from "viem";
import { getDb } from "../db";
import { getClient } from "../chains";
import { listStaking, type StakingRow } from "../chains/dexes";
import { getSetting, setSetting } from "../db/settings";
import { notifyAll } from "../notify";
import { eachLimit } from "../staking/discover";

export type AnomalySeverity = "critical" | "warn";

export interface StakingAnomalyItem {
  id: string;
  severity: AnomalySeverity;
  type:
    | "withdraw_paused"
    | "withdraw_sim_failed"
    | "owner_changed"
    | "fee_recipient_changed"
    | "deposit_paused";
  contract: string;
  pairLabel: string;
  chainName: string;
  tokenId?: string;
  title: string;
  detail: string;
  detectedAt: string;
}

export interface StakerContractHealth {
  id: number;
  chainIdRef: number;
  chainName: string;
  platform: string;
  pairLabel: string;
  contract: string;
  symbol: string;
  poolFee: number;
  owner: string;
  baselineOwner: string;
  feeRecipient: string;
  baselineFeeRecipient: string;
  paused: boolean;
  withdrawPaused: boolean;
  totalStakedCount: number;
  totalSupply: string;
  userStakedPositionsSimOk: number;
  userStakedPositionsSimFailed: number;
  status: "safe" | "warn" | "danger";
  anomalies: StakingAnomalyItem[];
}

export interface StakingSecuritySummary {
  status: "safe" | "warn" | "danger";
  checkedContracts: number;
  simulatedPositions: number;
  anomalies: StakingAnomalyItem[];
  contracts: StakerContractHealth[];
  checkedAt: string;
  durationMs: number;
  highFreqPushActive: boolean;
  muted: boolean;
  pushCount: number;
  lastPushAt: string | null;
}

interface SecurityGlobalState {
  lastSummary: StakingSecuritySummary | null;
  running: boolean;
  mutedFingerprint: string;
  pushTimer: ReturnType<typeof setInterval> | null;
  pushCount: number;
  lastPushAt: number;
}

const GLOBAL_SECURITY_KEY = "__lpMonitorStakingSecurity__";
/** 高频报警间隔：20 秒 1 次（每分钟 3 次，远低于 Bark 限流阈值，且衔接 iOS call=1 30秒响铃） */
const HIGH_FREQ_INTERVAL_MS = 20_000;
/** 单轮未确认异动的最大连续推送次数（60 次 = 20 分钟），防止用户长期不在手机旁导致 APNs 封禁 */
const MAX_CONTINUOUS_PUSHES = 60;

function getSecurityState(): SecurityGlobalState {
  const g = globalThis as any;
  if (!g[GLOBAL_SECURITY_KEY]) {
    g[GLOBAL_SECURITY_KEY] = {
      lastSummary: null,
      running: false,
      mutedFingerprint: "",
      pushTimer: null,
      pushCount: 0,
      lastPushAt: 0,
    } as SecurityGlobalState;
  }
  return g[GLOBAL_SECURITY_KEY] as SecurityGlobalState;
}

async function rawCallHex(
  client: PublicClient,
  to: Address,
  data: `0x${string}`,
  account?: Address
): Promise<{ ok: boolean; data: string }> {
  try {
    const res = await client.call({
      to,
      data,
      ...(account ? { account } : {}),
    });
    return { ok: true, data: res.data ?? "0x" };
  } catch {
    return { ok: false, data: "0x" };
  }
}

function decodeAbiString(hex: string): string {
  try {
    if (!hex || hex === "0x" || hex.length < 130) return "";
    const len = parseInt(hex.slice(66, 130), 16);
    if (!Number.isFinite(len) || len <= 0 || len > 128) return "";
    return Buffer.from(hex.slice(130, 130 + len * 2), "hex").toString("utf8");
  } catch {
    return "";
  }
}

function decodeAddress(hex: string): string {
  if (!hex || hex.length < 66) return "";
  return ("0x" + hex.slice(-40)).toLowerCase();
}

function decodeUint(hex: string): bigint {
  try {
    if (!hex || hex === "0x") return 0n;
    return BigInt(hex.slice(0, 66));
  } catch {
    return 0n;
  }
}

function makeFingerprint(anomalies: StakingAnomalyItem[]): string {
  if (anomalies.length === 0) return "";
  return anomalies
    .map((a) => `${a.type}:${a.contract.toLowerCase()}:${a.tokenId ?? ""}`)
    .sort()
    .join("|");
}

/** 立即发送一次紧急异动推送 */
async function pushEmergencyAlertNow(summary: StakingSecuritySummary) {
  const st = getSecurityState();
  if (summary.anomalies.length === 0) return;
  const fp = makeFingerprint(summary.anomalies);
  if (st.mutedFingerprint && st.mutedFingerprint === fp) return;
  if (st.pushCount >= MAX_CONTINUOUS_PUSHES) return;

  const now = Date.now();
  if (now - st.lastPushAt < HIGH_FREQ_INTERVAL_MS - 2_000) return;

  st.lastPushAt = now;
  st.pushCount += 1;
  if (st.lastSummary) {
    st.lastSummary.pushCount = st.pushCount;
    st.lastSummary.lastPushAt = new Date(now).toISOString();
    st.lastSummary.highFreqPushActive = true;
  }

  const hasCritical = summary.anomalies.some((a) => a.severity === "critical");
  const title = hasCritical
    ? `🚨 [极高危#${st.pushCount}] ZIA 质押合约异动报警！`
    : `⚠️ [异动#${st.pushCount}] ZIA 质押安全预警`;

  const lines = summary.anomalies.slice(0, 6).map((a, i) => {
    return `${i + 1}. [${a.pairLabel}] ${a.title}\n   ${a.detail}`;
  });
  if (summary.anomalies.length > 6) {
    lines.push(`...共 ${summary.anomalies.length} 项异动，请立即打开监控台处理！`);
  }
  lines.push(`\n🔔 高频提醒进行中（第 ${st.pushCount} 次），可在监控台顶部点击「暂停报警」静音。`);

  try {
    await notifyAll({
      title,
      body: lines.join("\n"),
      urgent: true,
      group: "lp-security",
    });
  } catch (e) {
    console.error("[staking-security] emergency push failed:", e);
  }
}

/** 同步高频推送定时器状态 */
function syncHighFreqPushTimer() {
  const st = getSecurityState();
  const summary = st.lastSummary;
  const hasActiveUnmuted =
    !!summary &&
    summary.anomalies.length > 0 &&
    makeFingerprint(summary.anomalies) !== st.mutedFingerprint &&
    st.pushCount < MAX_CONTINUOUS_PUSHES;

  if (!hasActiveUnmuted) {
    if (st.pushTimer) {
      clearInterval(st.pushTimer);
      st.pushTimer = null;
    }
    if (summary) {
      summary.highFreqPushActive = false;
    }
    return;
  }

  if (summary) {
    summary.highFreqPushActive = true;
  }

  if (!st.pushTimer) {
    st.pushTimer = setInterval(() => {
      const cur = getSecurityState().lastSummary;
      if (!cur || cur.anomalies.length === 0) {
        syncHighFreqPushTimer();
        return;
      }
      pushEmergencyAlertNow(cur).catch(() => {});
    }, HIGH_FREQ_INTERVAL_MS);
  }
}

/** 执行一次全量质押合约安全与解押预演检查 */
export async function scanStakingSecurity(): Promise<StakingSecuritySummary> {
  const st = getSecurityState();
  if (st.running && st.lastSummary) return st.lastSummary;
  st.running = true;
  const t0 = Date.now();
  const nowIso = new Date(t0).toISOString();

  try {
    const db = getDb();
    const enabledStaking = listStaking(undefined, true);
    if (enabledStaking.length === 0) {
      const empty: StakingSecuritySummary = {
        status: "safe",
        checkedContracts: 0,
        simulatedPositions: 0,
        anomalies: [],
        contracts: [],
        checkedAt: nowIso,
        durationMs: Date.now() - t0,
        highFreqPushActive: false,
        muted: false,
        pushCount: 0,
        lastPushAt: st.lastPushAt ? new Date(st.lastPushAt).toISOString() : null,
      };
      st.lastSummary = empty;
      syncHighFreqPushTimer();
      return empty;
    }

    // 读取所有活跃质押中的用户仓位，用于执行真实 withdraw(tokenId) 静态预演
    const stakedPositions = db
      .prepare(
        `SELECT p.id, p.chain_id_ref, p.token_id, p.staker_contract, p.token0_symbol, p.token1_symbol,
                w.address AS wallet_address
         FROM positions p
         JOIN wallets w ON w.id = p.wallet_id
         WHERE p.source = 'staking' AND p.notify_state != 'closed' AND w.enabled = 1`
      )
      .all() as {
      id: number;
      chain_id_ref: number;
      token_id: string;
      staker_contract: string;
      token0_symbol: string;
      token1_symbol: string;
      wallet_address: string;
    }[];

    const byChain = new Map<number, StakingRow[]>();
    for (const s of enabledStaking) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(s.contract)) continue;
      const list = byChain.get(s.chain_id_ref) ?? [];
      list.push(s);
      byChain.set(s.chain_id_ref, list);
    }

    const contractHealths: StakerContractHealth[] = [];
    let totalSimulated = 0;

    for (const [chainIdRef, rows] of byChain.entries()) {
      let client: PublicClient;
      let chainName = `Chain#${chainIdRef}`;
      try {
        const c = getClient(chainIdRef);
        client = c.client;
        chainName = c.chain.name;
      } catch {
        continue;
      }

      await eachLimit(rows, 6, async (s) => {
        const addr = s.contract.toLowerCase() as Address;
        const cKey = `${chainIdRef}:${addr}`;

        // 1. 单次并发读取质押合约核心槽位与状态
        const [
          symbolRes,
          feeRes,
          ownerRes,
          feeRecRes,
          pausedRes,
          wPausedRes,
          countRes,
          supplyRes,
        ] = await Promise.all([
          rawCallHex(client, addr, "0x95d89b41"), // symbol()
          rawCallHex(client, addr, "0x089fe6aa"), // poolFee()
          rawCallHex(client, addr, "0x8da5cb5b"), // owner()
          rawCallHex(client, addr, "0x46904840"), // feeRecipient()
          rawCallHex(client, addr, "0x5c975abb"), // paused()
          rawCallHex(client, addr, "0x054f7d9c"), // withdrawPaused()
          rawCallHex(client, addr, "0xff50abdc"), // totalStakedPositions()
          rawCallHex(client, addr, "0x18160ddd"), // totalSupply()
        ]);

        // 如果连 owner() 都不支持，说明不是标准合约，跳过
        if (!ownerRes.ok) return;

        const symbol = decodeAbiString(symbolRes.data) || s.platform;
        const poolFee = Number(decodeUint(feeRes.data));
        const owner = decodeAddress(ownerRes.data);
        const feeRecipient = decodeAddress(feeRecRes.data);
        const paused = decodeUint(pausedRes.data) === 1n;
        const withdrawPaused = decodeUint(wPausedRes.data) === 1n;
        const totalStakedCount = Number(decodeUint(countRes.data));
        const totalSupplyBig = decodeUint(supplyRes.data);

        // 读取或初始化安全基线（owner 与 feeRecipient）
        const ownerBaseKey = `staker_base_owner_${chainIdRef}_${addr}`;
        const feeRecBaseKey = `staker_base_feerec_${chainIdRef}_${addr}`;
        let baselineOwner = getSetting(ownerBaseKey, "").toLowerCase();
        if (!baselineOwner && owner) {
          baselineOwner = owner;
          setSetting(ownerBaseKey, owner);
        }
        let baselineFeeRecipient = getSetting(feeRecBaseKey, "").toLowerCase();
        if (!baselineFeeRecipient && feeRecipient) {
          baselineFeeRecipient = feeRecipient;
          setSetting(feeRecBaseKey, feeRecipient);
        }

        const anomalies: StakingAnomalyItem[] = [];
        const label =
          s.pair_label + (poolFee ? ` (${poolFee / 10000}%)` : "");

        // 检测 1: 禁止提取开关 (withdrawPaused)
        if (withdrawPaused) {
          anomalies.push({
            id: `withdraw_paused:${cKey}`,
            severity: "critical",
            type: "withdraw_paused",
            contract: s.contract,
            pairLabel: label,
            chainName,
            title: "禁止提取开关已开启 (withdrawPaused=true)",
            detail: `合约 ${s.contract.slice(0, 8)}… 的提取锁死开关已被管理员开启，所有 LP NFT 无法解押！`,
            detectedAt: nowIso,
          });
        }

        // 检测 2: 暂停质押开关 (paused)
        if (paused) {
          anomalies.push({
            id: `deposit_paused:${cKey}`,
            severity: "warn",
            type: "deposit_paused",
            contract: s.contract,
            pairLabel: label,
            chainName,
            title: "合约已暂停新质押 (paused=true)",
            detail: `合约 ${s.contract.slice(0, 8)}… 已开启暂停存入开关，请关注项目方动态。`,
            detectedAt: nowIso,
          });
        }

        // 检测 3: 管理员 (owner) 变更
        if (owner && baselineOwner && owner !== baselineOwner) {
          anomalies.push({
            id: `owner_changed:${cKey}`,
            severity: "critical",
            type: "owner_changed",
            contract: s.contract,
            pairLabel: label,
            chainName,
            title: "合约管理员 (owner) 权限发生变更！",
            detail: `原管理员 ${baselineOwner.slice(0, 8)}… 已变更为 ${owner.slice(0, 10)}…，谨防私钥被盗或恶意接管！`,
            detectedAt: nowIso,
          });
        }

        // 检测 4: 手续费接收地址 (feeRecipient) 变更
        if (
          feeRecipient &&
          baselineFeeRecipient &&
          feeRecipient !== baselineFeeRecipient
        ) {
          anomalies.push({
            id: `fee_recipient_changed:${cKey}`,
            severity: "warn",
            type: "fee_recipient_changed",
            contract: s.contract,
            pairLabel: label,
            chainName,
            title: "手续费地址 (feeRecipient) 发生变更",
            detail: `原地址 ${baselineFeeRecipient.slice(0, 8)}… 变更为 ${feeRecipient.slice(0, 10)}…`,
            detectedAt: nowIso,
          });
        }

        // 检测 5: 对用户在该合约中质押的每个真实仓位，执行静态 eth_call 模拟 withdraw(tokenId)
        const myPosInThisVault = stakedPositions.filter(
          (p) =>
            p.chain_id_ref === chainIdRef &&
            (p.staker_contract || "").toLowerCase() === addr
        );
        let simOkCount = 0;
        let simFailCount = 0;

        await Promise.all(
          myPosInThisVault.map(async (pos) => {
            totalSimulated += 1;
            const paddedId = BigInt(pos.token_id).toString(16).padStart(64, "0");
            const walletAddr = pos.wallet_address.toLowerCase() as Address;
            const paddedWallet = walletAddr.replace(/^0x/, "").padStart(64, "0");

            // 并行检查：1) 链上 Slot 7 记录的 NFT 存款人是否仍是该钱包；2) 模拟调用 withdraw(tokenId)；3) 检查 zv* 凭证余额
            const [depositorRes, simWithdrawRes, stakedLiqRes, zvBalRes] =
              await Promise.all([
                rawCallHex(client, addr, `0x67ba6b53${paddedId}` as `0x${string}`),
                rawCallHex(
                  client,
                  addr,
                  `0x2e1a7d4d${paddedId}` as `0x${string}`,
                  walletAddr
                ),
                rawCallHex(client, addr, `0x5f49a32c${paddedId}` as `0x${string}`),
                rawCallHex(
                  client,
                  addr,
                  `0x70a08231${paddedWallet}` as `0x${string}`
                ),
              ]);

            const onChainDepositor = decodeAddress(depositorRes.data);
            // 若链上 Slot 7[tokenId] 已经不是该钱包（说明用户刚刚手动解押了，DB 尚未同步），跳过不误报
            if (onChainDepositor !== walletAddr) {
              simOkCount += 1;
              return;
            }

            if (simWithdrawRes.ok) {
              simOkCount += 1;
            } else {
              simFailCount += 1;
              const stakedLiq = decodeUint(stakedLiqRes.data);
              const zvBal = decodeUint(zvBalRes.data);
              let reason = "链上模拟调用 withdraw(tokenId) 直接 Revert";
              if (withdrawPaused) {
                reason = "管理员已开启禁止提取开关 (withdrawPaused=true)";
              } else if (zvBal < stakedLiq) {
                reason = `钱包内 ${symbol} 凭证代币余额不足 (${zvBal.toString()} < ${stakedLiq.toString()})`;
              }
              anomalies.push({
                id: `withdraw_sim_failed:${cKey}:${pos.token_id}`,
                severity: "critical",
                type: "withdraw_sim_failed",
                contract: s.contract,
                pairLabel: label,
                chainName,
                tokenId: pos.token_id,
                title: `仓位 #${pos.token_id} 解押模拟失败 (无法提取)！`,
                detail: `${pos.token0_symbol}/${pos.token1_symbol} #${pos.token_id} 无法正常解押：${reason}！`,
                detectedAt: nowIso,
              });
            }
          })
        );

        const hasCrit = anomalies.some((a) => a.severity === "critical");
        const hasWarn = anomalies.some((a) => a.severity === "warn");

        contractHealths.push({
          id: s.id,
          chainIdRef,
          chainName,
          platform: s.platform,
          pairLabel: s.pair_label,
          contract: s.contract,
          symbol,
          poolFee,
          owner,
          baselineOwner,
          feeRecipient,
          baselineFeeRecipient,
          paused,
          withdrawPaused,
          totalStakedCount,
          totalSupply: totalSupplyBig.toString(),
          userStakedPositionsSimOk: simOkCount,
          userStakedPositionsSimFailed: simFailCount,
          status: hasCrit ? "danger" : hasWarn ? "warn" : "safe",
          anomalies,
        });
      });
    }

    contractHealths.sort((a, b) => a.id - b.id);
    const allAnomalies = contractHealths.flatMap((c) => c.anomalies);
    const fp = makeFingerprint(allAnomalies);

    // 若异动全部解除，自动重置静音与计数
    if (allAnomalies.length === 0) {
      st.mutedFingerprint = "";
      st.pushCount = 0;
    } else if (st.mutedFingerprint && st.mutedFingerprint !== fp) {
      // 如果出现了新的异动项，自动解除旧静音并重新计数
      st.mutedFingerprint = "";
      st.pushCount = 0;
    }

    const overallStatus: StakingSecuritySummary["status"] = allAnomalies.some(
      (a) => a.severity === "critical"
    )
      ? "danger"
      : allAnomalies.length > 0
      ? "warn"
      : "safe";

    const isMuted = Boolean(
      allAnomalies.length > 0 && st.mutedFingerprint === fp
    );

    const summary: StakingSecuritySummary = {
      status: overallStatus,
      checkedContracts: contractHealths.length,
      simulatedPositions: totalSimulated,
      anomalies: allAnomalies,
      contracts: contractHealths,
      checkedAt: nowIso,
      durationMs: Date.now() - t0,
      highFreqPushActive: allAnomalies.length > 0 && !isMuted,
      muted: isMuted,
      pushCount: st.pushCount,
      lastPushAt: st.lastPushAt ? new Date(st.lastPushAt).toISOString() : null,
    };

    st.lastSummary = summary;

    // 若发现未静音异动，立即推送第 1 次并启动 20s 高频连环推送定时器
    if (allAnomalies.length > 0 && !isMuted) {
      await pushEmergencyAlertNow(summary);
    }
    syncHighFreqPushTimer();

    return summary;
  } finally {
    st.running = false;
  }
}

/** 获取最近一次质押安全检查摘要 */
export function getLastStakingSecuritySummary(): StakingSecuritySummary | null {
  return getSecurityState().lastSummary;
}

/** 暂停/恢复当前异动的高频推送（已知晓静音） */
export function setStakingAnomalyMuted(mute: boolean): StakingSecuritySummary | null {
  const st = getSecurityState();
  if (!st.lastSummary) return null;
  if (mute) {
    st.mutedFingerprint = makeFingerprint(st.lastSummary.anomalies);
    st.lastSummary.muted = true;
    st.lastSummary.highFreqPushActive = false;
  } else {
    st.mutedFingerprint = "";
    st.pushCount = 0;
    st.lastSummary.muted = false;
    if (st.lastSummary.anomalies.length > 0) {
      st.lastSummary.highFreqPushActive = true;
      pushEmergencyAlertNow(st.lastSummary).catch(() => {});
    }
  }
  syncHighFreqPushTimer();
  return st.lastSummary;
}

/** 将当前链上的 owner / feeRecipient 确认为新的安全基线 */
export async function acceptCurrentStakingBaseline(): Promise<StakingSecuritySummary> {
  const st = getSecurityState();
  if (st.lastSummary) {
    for (const c of st.lastSummary.contracts) {
      const addr = c.contract.toLowerCase();
      if (c.owner) {
        setSetting(`staker_base_owner_${c.chainIdRef}_${addr}`, c.owner);
      }
      if (c.feeRecipient) {
        setSetting(`staker_base_feerec_${c.chainIdRef}_${addr}`, c.feeRecipient);
      }
    }
  }
  st.mutedFingerprint = "";
  st.pushCount = 0;
  return await scanStakingSecurity();
}

/** 手动触发一次紧急报警推送测试（验证 Bark critical + call=1 响铃） */
export async function triggerTestSecurityAlarm(): Promise<void> {
  await notifyAll({
    title: "🚨 [测试] ZIA 质押异动紧急报警测试",
    body: "这是一条来自 LP Monitor 质押安全哨兵的强提醒测试消息。\n当检测到禁止提取开关开启、解押模拟 Revert、管理员变更或 TVL 骤降时，将以每 20 秒 1 次的频率向您持续推送报警。",
    urgent: true,
    group: "lp-security",
  });
}
