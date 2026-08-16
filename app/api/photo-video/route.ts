import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import type { DirectorPlan } from "@/lib/director/types";
import { completeEpisodePlan, createEpisodeDraft, failEpisodePlan, saveSceneFrame } from "@/lib/episodes/storage";
import type { EpisodeFormat, SceneFrameRecord } from "@/lib/episodes/types";
import { startVideoGeneration } from "@/lib/generations/backend";
import { generationView, type LtxPreset } from "@/lib/generations/types";
import { getStoryInput } from "@/lib/story-inputs/storage";

export const maxDuration = 300;

function presetForInstruction(instruction: string): LtxPreset {
  if (/camera|dolly|pan|zoom|tracking|카메라|줌|패닝|이동 촬영/i.test(instruction)) return "camera";
  if (/run|walk|jump|dance|turn|달리|걷|뛰|점프|춤|돌아/i.test(instruction)) return "action";
  return "gentle";
}

function buildPrompt(instruction: string) {
  const motion = instruction || "사진 속 인물들이 자연스럽게 숨을 쉬고 부드럽게 미소 짓는다.";
  return [
    "Use the uploaded photo as the exact first frame and visual source of truth.",
    "Preserve every person's identity, face, hairstyle, clothing, age, body proportions, illustration style, framing, background, lighting, and object appearance.",
    "Animate only this requested motion with gentle, physically natural movement:",
    motion,
    "Keep the same composition and camera unless the requested motion explicitly asks for camera movement.",
    "Stable faces and hands, no duplicate people, no extra limbs, no new objects, no text, no scene change.",
  ].join("\n");
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  let episodeId = "";
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const inputId = typeof body.inputId === "string" ? body.inputId.trim() : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    const format: EpisodeFormat = body.format === "landscape" ? "landscape" : "reels";
    const durationSeconds = body.durationSeconds === 6 || body.durationSeconds === 8 ? body.durationSeconds : 4;
    if (!/^[0-9a-f-]{36}$/i.test(inputId) || instruction.length > 1_000) {
      return jsonError("사진 또는 움직임 설명을 확인해 주세요.", 400, requestId);
    }

    const input = await getStoryInput(inputId);
    if (!input || input.kind !== "photo") return jsonError("영상으로 만들 사진을 찾을 수 없습니다.", 404, requestId);

    episodeId = randomUUID();
    const generationId = randomUUID();
    const shotId = "1-1";
    const sceneId = "scene-1";
    const prompt = buildPrompt(instruction);
    const titleBase = input.name.replace(/\.[^.]+$/, "").trim().slice(0, 48) || "가족 사진";
    const title = `${titleBase} 영상`;
    const action = instruction || "사진 속 가족이 편안하게 숨을 쉬며 자연스럽게 미소 짓는다.";
    const plan: DirectorPlan = {
      title,
      summary: "업로드한 사진을 시작 화면으로 그대로 사용해 한 장면의 짧은 영상을 만듭니다.",
      totalEstimatedSeconds: durationSeconds,
      totalShots: 1,
      scenes: [{
        id: sceneId,
        number: 1,
        title: "사진 속 순간",
        summary: action,
        setting: "업로드한 사진 속 장소와 배경",
        sceneMasterReferenceId: "",
        shots: [{
          id: shotId,
          title: "사진이 움직이는 순간",
          action,
          estimatedSeconds: durationSeconds,
          referenceIds: [],
          referenceReason: "사용자가 올린 사진 자체를 고정 시작 프레임으로 사용",
          startState: "업로드한 사진과 정확히 같은 구도와 모습",
          endState: `같은 인물과 배경을 유지하며 ${action}`,
          prompt,
        }],
      }],
    };

    await createEpisodeDraft(episodeId, action, [input.id], format);
    await completeEpisodePlan(episodeId, plan, []);
    const timestamp = new Date().toISOString();
    const frame: SceneFrameRecord = {
      id: randomUUID(),
      sceneId,
      prompt,
      revisionInstruction: "",
      referenceIds: [],
      imagePathname: input.imagePathname,
      contentType: input.contentType,
      model: "uploaded-photo",
      approvalStatus: "approved",
      error: "",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await saveSceneFrame(episodeId, frame);

    const generation = await startVideoGeneration({
      id: generationId,
      episodeId,
      shotId,
      prompt,
      estimatedSeconds: durationSeconds,
      referenceIds: [],
      provider: "ltx",
      ltxPreset: presetForInstruction(instruction),
      aspectRatio: format === "reels" ? "9:16" : "16:9",
      continuityFrame: {
        sourceGenerationId: "",
        pathname: input.imagePathname,
        mimeType: input.contentType,
        kind: "scene_master",
        model: "uploaded-photo",
      },
    });
    console.info(`[photo-video.start] requestId=${requestId} episodeId=${episodeId} generationId=${generation.id} format=${format} duration=${durationSeconds}`);
    return NextResponse.json({ episodeId, generation: generationView(generation), requestId }, { status: 202 });
  } catch (error) {
    if (episodeId) await failEpisodePlan(episodeId, "사진 영상 생성을 시작하지 못했습니다.");
    logServerError("photo-video.start", error, requestId);
    return jsonError("사진 영상 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
