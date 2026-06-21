import { exportConfig, importConfig } from "@/lib/config/io";
import { ok, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

/** 导出全部配置为 JSON。 */
export async function GET() {
  const bundle = exportConfig();
  return ok(bundle);
}

/** 导入配置 JSON。body: ConfigBundle */
export async function POST(req: Request) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return fail("请求体不是合法 JSON");
  }
  if (!body || typeof body !== "object") return fail("请求体为空");
  // 校验：至少能识别 version 或包含任一配置数组
  if (!body.version && !body.chains && !body.dexes && !body.staking && !body.wallets) {
    return fail("未识别到可导入的配置（缺少 chains/dexes/staking/wallets）");
  }
  try {
    const res = importConfig(body);
    return ok(res);
  } catch (e: any) {
    return fail(e?.message ?? "import failed", 500);
  }
}
