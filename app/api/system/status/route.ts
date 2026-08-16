import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api";
import { getEnvironmentStatus } from "@/lib/env";

export async function GET() {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  return NextResponse.json(getEnvironmentStatus());
}
