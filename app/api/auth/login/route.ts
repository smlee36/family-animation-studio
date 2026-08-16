import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { assertPasscodeConfigured } from "@/lib/env";
import { jsonError, logServerError } from "@/lib/api";
import {
  createSessionToken,
  passcodeMatches,
  SESSION_COOKIE_NAME,
  SESSION_MAX_AGE_SECONDS,
} from "@/lib/session";

export async function POST(request: NextRequest) {
  const requestId = randomUUID();

  try {
    const body = (await request.json()) as { passcode?: unknown };
    const passcode = typeof body.passcode === "string" ? body.passcode : "";
    if (!passcode || passcode.length > 128) return jsonError("가족 비밀번호를 확인해 주세요.", 400, requestId);

    if (!passcodeMatches(passcode, assertPasscodeConfigured())) {
      return jsonError("가족 비밀번호가 맞지 않습니다.", 401, requestId);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.set({
      name: SESSION_COOKIE_NAME,
      value: createSessionToken(),
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: SESSION_MAX_AGE_SECONDS,
    });
    return response;
  } catch (error) {
    logServerError("auth.login", error, requestId);
    return jsonError("로그인 처리 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
