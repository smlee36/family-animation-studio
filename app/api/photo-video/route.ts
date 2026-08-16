import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import type { DirectorPlan } from "@/lib/director/types";
import { completeEpisodePlan, createEpisodeDraft, failEpisodePlan, saveSceneFrame } from "@/lib/episodes/storage";
import type { EpisodeFormat, SceneFrameRecord } from "@/lib/episodes/types";
import { startVideoGeneration } from "@/lib/generations/backend";
import { setLtxBatchMode } from "@/lib/generations/ltx";
import { generationView, type LtxPreset, type LtxRenderMode } from "@/lib/generations/types";
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
  let planCompleted = false;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const legacyInputId = typeof body.inputId === "string" ? body.inputId.trim() : "";
    const inputIds = [...new Set([
      ...(Array.isArray(body.inputIds) ? body.inputIds.filter((id): id is string => typeof id === "string").map((id) => id.trim()) : []),
      ...(legacyInputId ? [legacyInputId] : []),
    ])];
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    const format: EpisodeFormat = body.format === "landscape" ? "landscape" : "reels";
    const durationSeconds = body.durationSeconds === 6 || body.durationSeconds === 8 ? body.durationSeconds : 4;
    const renderMode: LtxRenderMode = body.renderMode === "final" ? "final" : "preview";
    const highSpeedBatch = body.highSpeedBatch !== false;
    if (!inputIds.length || inputIds.length > 10 || inputIds.some((id) => !/^[0-9a-f-]{36}$/i.test(id)) || instruction.length > 1_000) {
      return jsonError("사진 또는 움직임 설명을 확인해 주세요.", 400, requestId);
    }

    const loadedInputs = await Promise.all(inputIds.map((id) => getStoryInput(id)));
    if (loadedInputs.some((input) => !input || input.kind !== "photo")) return jsonError("영상으로 만들 사진을 찾을 수 없습니다.", 404, requestId);
    const inputs = loadedInputs.filter((input): input is NonNullable<typeof input> => Boolean(input));

    if (highSpeedBatch) {
      await setLtxBatchMode(true);
    }

    episodeId = randomUUID();
    const prompt = buildPrompt(instruction);
    const titleBase = inputs[0].name.replace(/\.[^.]+$/, "").trim().slice(0, 40) || "가족 사진";
    const title = inputs.length === 1 ? `${titleBase} 영상` : `${titleBase} 외 ${inputs.length - 1}장 영상`;
    const action = instruction || "사진 속 가족이 편안하게 숨을 쉬며 자연스럽게 미소 짓는다.";
    const scenes = inputs.map((input, index) => {
      const number = index + 1;
      const shotId = `${number}-1`;
      return {
        id: `scene-${number}`,
        number,
        title: inputs.length === 1 ? "사진 속 순간" : `사진 ${String(number).padStart(2, "0")} 속 순간`,
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
        input,
      };
    });
    const plan: DirectorPlan = {
      title,
      summary: `업로드한 사진 ${inputs.length}장을 각각 정확한 시작 화면으로 사용해 LTX 영상 ${inputs.length}개를 만듭니다.`,
      totalEstimatedSeconds: durationSeconds * inputs.length,
      totalShots: inputs.length,
      scenes: scenes.map(({ id, number, title: sceneTitle, summary, setting, sceneMasterReferenceId, shots }) => ({
        id,
        number,
        title: sceneTitle,
        summary,
        setting,
        sceneMasterReferenceId,
        shots,
      })),
    };

    await createEpisodeDraft(episodeId, action, inputs.map((input) => input.id), format);
    await completeEpisodePlan(episodeId, plan, []);
    planCompleted = true;
    const timestamp = new Date().toISOString();
    for (const scene of scenes) {
      const frame: SceneFrameRecord = {
        id: randomUUID(),
        sceneId: scene.id,
        prompt,
        revisionInstruction: "",
        referenceIds: [],
        imagePathname: scene.input.imagePathname,
        contentType: scene.input.contentType,
        model: "uploaded-photo",
        approvalStatus: "approved",
        error: "",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await saveSceneFrame(episodeId, frame);
    }

    const generations = [];
    let failedCount = 0;
    for (const scene of scenes) {
      try {
        const generation = await startVideoGeneration({
          id: randomUUID(),
          episodeId,
          shotId: scene.shots[0].id,
          prompt,
          estimatedSeconds: durationSeconds,
          referenceIds: [],
          provider: "ltx",
          ltxPreset: presetForInstruction(instruction),
          ltxRenderMode: renderMode,
          aspectRatio: format === "reels" ? "9:16" : "16:9",
          continuityFrame: {
            sourceGenerationId: "",
            pathname: scene.input.imagePathname,
            mimeType: scene.input.contentType,
            kind: "scene_master",
            model: "uploaded-photo",
          },
        });
        generations.push(generationView(generation));
      } catch (error) {
        failedCount += 1;
        logServerError("photo-video.batch-item", error, requestId);
      }
    }
    console.info(`[photo-video.start] requestId=${requestId} episodeId=${episodeId} requested=${inputs.length} started=${generations.length} failed=${failedCount} format=${format} duration=${durationSeconds} renderMode=${renderMode} highSpeedBatch=${highSpeedBatch}`);
    const warning = failedCount ? `${failedCount}개 영상은 등록하지 못했습니다. Episode에서 다시 시도해 주세요.` : "";
    return NextResponse.json({ episodeId, generation: generations[0], generations, warning, requestId }, { status: 202 });
  } catch (error) {
    if (episodeId && !planCompleted) await failEpisodePlan(episodeId, "사진 영상 생성을 시작하지 못했습니다.");
    logServerError("photo-video.start", error, requestId);
    return jsonError("사진 영상 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
