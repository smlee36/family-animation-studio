import { NextResponse } from "next/server";
import { requireApiSession } from "@/lib/api";
import { getEnvironmentStatus } from "@/lib/env";
import { getLtxServiceStatus } from "@/lib/generations/ltx";
import { getWanServiceStatus } from "@/lib/generations/wan";
import { getQwenImageServiceStatus } from "@/lib/generations/qwen-image";

export async function GET() {
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  const environment = getEnvironmentStatus();
  const [videoBackend, wanBackend, imageBackend] = await Promise.all([
    environment.configured.LTX_VIDEO ? getLtxServiceStatus() : Promise.resolve({ reachable: false, model: "", queueDepth: 0, batchMode: null }),
    environment.configured.WAN_VIDEO ? getWanServiceStatus() : Promise.resolve({ reachable: false, model: "", queueDepth: 0 }),
    environment.configured.QWEN_IMAGE ? getQwenImageServiceStatus() : Promise.resolve({ reachable: false, modelReady: false, model: "", queueDepth: 0 }),
  ]);
  return NextResponse.json({ ...environment, videoBackend, wanBackend, imageBackend });
}
