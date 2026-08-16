import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE_NAME, verifySessionToken } from "@/lib/session";

export function proxy(request: NextRequest) {
  const authenticated = verifySessionToken(request.cookies.get(SESSION_COOKIE_NAME)?.value);
  const isApi = request.nextUrl.pathname.startsWith("/api/");

  if (!authenticated) {
    if (isApi) {
      return NextResponse.json(
        { error: "로그인이 필요합니다. 다시 입장해 주세요." },
        { status: 401 },
      );
    }
    return NextResponse.redirect(new URL("/", request.url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/studio/:path*", "/references/:path*", "/episodes/:path*", "/api/system/:path*", "/api/episodes/:path*", "/api/story-inputs/:path*"],
};
