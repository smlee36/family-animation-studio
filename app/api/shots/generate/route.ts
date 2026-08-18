import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getEpisode } from "@/lib/episodes/storage";
import { startVideoGeneration } from "@/lib/generations/backend";
import { getGeneration } from "@/lib/generations/storage";
import { generationView, type LtxPreset, type LtxRenderMode, type VideoGenerationProvider } from "@/lib/generations/types";
import { SceneMasterFrameError, type ContinuityFrameInput } from "@/lib/generations/veo";
import { MAX_GENERATION_PROMPT_CHARS } from "@/lib/generations/prompt";
import { getStoryInput } from "@/lib/story-inputs/storage";

export const maxDuration = 300;

const CONTINUITY_FRAME_PATTERN = /^data:(image\/(?:jpeg|png|webp));base64,([a-z0-9+/=]+)$/i;
const MAX_CONTINUITY_FRAME_LENGTH = 1_200_000;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const shotId = typeof body.shotId === "string" ? body.shotId.trim() : "";
    const sceneId = typeof body.sceneId === "string" ? body.sceneId.trim() : "";
    const episodeId = typeof body.episodeId === "string" ? body.episodeId.trim() : "";
    const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
    const provider: VideoGenerationProvider = body.provider === "google" || body.provider === "ltx" || body.provider === "wan"
      ? body.provider
      : "auto";
    const ltxPreset: LtxPreset = body.ltxPreset === "action" || body.ltxPreset === "camera" ? body.ltxPreset : "gentle";
    const ltxRenderMode: LtxRenderMode = body.ltxRenderMode === "final" ? "final" : "preview";
    const estimatedSeconds = typeof body.estimatedSeconds === "number" ? body.estimatedSeconds : 5;
    const referenceIds = Array.isArray(body.referenceIds) ? body.referenceIds.filter((id): id is string => typeof id === "string") : [];
    const continuitySourceGenerationId = typeof body.continuitySourceGenerationId === "string" ? body.continuitySourceGenerationId.trim() : "";
    const sceneMasterGenerationId = typeof body.sceneMasterGenerationId === "string" ? body.sceneMasterGenerationId.trim() : "";
    const continuityFrameDataUrl = typeof body.continuityFrame === "string" ? body.continuityFrame.trim() : "";
    const keyframePathnames = Array.isArray(body.keyframePathnames) ? body.keyframePathnames.filter((pathname): pathname is string => typeof pathname === "string") : [];
    const keyframeMimeTypes = Array.isArray(body.keyframeMimeTypes) ? body.keyframeMimeTypes.filter((mimeType): mimeType is string => typeof mimeType === "string") : [];
    if (!shotId || shotId.length > 40 || (episodeId && !/^[0-9a-f-]{36}$/i.test(episodeId)) || prompt.length < 10 || prompt.length > MAX_GENERATION_PROMPT_CHARS || referenceIds.length > 6) {
      return jsonError("Shot 프롬프트 또는 Reference 정보를 확인해 주세요.", 400, requestId);
    }
    const episode = episodeId ? await getEpisode(episodeId) : null;
    if (episodeId && !episode) return jsonError("저장된 Episode를 찾을 수 없습니다.", 404, requestId);
    const scene = episode?.plan?.scenes.find((item) => item.id === sceneId && item.shots.some((shot) => shot.id === shotId));
    // Episodes saved before the format field was introduced are shown as Reels
    // by the Studio UI, so the API must use the same backwards-compatible default.
    const isReelsEpisode = Boolean(episode && episode.format !== "landscape");
    if (isReelsEpisode && !scene) return jsonError("릴스 Scene과 Shot 정보를 확인해 주세요.", 400, requestId);
    const aspectRatio = isReelsEpisode ? "9:16" as const : "16:9" as const;
    let keyframes: ContinuityFrameInput[] | undefined;
    if (keyframePathnames.length || keyframeMimeTypes.length) {
      if ((provider !== "ltx" && provider !== "auto") || !episode || keyframePathnames.length !== 3 || keyframeMimeTypes.length !== 3) {
        return jsonError("연결 영상의 키프레임 정보를 확인해 주세요.", 400, requestId);
      }
      const episodeInputs = (await Promise.all((episode.storyboardInputIds || []).map((id) => getStoryInput(id))))
        .filter((input): input is NonNullable<typeof input> => Boolean(input));
      const allowedInputs = new Map(episodeInputs.map((input) => [input.imagePathname, input]));
      if (keyframePathnames.some((pathname, index) => {
        const input = allowedInputs.get(pathname);
        return !input || input.kind !== "photo" || input.contentType !== keyframeMimeTypes[index];
      })) {
        return jsonError("Episode에 저장된 연결 사진을 찾을 수 없습니다.", 404, requestId);
      }
      keyframes = keyframePathnames.map((pathname, index) => ({
        sourceGenerationId: "",
        pathname,
        mimeType: keyframeMimeTypes[index],
        kind: "scene_master" as const,
        model: "uploaded-photo-keyframe",
      }));
    }
    let continuityFrame: ContinuityFrameInput | undefined;
    if (continuitySourceGenerationId || continuityFrameDataUrl) {
      const frameMatch = continuityFrameDataUrl.match(CONTINUITY_FRAME_PATTERN);
      if (!/^[0-9a-f-]{36}$/i.test(continuitySourceGenerationId) || !frameMatch || continuityFrameDataUrl.length > MAX_CONTINUITY_FRAME_LENGTH) {
        return jsonError("이전 Shot의 연결 프레임을 확인해 주세요.", 400, requestId);
      }
      const sourceGeneration = await getGeneration(continuitySourceGenerationId);
      if (!sourceGeneration || sourceGeneration.status !== "ready" || (episodeId && sourceGeneration.episodeId !== episodeId)) {
        return jsonError("연결할 이전 Shot 영상을 찾을 수 없습니다.", 404, requestId);
      }
      continuityFrame = {
        sourceGenerationId: continuitySourceGenerationId,
        mimeType: frameMatch[1].toLowerCase(),
        data: frameMatch[2],
      };
    }
    if (!continuityFrame && sceneMasterGenerationId) {
      if (!/^[0-9a-f-]{36}$/i.test(sceneMasterGenerationId)) {
        return jsonError("Scene 기준 프레임 정보를 확인해 주세요.", 400, requestId);
      }
      const sourceGeneration = await getGeneration(sceneMasterGenerationId);
      if (sourceGeneration?.status === "ready" && sourceGeneration.shotId === shotId &&
        (!episodeId || sourceGeneration.episodeId === episodeId) && sourceGeneration.initialFrameKind === "scene_master" &&
        sourceGeneration.continuityFramePathname) {
        continuityFrame = {
          sourceGenerationId: "",
          pathname: sourceGeneration.continuityFramePathname,
          mimeType: sourceGeneration.continuityFrameMimeType,
          kind: "scene_master",
          model: sourceGeneration.initialFrameModel,
        };
      }
    }

    if (!continuityFrame && isReelsEpisode && scene) {
      const approvedFrame = episode?.sceneFrames?.[scene.id];
      if (scene.shots[0]?.id !== shotId) {
        return jsonError("이 Shot은 앞 Shot의 마지막 화면을 먼저 연결해야 합니다.", 409, requestId);
      }
      if (approvedFrame?.approvalStatus === "approved" && approvedFrame.imagePathname) {
        continuityFrame = {
          sourceGenerationId: "",
          pathname: approvedFrame.imagePathname,
          mimeType: approvedFrame.contentType,
          kind: "scene_master",
          model: approvedFrame.model,
        };
      }
    }

    const effectiveReferenceIds = [...new Set([
      ...(scene?.sceneMasterReferenceId ? [scene.sceneMasterReferenceId] : []),
      ...referenceIds,
    ])].slice(0, 6);
    const shot = scene?.shots.find((item) => item.id === shotId);
    const record = await startVideoGeneration({ id: randomUUID(), episodeId, shotId, prompt, estimatedSeconds, referenceIds: effectiveReferenceIds, provider, qualityTier: "fast", ltxPreset, ltxRenderMode, continuityFrame, keyframes, aspectRatio, shot });
    console.info(`[video.start] requestId=${requestId} generationId=${record.id} requestedProvider=${provider} provider=${record.provider} routingMode=${record.routing?.mode || "legacy"} recommendedProvider=${record.routing?.recommendedProvider || record.provider} operation=${record.operationName} model=${record.model} tier=${record.qualityTier} aspectRatio=${aspectRatio} references=${record.usedReferenceIds.length} continuity=${Boolean(record.continuitySourceGenerationId)}`);
    return NextResponse.json({ generation: generationView(record), requestId }, { status: 202 });
  } catch (error) {
    logServerError("veo.start", error, requestId);
    if (error instanceof SceneMasterFrameError) {
      return jsonError("레퍼런스 그림체의 Scene 기준 프레임을 만들지 못해 영상 생성을 중단했습니다. 잠시 후 다시 시도해 주세요.", 503, requestId);
    }
    const apiStatus = error instanceof ApiError
      ? error.status
      : error && typeof error === "object" && "status" in error && typeof error.status === "number"
        ? error.status
        : 0;
    if (apiStatus) {
      if (apiStatus === 429) {
        return jsonError("영상 생성 사용 한도에 도달했습니다. Google AI Studio의 결제 및 quota를 확인해 주세요.", 429, requestId);
      }
      if (apiStatus === 401 || apiStatus === 403) {
        return jsonError("Google 영상 생성 연결 권한을 확인해 주세요.", 503, requestId);
      }
      if (apiStatus === 400) {
        return jsonError("영상 모델이 이 Shot 설정을 처리하지 못했습니다. 프롬프트와 고정 기준을 확인해 주세요.", 400, requestId);
      }
    }
    return jsonError("영상 생성을 시작하지 못했습니다. B200 연결 상태를 확인한 뒤 다시 시도해 주세요.", 500, requestId);
  }
}
