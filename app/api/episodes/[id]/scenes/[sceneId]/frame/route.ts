import { randomUUID } from "node:crypto";
import { ApiError } from "@google/genai";
import { get, put } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getEpisode, saveSceneFrame } from "@/lib/episodes/storage";
import type { SceneFrameRecord } from "@/lib/episodes/types";
import { generateSceneFrameImage, SceneMasterFrameError } from "@/lib/generations/veo";

export const maxDuration = 180;

function validId(value: string) {
  return /^[0-9a-f-]{36}$/i.test(value);
}

function sceneFramePath(episodeId: string, sceneId: string, frameId: string) {
  return `episodes/scene-frames/${episodeId}/${sceneId}/${frameId}.jpg`;
}

async function episodeScene(id: string, sceneId: string) {
  const episode = await getEpisode(id);
  const scene = episode?.plan?.scenes.find((item) => item.id === sceneId);
  return { episode, scene };
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id, sceneId } = await params;
    if (!validId(id) || !/^scene-\d{1,2}$/i.test(sceneId)) return jsonError("Scene 번호가 올바르지 않습니다.", 400, requestId);
    const episode = await getEpisode(id);
    const frame = episode?.sceneFrames?.[sceneId];
    if (!frame?.imagePathname) return jsonError("Scene 기준 이미지를 찾을 수 없습니다.", 404, requestId);
    const blob = await get(frame.imagePathname, { access: "private", useCache: true });
    if (!blob?.stream || blob.statusCode !== 200) return jsonError("Scene 기준 이미지를 불러오지 못했습니다.", 404, requestId);
    return new NextResponse(blob.stream, {
      headers: {
        "Content-Type": frame.contentType || blob.blob.contentType || "image/jpeg",
        "Content-Length": String(blob.blob.size),
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (error) {
    logServerError("scene-frame.get", error, requestId);
    return jsonError("Scene 기준 이미지를 불러오지 못했습니다.", 500, requestId);
  }
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id, sceneId } = await params;
    if (!validId(id) || !/^scene-\d{1,2}$/i.test(sceneId)) return jsonError("Scene 번호가 올바르지 않습니다.", 400, requestId);
    const { episode, scene } = await episodeScene(id, sceneId);
    if (!episode || !scene) return jsonError("저장된 Scene을 찾을 수 없습니다.", 404, requestId);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const revisionInstruction = typeof body.instruction === "string" ? body.instruction.trim().slice(0, 500) : "";
    const referenceIds = [...new Set([
      ...(scene.sceneMasterReferenceId ? [scene.sceneMasterReferenceId] : []),
      ...scene.shots.flatMap((shot) => shot.referenceIds),
    ])].slice(0, 6);
    const firstShot = scene.shots[0];
    const aspectRatio = episode.format === "reels" ? "9:16" as const : "16:9" as const;
    const prompt = `SCENE ${scene.number}: ${scene.title}\nSetting: ${scene.setting}\nStory beat: ${scene.summary}\nExact opening state: ${firstShot.startState}\nFirst visible action to leave room for: ${firstShot.action}${revisionInstruction ? `\nUser revision, highest priority: ${revisionInstruction}` : ""}\nCompose this as a mobile-first ${aspectRatio} animation keyframe. Keep the important faces, hands, and story objects near the central safe area. This image will be shown to the family for approval and then used as the exact first video frame.`;
    const frameId = randomUUID();
    const imagePathname = sceneFramePath(id, sceneId, frameId);
    const generated = await generateSceneFrameImage({ id: frameId, prompt, referenceIds, aspectRatio, pathname: imagePathname });
    await put(imagePathname, generated.bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: generated.mimeType,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
    const now = new Date().toISOString();
    const frame: SceneFrameRecord = {
      id: frameId,
      sceneId,
      prompt,
      revisionInstruction,
      referenceIds: generated.usedReferenceIds,
      imagePathname,
      contentType: generated.mimeType,
      model: generated.model,
      approvalStatus: "pending",
      error: "",
      createdAt: now,
      updatedAt: now,
    };
    await saveSceneFrame(id, frame);
    console.info(`[scene-frame.create] requestId=${requestId} episodeId=${id} sceneId=${sceneId} frameId=${frameId} aspectRatio=${aspectRatio} references=${generated.usedReferenceIds.length}`);
    return NextResponse.json({ frame, requestId });
  } catch (error) {
    logServerError("scene-frame.create", error, requestId);
    const status = error instanceof ApiError ? error.status : 0;
    if (status === 429) return jsonError("장면 이미지 생성 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.", 429, requestId);
    if (status === 401 || status === 403) return jsonError("장면 이미지 모델의 연결 권한을 확인해 주세요.", 503, requestId);
    if (error instanceof SceneMasterFrameError) return jsonError("가족 레퍼런스에 맞는 장면 이미지를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.", 503, requestId);
    return jsonError("Scene 기준 이미지를 만들지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string; sceneId: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id, sceneId } = await params;
    if (!validId(id) || !/^scene-\d{1,2}$/i.test(sceneId)) return jsonError("Scene 번호가 올바르지 않습니다.", 400, requestId);
    const episode = await getEpisode(id);
    const current = episode?.sceneFrames?.[sceneId];
    if (!episode || !current) return jsonError("승인할 Scene 기준 이미지를 찾을 수 없습니다.", 404, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    const frame: SceneFrameRecord = {
      ...current,
      approvalStatus: body.approved === true ? "approved" : "pending",
      updatedAt: new Date().toISOString(),
    };
    await saveSceneFrame(id, frame);
    console.info(`[scene-frame.approve] requestId=${requestId} episodeId=${id} sceneId=${sceneId} approved=${frame.approvalStatus === "approved"}`);
    return NextResponse.json({ frame, requestId });
  } catch (error) {
    logServerError("scene-frame.approve", error, requestId);
    return jsonError("Scene 기준 이미지 승인을 저장하지 못했습니다.", 500, requestId);
  }
}
