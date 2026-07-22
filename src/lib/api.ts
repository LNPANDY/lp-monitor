import { NextResponse } from "next/server";

export function ok(data?: unknown) {
  return NextResponse.json({ ok: true, data });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export function getBody<T = any>(req: Request): Promise<T> {
  return req.json().catch(() => ({} as T));
}

/**
 * 校验请求是否携带有效 Bearer Token。
 * 读 .env.local 的 API_TOKEN，与 Authorization header 里的 token 比对。
 * 如果没设 API_TOKEN，跳过校验（开发模式向后兼容）。
 *
 * @returns null=校验通过，NextResponse=校验失败（直接 return 给客户端）
 */
export function requireAuth(req: Request): NextResponse | null {
  const expectedToken = process.env.API_TOKEN ?? "";
  // 未配置 token → 不鉴权（本地开发方便）
  if (!expectedToken) return null;

  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  // 也兼容 query param（部分场景 header 不方便，如 SWR GET 不需要但测试场景可能用）
  // 但写操作必须有 header
  if (token === expectedToken) return null;

  return NextResponse.json(
    { ok: false, error: "Unauthorized: 无效或缺失的 API Token" },
    { status: 401 }
  );
}
