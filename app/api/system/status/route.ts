import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api";
import { getEnvironmentStatus } from "@/lib/env";
import { getLtxServiceStatus } from "@/lib/generations/ltx";

export async function GET() {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  const environment = getEnvironmentStatus();
  const videoBackend = environment.configured.LTX_VIDEO
    ? await getLtxServiceStatus()
    : { reachable: false, model: "", queueDepth: 0 };
  return NextResponse.json({ ...environment, videoBackend });
}
