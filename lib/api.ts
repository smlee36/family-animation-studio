import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { hasValidSession } from "@/lib/session";

export function jsonError(message: string, status: number, requestId = randomUUID()) {
  return NextResponse.json({ error: message, requestId }, { status });
}

export async function requireApiSession() {
  if (await hasValidSession()) return null;
  return jsonError("로그인이 필요합니다. 다시 입장해 주세요.", 401);
}

export function logServerError(scope: string, error: unknown, requestId: string) {
  console.error(`[${scope}] requestId=${requestId}`, error);
}
