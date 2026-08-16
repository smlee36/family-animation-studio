import { NextResponse } from "next/server";
import { hasValidSession } from "@/lib/session";

export async function GET() {
  const authenticated = await hasValidSession();
  return NextResponse.json({ authenticated }, { status: authenticated ? 200 : 401 });
}
