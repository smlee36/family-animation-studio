import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { assertPasscodeConfigured } from "@/lib/env";

export const SESSION_COOKIE_NAME = "family_studio_session";
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const SESSION_VERSION = "v1";

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

function safeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export function passcodeMatches(candidate: string, expected: string): boolean {
  const left = createHash("sha256").update(candidate).digest();
  const right = createHash("sha256").update(expected).digest();
  return timingSafeEqual(left, right);
}

export function createSessionToken(now = Date.now()): string {
  const secret = assertPasscodeConfigured();
  const expiresAt = now + SESSION_MAX_AGE_SECONDS * 1000;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  return `${payload}.${signature(payload, secret)}`;
}

export function verifySessionToken(token: string | undefined, now = Date.now()): boolean {
  if (!token) return false;

  const [version, expiresAtRaw, suppliedSignature, ...rest] = token.split(".");
  if (rest.length || version !== SESSION_VERSION || !expiresAtRaw || !suppliedSignature) return false;

  const expiresAt = Number(expiresAtRaw);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now) return false;

  try {
    const payload = `${version}.${expiresAtRaw}`;
    return safeEqual(suppliedSignature, signature(payload, assertPasscodeConfigured()));
  } catch {
    return false;
  }
}

export async function hasValidSession(): Promise<boolean> {
  const cookieStore = await cookies();
  return verifySessionToken(cookieStore.get(SESSION_COOKIE_NAME)?.value);
}
