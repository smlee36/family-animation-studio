import "server-only";

import { issueSignedToken, presignUrl, put } from "@vercel/blob";
import { getEpisode, saveEpisodeFinalVideo } from "@/lib/episodes/storage";
import type { FinalVideoRecord } from "@/lib/episodes/types";
import { episodeFinalVideoPath, getGeneration } from "@/lib/generations/storage";

type MergeJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage?: string;
  error?: string;
  duration_seconds?: number;
};

const MAX_FINAL_VIDEO_BYTES = 2 * 1024 * 1024 * 1024;

function apiConfig() {
  const baseUrl = process.env.LTX_API_BASE?.trim().replace(/\/+$/, "");
  const apiKey = process.env.LTX_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("LTX_API_BASE or LTX_API_KEY is not configured");
  return { baseUrl, apiKey };
}

function authenticatedHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "User-Agent": "family-animation-studio/1.0" };
}

export async function startFinalVideoMerge(episodeId: string, finalVideoId: string) {
  const episode = await getEpisode(episodeId);
  if (!episode?.plan) throw new Error("Episode plan was not found");

  const orderedShots = episode.plan.scenes.flatMap((scene) => scene.shots);
  const generations = await Promise.all(orderedShots.map(async (shot) => {
    const generationId = episode.generationIdsByShot[shot.id];
    return generationId ? getGeneration(generationId) : null;
  }));
  const unavailable = orderedShots.filter((_, index) => {
    const generation = generations[index];
    return !generation || generation.status !== "ready" || generation.approvalStatus !== "approved" || !generation.videoPathname;
  });
  if (unavailable.length) {
    throw new Error(`승인 완료되지 않은 Shot이 ${unavailable.length}개 있습니다.`);
  }

  const readyGenerations = generations.filter((generation): generation is NonNullable<typeof generation> => Boolean(generation));
  const validUntil = Date.now() + 60 * 60 * 1000;
  const signedToken = await issueSignedToken({ operations: ["get"], validUntil });
  const clips = await Promise.all(readyGenerations.map(async (generation) => {
    const { presignedUrl } = await presignUrl(signedToken, {
      operation: "get",
      pathname: generation.videoPathname,
      access: "private",
      validUntil,
      useCache: true,
    });
    return { url: presignedUrl, generation_id: generation.id };
  }));

  const now = new Date().toISOString();
  let record: FinalVideoRecord = {
    id: finalVideoId,
    status: "generating",
    operationName: finalVideoId,
    videoPathname: "",
    shotGenerationIds: readyGenerations.map((generation) => generation.id),
    durationSeconds: readyGenerations.reduce((total, generation) => total + generation.durationSeconds, 0),
    aspectRatio: episode.format === "landscape" ? "16:9" : "9:16",
    transition: "hard_cut",
    backendStatus: "B200 병합 대기열에 등록 중",
    error: "",
    createdAt: now,
    updatedAt: now,
  };
  await saveEpisodeFinalVideo(episodeId, record);

  try {
    const { baseUrl, apiKey } = apiConfig();
    const response = await fetch(`${baseUrl}/merges`, {
      method: "POST",
      headers: { ...authenticatedHeaders(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({ merge_id: finalVideoId, clips, aspect_ratio: record.aspectRatio, transition: "hard_cut" }),
      cache: "no-store",
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.json() as MergeJob & { detail?: string };
    if (!response.ok) throw new Error(body.detail || `LTX merge submission failed with ${response.status}`);
    record = { ...record, backendStatus: body.stage || "B200 병합 대기 중", updatedAt: new Date().toISOString() };
    await saveEpisodeFinalVideo(episodeId, record);
    return record;
  } catch (error) {
    record = {
      ...record,
      status: "failed",
      backendStatus: "최종 영상 병합을 시작하지 못함",
      error: error instanceof Error ? error.message : "최종 영상 병합을 시작하지 못했습니다.",
      updatedAt: new Date().toISOString(),
    };
    await saveEpisodeFinalVideo(episodeId, record);
    return record;
  }
}

export async function refreshFinalVideoMerge(episodeId: string) {
  const episode = await getEpisode(episodeId);
  const record = episode?.finalVideo;
  if (!record || record.status !== "generating") return record || null;

  const { baseUrl, apiKey } = apiConfig();
  const response = await fetch(`${baseUrl}/merges/${record.operationName}`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LTX merge polling failed with ${response.status}`);
  const job = await response.json() as MergeJob;

  if (job.status === "failed") {
    const failed: FinalVideoRecord = {
      ...record,
      status: "failed",
      backendStatus: job.stage || "B200 병합 실패",
      error: job.error || "B200에서 최종 영상을 합치지 못했습니다.",
      updatedAt: new Date().toISOString(),
    };
    await saveEpisodeFinalVideo(episodeId, failed);
    return failed;
  }

  if (job.status !== "succeeded") {
    const generating: FinalVideoRecord = {
      ...record,
      backendStatus: job.stage || (job.status === "running" ? "B200에서 영상 합치는 중" : "B200 병합 대기 중"),
      updatedAt: new Date().toISOString(),
    };
    await saveEpisodeFinalVideo(episodeId, generating);
    return generating;
  }

  const videoResponse = await fetch(`${baseUrl}/merges/${record.operationName}/video`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!videoResponse.ok || !videoResponse.body) throw new Error(`LTX merged video download failed with ${videoResponse.status}`);
  const contentLength = Number(videoResponse.headers.get("content-length") || "0");
  if (contentLength > MAX_FINAL_VIDEO_BYTES) throw new Error("Merged video exceeds the storage limit");
  const pathname = episodeFinalVideoPath(episodeId, record.id);
  await put(pathname, videoResponse.body, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "video/mp4",
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
  const ready: FinalVideoRecord = {
    ...record,
    status: "ready",
    videoPathname: pathname,
    durationSeconds: typeof job.duration_seconds === "number" ? job.duration_seconds : record.durationSeconds,
    backendStatus: "최종 영상 완성",
    error: "",
    updatedAt: new Date().toISOString(),
  };
  await saveEpisodeFinalVideo(episodeId, ready);
  return ready;
}
