import { ok, fail, getBody } from "@/lib/api";
import {
  scanMerklRewardsAndApr,
  getLastMerklRewardsSummary,
  setHighAprAlertEnabled,
  setHighAprThresholdPct,
} from "@/lib/monitor/merkl-rewards";
import { notifyAll } from "@/lib/notify";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "1";
    const last = getLastMerklRewardsSummary();
    if (!force && last) {
      // 若缓存超过 45 秒，后台异步刷新，立即返回已有快照保证首屏 0 等待
      if (Date.now() - new Date(last.checkedAt).getTime() > 45_000) {
        scanMerklRewardsAndApr({ force: true }).catch(() => {});
      }
      return ok(last);
    }
    const fresh = await scanMerklRewardsAndApr({ force: true });
    return ok(fresh);
  } catch (e) {
    return fail(`读取 Merkl 奖励数据失败: ${(e as Error).message}`, 500);
  }
}

export async function POST(req: Request) {
  try {
    const body = await getBody<{
      action?: "scan" | "update_settings" | "test_alert";
      highAprAlertEnabled?: boolean;
      highAprThresholdPct?: number;
    }>(req);

    if (body.action === "update_settings") {
      if (typeof body.highAprAlertEnabled === "boolean") {
        setHighAprAlertEnabled(body.highAprAlertEnabled);
      }
      if (typeof body.highAprThresholdPct === "number") {
        setHighAprThresholdPct(body.highAprThresholdPct);
      }
      const summary = await scanMerklRewardsAndApr({ force: true });
      return ok(summary);
    }

    if (body.action === "test_alert") {
      const summary = await scanMerklRewardsAndApr({ force: true });
      const top = summary.pools[0];
      if (!top) {
        return fail("未找到可推送的 0G ZIA 激励池数据", 400);
      }
      const title = `🔥 [测试] 高APR猎手: ${top.pairLabel} 达 ${top.sim1000AprPct.toFixed(0)}%`;
      const content = [
        `0G 实时价: $${summary.w0gPriceUsd.toFixed(4)} (${summary.w0gPriceSource})`,
        `榜首池: ${top.pairLabel}`,
        `• 千刀单格真实 APR: ${top.sim1000AprPct.toFixed(0)}%`,
        `• 预计每小时产出: ${top.sim1000HourlyW0g.toFixed(2)} W0G ($${top.sim1000HourlyUsd.toFixed(2)}/h)`,
        `• 预计每天产出: ${top.sim1000DailyW0g.toFixed(1)} W0G ($${top.sim1000DailyUsd.toFixed(2)}/d)`,
        `• 稀释后活跃L占比: ${(top.sim1000ActiveLShare * 100).toFixed(1)}% (池内窄幅竞争仅 $${top.narrowStakedTvlUsd.toFixed(0)})`,
      ].join("\n");
      const results = await notifyAll({ title, body: content });
      return ok({ summary, notifyResults: results });
    }

    const summary = await scanMerklRewardsAndApr({ force: true });
    return ok(summary);
  } catch (e) {
    return fail(`操作失败: ${(e as Error).message}`, 500);
  }
}
