import {
  scanStakingSecurity,
  getLastStakingSecuritySummary,
  setStakingAnomalyMuted,
  acceptCurrentStakingBaseline,
  triggerTestSecurityAlarm,
} from "@/lib/monitor/staking-security";
import { ok, fail, getBody } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 获取最新质押合约安全检查结果（若尚未检查过则立即执行一次） */
export async function GET() {
  const existing = getLastStakingSecuritySummary();
  if (existing) return ok(existing);
  try {
    const fresh = await scanStakingSecurity();
    return ok(fresh);
  } catch (e: any) {
    return fail(e?.message ?? "质押安全检查失败", 500);
  }
}

/**
 * 操作质押安全哨兵：
 *   - { action: "scan" }            立即执行一次全量质押合约安检 + withdraw 静态预演
 *   - { action: "mute" }            静音当前异动的高频连环推送
 *   - { action: "unmute" }          恢复当前异动的高频连环推送
 *   - { action: "accept_baseline" } 将当前链上 owner / feeRecipient 设为新安全基线
 *   - { action: "test_alarm" }      发送一条紧急强提醒测试推送（验证 Bark critical + call=1）
 */
export async function POST(req: Request) {
  try {
    const b = await getBody<{ action?: string }>(req);
    const action = b?.action || "scan";

    if (action === "mute") {
      return ok(setStakingAnomalyMuted(true));
    }
    if (action === "unmute") {
      return ok(setStakingAnomalyMuted(false));
    }
    if (action === "accept_baseline") {
      const summary = await acceptCurrentStakingBaseline();
      return ok(summary);
    }
    if (action === "test_alarm") {
      await triggerTestSecurityAlarm();
      return ok({ tested: true });
    }

    const summary = await scanStakingSecurity();
    return ok(summary);
  } catch (e: any) {
    return fail(e?.message ?? "操作失败", 500);
  }
}
