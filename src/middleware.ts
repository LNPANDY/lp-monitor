/**
 * Next.js middleware —— 在所有 API 请求到达 route handler 前拦截。
 *
 * 安全策略：
 *   - GET 请求放行（前端 SWR 只读拉数据，无需鉴权）
 *   - POST/PUT/DELETE/PATCH 写操作必须携带 Bearer Token
 *   - 未配置 API_TOKEN 时跳过校验（本地开发向后兼容）
 *
 * 这样攻击者即使发现了 API 地址，没有 token 也无法写入任何数据。
 */
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const WRITE_METHODS = new Set(["POST", "PUT", "DELETE", "PATCH"]);

export function middleware(req: NextRequest) {
  // 只拦截写操作
  if (!WRITE_METHODS.has(req.method)) return NextResponse.next();

  const expectedToken = process.env.API_TOKEN ?? "";
  // 未配置 token → 不鉴权（本地开发方便，VPS 必须设）
  if (!expectedToken) return NextResponse.next();

  // 从 Authorization header 取 Bearer token
  const auth = req.headers.get("Authorization") ?? "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (token && token === expectedToken) return NextResponse.next();

  return NextResponse.json(
    { ok: false, error: "Unauthorized: 无效或缺失的 API Token" },
    { status: 401 }
  );
}

export const config = {
  // 只拦截 /api/ 路径，不影响页面路由
  matcher: ["/api/:path*"],
};