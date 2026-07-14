import { ok, fail, getBody } from "@/lib/api";
import { getSettings, updateSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

/** GET: 读取当前扫描设置 */
export async function GET() {
  const settings = getSettings();
  return ok(settings);
}

/** PUT: 更新扫描设置（partial，只传需要改的字段） */
export async function PUT(req: Request) {
  const body = await getBody<Record<string, any>>(req);

  const updates: Record<string, string> = {};

  for (const [key, value] of Object.entries(body)) {
    if (value !== undefined && value !== null) {
      updates[key] = String(value);
    }
  }

  if (Object.keys(updates).length > 0) {
    updateSettings(updates as any);
  }

  // 返回更新后的完整设置
  const currentSettings = getSettings();
  return ok(currentSettings);
}
