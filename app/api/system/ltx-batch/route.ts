import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { setLtxBatchMode } from "@/lib/generations/ltx";

export const maxDuration = 180;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const body = (await request.json()) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") return jsonError("고속 배치 모드 설정을 확인해 주세요.", 400, requestId);
    const batchMode = await setLtxBatchMode(body.enabled);
    console.info(`[ltx.batch] requestId=${requestId} enabled=${body.enabled} state=${batchMode.state}`);
    return NextResponse.json({ batchMode, requestId });
  } catch (error) {
    logServerError("ltx.batch", error, requestId);
    return jsonError("고속 배치 모드를 전환하지 못했습니다. 현재 영상 작업이 끝난 뒤 다시 시도해 주세요.", 409, requestId);
  }
}
