import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getGeneration, saveGeneration } from "@/lib/generations/storage";
import { evaluateShotQuality } from "@/lib/generations/qc";
import { generationView } from "@/lib/generations/types";
import { startVeoGeneration } from "@/lib/generations/veo";

export const maxDuration = 180;

const FRAME_PATTERN = /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i;
const MAX_FRAME_LENGTH = 900_000;
const MAX_TOTAL_FRAME_LENGTH = 4_000_000;

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function regenerationError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 429) return "Standard 재생성을 위한 Veo 사용 한도가 부족합니다.";
    if (error.status === 401 || error.status === 403) return "Standard Veo 연결 권한을 확인해 주세요.";
  }
  return "Standard 자동 재생성을 시작하지 못했습니다.";
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("영상 작업 번호가 올바르지 않습니다.", 400, requestId);
    const record = await getGeneration(id);
    if (!record || record.status !== "ready") return jsonError("검수할 완성 영상을 찾을 수 없습니다.", 404, requestId);

    const body = (await request.json()) as Record<string, unknown>;
    const frames = Array.isArray(body.frames) ? body.frames.filter((frame): frame is string => typeof frame === "string") : [];
    const shotValue = body.shot && typeof body.shot === "object" ? body.shot as Record<string, unknown> : {};
    const totalFrameLength = frames.reduce((total, frame) => total + frame.length, 0);
    if (frames.length < 3 || frames.length > 6 || totalFrameLength > MAX_TOTAL_FRAME_LENGTH || frames.some((frame) => frame.length > MAX_FRAME_LENGTH || !FRAME_PATTERN.test(frame))) {
      return jsonError("영상 검수용 프레임을 준비하지 못했습니다.", 400, requestId);
    }

    const shot = {
      title: cleanText(shotValue.title, 200),
      action: cleanText(shotValue.action, 500),
      prompt: record.prompt,
      startState: cleanText(shotValue.startState, 500),
      endState: cleanText(shotValue.endState, 500),
    };
    const qc = await evaluateShotQuality({ frames, referenceIds: record.usedReferenceIds, shot });
    const regenerationCount = record.autoRegenerationCount || 0;
    const shouldRegenerate = qc.overall < 85 && regenerationCount < 2;
    const evaluatedRecord = {
      ...record,
      qc,
      approvalStatus: qc.overall >= 85 ? "approved" as const : shouldRegenerate ? "pending" as const : "needs_review" as const,
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(evaluatedRecord);
    console.info(`[qc.complete] requestId=${requestId} generationId=${id} score=${qc.overall} tier=${record.qualityTier || "standard"} autoRegenerationCount=${regenerationCount}`);

    let autoRegeneration = null;
    let autoRegenerationError = "";
    if (shouldRegenerate) {
      try {
        const correctedPrompt = `${record.prompt}\n\nQC correction: ${qc.correctionPrompt}`.slice(0, 2_000);
        const nextRecord = await startVeoGeneration({
          id: randomUUID(),
          shotId: record.shotId,
          prompt: correctedPrompt,
          estimatedSeconds: record.durationSeconds,
          referenceIds: [...new Set([...record.usedReferenceIds, ...record.omittedReferenceIds])].slice(0, 3),
          qualityTier: "standard",
          autoRegenerationCount: regenerationCount + 1,
          parentGenerationId: record.id,
        });
        autoRegeneration = generationView(nextRecord);
        console.info(`[qc.regenerate] requestId=${requestId} generationId=${nextRecord.id} parentGenerationId=${id} attempt=${nextRecord.autoRegenerationCount}`);
      } catch (error) {
        autoRegenerationError = regenerationError(error);
        logServerError("qc.regenerate", error, requestId);
        evaluatedRecord.approvalStatus = "needs_review";
        evaluatedRecord.updatedAt = new Date().toISOString();
        await saveGeneration(evaluatedRecord);
      }
    }

    return NextResponse.json({
      generation: generationView(evaluatedRecord),
      autoRegeneration,
      autoRegenerationError,
      requestId,
    });
  } catch (error) {
    logServerError("qc.evaluate", error, requestId);
    return jsonError("GPT 영상 검수를 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
