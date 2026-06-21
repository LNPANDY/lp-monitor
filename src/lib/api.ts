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
