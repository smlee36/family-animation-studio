import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getEpisode } from "@/lib/episodes/storage";
import { refreshFinalVideoMerge, startFinalVideoMerge } from "@/lib/generations/final-video";

export const maxDuration = 120;

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("Episode 번호가 올바르지 않습니다.", 400, requestId);
    const episode = await getEpisode(id);
    if (!episode) return jsonError("저장된 Episode를 찾을 수 없습니다.", 404, requestId);
    if (episode.finalVideo?.status === "generating") {
      return NextResponse.json({ finalVideo: episode.finalVideo, requestId });
    }
    const finalVideo = await startFinalVideoMerge(id, randomUUID());
    if (finalVideo.status === "failed") return jsonError(finalVideo.error || "최종 영상 병합을 시작하지 못했습니다.", 502, requestId);
    console.info(`[final-video.start] requestId=${requestId} episodeId=${id} finalVideoId=${finalVideo.id} shots=${finalVideo.shotGenerationIds.length}`);
    return NextResponse.json({ finalVideo, requestId }, { status: 202 });
  } catch (error) {
    logServerError("final-video.start", error, requestId);
    const message = error instanceof Error && /승인 완료되지 않은 Shot/.test(error.message)
      ? error.message
      : "최종 영상 병합을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    return jsonError(message, 400, requestId);
  }
}

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("Episode 번호가 올바르지 않습니다.", 400, requestId);
    const episode = await getEpisode(id);
    if (!episode) return jsonError("저장된 Episode를 찾을 수 없습니다.", 404, requestId);
    const finalVideo = await refreshFinalVideoMerge(id);
    return NextResponse.json({ finalVideo, requestId });
  } catch (error) {
    logServerError("final-video.poll", error, requestId);
    return jsonError("최종 영상 상태를 확인하지 못했습니다.", 500, requestId);
  }
}
