import { ok, fail, getBody } from "@/lib/api";
import { getSettings, updateSettings, getStakingScanMethod, getStakingConcurrentLimit, getContractBatchSize, isStakingFallbackEnabled } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET: 读取当前扫描设置 */
export async function GET() {
  const settings = getSettings();
  
  return ok({
    staking_scan_method: getStakingScanMethod(),
    staking_scan_fallback_enabled: isStakingFallbackEnabled(),
    staking_scan_contract_batch_size: getContractBatchSize(),
    staking_scan_concurrent_limit: getStakingConcurrentLimit(),
    ...settings
  });
}

/** PUT: 更新扫描设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<{
    staking_scan_method?: "transfer_scan" | "contract_direct" | "hybrid";
    staking_scan_fallback_enabled?: boolean;
    staking_scan_contract_batch_size?: number;
    staking_scan_concurrent_limit?: number;
  }>(req);

  const updates: any = {};

  if (body.staking_scan_method !== undefined) {
    if (!["transfer_scan", "contract_direct", "hybrid"].includes(body.staking_scan_method)) {
      return fail("staking_scan_method 须为 transfer_scan、contract_direct 或 hybrid");
    }
    updates.staking_scan_method = body.staking_scan_method;
  }

  if (body.staking_scan_fallback_enabled !== undefined) {
    updates.staking_scan_fallback_enabled = body.staking_scan_fallback_enabled ? "1" : "0";
  }

  if (body.staking_scan_contract_batch_size !== undefined) {
    const v = Number(body.staking_scan_contract_batch_size);
    if (!Number.isFinite(v) || v < 10 || v > 200) {
      return fail("staking_scan_contract_batch_size 须为 10~200 的数值");
    }
    updates.staking_scan_contract_batch_size = String(v);
  }

  if (body.staking_scan_concurrent_limit !== undefined) {
    const v = Number(body.staking_scan_concurrent_limit);
    if (!Number.isFinite(v) || v < 1 || v > 20) {
      return fail("staking_scan_concurrent_limit 须为 1~20 的数值");
    }
    updates.staking_scan_concurrent_limit = String(v);
  }

  if (Object.keys(updates).length > 0) {
    updateSettings(updates as any);
  }

  // 返回更新后的完整设置
  const currentSettings = getSettings();
  
  return ok({
    staking_scan_method: getStakingScanMethod(),
    staking_scan_fallback_enabled: isStakingFallbackEnabled(),
    staking_scan_contract_batch_size: getContractBatchSize(),
    staking_scan_concurrent_limit: getStakingConcurrentLimit(),
    ...currentSettings
  });
}