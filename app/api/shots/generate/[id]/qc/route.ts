import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { startVideoGeneration } from "@/lib/generations/backend";
import { getGeneration, saveGeneration } from "@/lib/generations/storage";
import { evaluateShotQuality } from "@/lib/generations/qc";
import { generationView } from "@/lib/generations/types";
import { appendPromptInstruction, MAX_GENERATION_PROMPT_CHARS } from "@/lib/generations/prompt";

export const maxDuration = 300;

const FRAME_PATTERN = /^data:image\/(jpeg|png|webp);base64,[a-z0-9+/=]+$/i;
const MAX_FRAME_LENGTH = 900_000;
const MAX_TOTAL_FRAME_LENGTH = 4_000_000;

function cleanText(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function regenerationError(error: unknown) {
  if (error instanceof ApiError) {
    if (error.status === 429) return "자동 보정 영상 생성을 위한 사용 한도가 부족합니다.";
    if (error.status === 401 || error.status === 403) return "자동 보정 영상 모델의 연결 권한을 확인해 주세요.";
  }
  return "고정 기준 자동 재생성을 시작하지 못했습니다.";
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
    const qcReferenceIds = [...new Set([...record.usedReferenceIds, ...record.omittedReferenceIds])].slice(0, 6);
    let continuityFrame = "";
    if (record.continuityFramePathname) {
      const blob = await get(record.continuityFramePathname, { access: "private", useCache: true });
      if (blob?.stream && blob.statusCode === 200) {
        const bytes = await new Response(blob.stream).arrayBuffer();
        continuityFrame = `data:${record.continuityFrameMimeType || blob.blob.contentType || "image/jpeg"};base64,${Buffer.from(bytes).toString("base64")}`;
      }
    }
    const qc = await evaluateShotQuality({ frames, referenceIds: qcReferenceIds, shot, continuityFrame, initialFrameKind: record.initialFrameKind });
    const regenerationCount = record.autoRegenerationCount || 0;
    const meetsApprovalGate = qc.overall >= 85 && qc.scores.referenceMatch >= 85 &&
      qc.scores.characterConsistency >= 85 && qc.scores.continuity >= 80;
    const shouldRegenerate = !meetsApprovalGate && regenerationCount < 2;
    const evaluatedRecord = {
      ...record,
      qc,
      approvalStatus: meetsApprovalGate ? "approved" as const : shouldRegenerate ? "pending" as const : "needs_review" as const,
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(evaluatedRecord);
    console.info(`[qc.complete] requestId=${requestId} generationId=${id} score=${qc.overall} tier=${record.qualityTier || "standard"} autoRegenerationCount=${regenerationCount}`);

    let autoRegeneration = null;
    let autoRegenerationError = "";
    if (shouldRegenerate) {
      try {
        const basePrompt = record.sourcePrompt || record.prompt;
        const correctedPrompt = appendPromptInstruction(basePrompt, "QC correction — highest priority:", qc.correctionPrompt);
        if (correctedPrompt.length > MAX_GENERATION_PROMPT_CHARS) {
          throw new Error(`Corrected prompt exceeds ${MAX_GENERATION_PROMPT_CHARS} characters`);
        }
        const severeMotionFailure = qc.scores.handsBody < 75 || qc.scores.motionNaturalness < 75 || qc.scores.characterConsistency < 75;
        const qcFallbackProvider = record.provider === "ltx" && severeMotionFailure ? "wan" as const : record.provider;
        const nextRecord = await startVideoGeneration({
          id: randomUUID(),
          episodeId: record.episodeId,
          shotId: record.shotId,
          prompt: correctedPrompt,
          estimatedSeconds: record.durationSeconds,
          referenceIds: [...new Set([...record.usedReferenceIds, ...record.omittedReferenceIds])].slice(0, 6),
          qualityTier: "standard",
          provider: record.provider || (record.model.toLowerCase().includes("ltx") ? "ltx" : "google"),
          qcFallbackProvider,
          retryReason: `QC ${qc.overall}: 손·신체 ${qc.scores.handsBody}, 움직임 ${qc.scores.motionNaturalness}, 캐릭터 ${qc.scores.characterConsistency}`,
          ltxPreset: record.ltxPreset || "gentle",
          autoRegenerationCount: regenerationCount + 1,
          parentGenerationId: record.id,
          continuityFrame: record.continuityFramePathname ? {
            sourceGenerationId: record.continuitySourceGenerationId || "",
            pathname: record.continuityFramePathname,
            mimeType: record.continuityFrameMimeType,
            kind: record.initialFrameKind,
            model: record.initialFrameModel,
          } : undefined,
          aspectRatio: record.aspectRatio || "16:9",
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
