import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { generationView } from "@/lib/generations/types";
import { startVeoGeneration } from "@/lib/generations/veo";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const shotId = typeof body.shotId === "string" ? body.shotId.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const estimatedSeconds = typeof body.estimatedSeconds === "number" ? body.estimatedSeconds : 6;
    const referenceIds = Array.isArray(body.referenceIds) ? body.referenceIds.filter((id): id is string => typeof id === "string") : [];
    if (!shotId || shotId.length > 40 || prompt.length < 10 || prompt.length > 2_000 || referenceIds.length > 3) {
      return jsonError("Shot 프롬프트 또는 Reference 정보를 확인해 주세요.", 400, requestId);
    }

    const record = await startVeoGeneration({ id: randomUUID(), shotId, prompt, estimatedSeconds, referenceIds, qualityTier: "fast" });
    console.info(`[veo.start] requestId=${requestId} generationId=${record.id} operation=${record.operationName} model=${record.model} tier=${record.qualityTier} references=${record.usedReferenceIds.length}`);
    return NextResponse.json({ generation: generationView(record), requestId }, { status: 202 });
  } catch (error) {
    logServerError("veo.start", error, requestId);
    if (error instanceof ApiError) {
      if (error.status === 429) {
        return jsonError("Veo 영상 생성 사용 한도에 도달했습니다. Google AI Studio의 결제 및 quota를 확인해 주세요.", 429, requestId);
      }
      if (error.status === 401 || error.status === 403) {
        return jsonError("Veo 연결 권한을 확인해 주세요.", 503, requestId);
      }
      if (error.status === 400) {
        return jsonError("Veo가 이 Shot 설정을 처리하지 못했습니다. 프롬프트와 Reference를 확인해 주세요.", 400, requestId);
      }
    }
    return jsonError("영상 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
