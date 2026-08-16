import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getEpisode, linkGenerationToEpisode } from "@/lib/episodes/storage";
import { getGeneration } from "@/lib/generations/storage";
import { generationView } from "@/lib/generations/types";

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const { id: episodeId } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    const shotId = typeof body.shotId === "string" ? body.shotId.trim() : "";
    const generationId = typeof body.generationId === "string" ? body.generationId.trim() : "";
    if (!/^[0-9a-f-]{36}$/i.test(episodeId) || !shotId || !/^[0-9a-f-]{36}$/i.test(generationId)) {
      return jsonError("영상 버전 정보가 올바르지 않습니다.", 400, requestId);
    }
    const [episode, generation] = await Promise.all([getEpisode(episodeId), getGeneration(generationId)]);
    if (!episode || !generation || generation.episodeId !== episodeId || generation.shotId !== shotId || generation.status !== "ready") {
      return jsonError("복원할 영상 버전을 찾을 수 없습니다.", 404, requestId);
    }
    await linkGenerationToEpisode(episodeId, shotId, generationId);
    return NextResponse.json({ generation: generationView(generation), requestId });
  } catch (error) {
    logServerError("episode.generation.restore", error, requestId);
    return jsonError("이전 영상 버전을 복원하지 못했습니다.", 500, requestId);
  }
}
