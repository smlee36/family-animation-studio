import "server-only";

import { put } from "@vercel/blob";
import { linkGenerationToEpisode } from "@/lib/episodes/storage";
import { prepareStartFrame } from "@/lib/generations/ltx";
import { generationVideoPath, saveGeneration } from "@/lib/generations/storage";
import type {
  ShotGenerationRecord,
  VideoAspectRatio,
  VideoRoutingDecision,
} from "@/lib/generations/types";
import type { ContinuityFrameInput } from "@/lib/generations/veo";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

type WanJob = {
  id: string;
  status: "queued" | "loading" | "running" | "succeeded" | "failed";
  stage?: string;
  error?: string;
  queue_position?: number;
  started_at?: string;
  estimated_seconds_remaining?: number;
};

function apiConfig() {
  const baseUrl = process.env.WAN_API_BASE?.trim().replace(/\/+$/, "");
  const apiKey = process.env.WAN_API_KEY?.trim() || process.env.LTX_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("WAN_API_BASE or WAN_API_KEY is not configured");
  return { baseUrl, apiKey };
}

function authenticatedHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "User-Agent": "family-animation-studio/1.0" };
}

export async function getWanServiceStatus() {
  try {
    const { baseUrl, apiKey } = apiConfig();
    const response = await fetch(`${baseUrl}/health`, {
      headers: authenticatedHeaders(apiKey),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { reachable: false, model: "", queueDepth: 0 };
    const body = await response.json() as { ok?: boolean; model?: string; queue_depth?: number };
    return {
      reachable: body.ok === true,
      model: typeof body.model === "string" ? body.model : "",
      queueDepth: typeof body.queue_depth === "number" ? body.queue_depth : 0,
    };
  } catch {
    return { reachable: false, model: "", queueDepth: 0 };
  }
}

export async function startWanGeneration(input: {
  id: string;
  episodeId?: string;
  shotId: string;
  prompt: string;
  estimatedSeconds: number;
  referenceIds: string[];
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  continuityFrame?: ContinuityFrameInput;
  aspectRatio?: VideoAspectRatio;
  routing?: VideoRoutingDecision;
}) {
  const aspectRatio = input.aspectRatio || "16:9";
  const durationSeconds = input.estimatedSeconds < 8 ? 5 : 10;
  const now = new Date().toISOString();
  let record: ShotGenerationRecord = {
    version: 1,
    id: input.id,
    episodeId: input.episodeId || "",
    shotId: input.shotId,
    operationName: input.id,
    model: "Wan 2.2 I2V-A14B",
    provider: "wan",
    routing: input.routing,
    backendStatus: "Wan 시작 프레임 준비 중",
    backendQueuePosition: 0,
    backendStartedAt: "",
    estimatedSecondsRemaining: 0,
    sourcePrompt: input.prompt,
    prompt: input.prompt,
    continuitySourceGenerationId: input.continuityFrame?.sourceGenerationId || "",
    continuityFramePathname: input.continuityFrame?.pathname || "",
    continuityFrameMimeType: input.continuityFrame?.mimeType || "",
    initialFrameKind: input.continuityFrame?.kind,
    initialFrameModel: input.continuityFrame?.model || "",
    status: "generating",
    durationSeconds,
    aspectRatio,
    usedReferenceIds: [],
    omittedReferenceIds: [],
    videoPathname: "",
    error: "",
    createdAt: now,
    updatedAt: now,
    qualityTier: "standard",
    autoRegenerationCount: Math.min(2, Math.max(0, input.autoRegenerationCount || 0)),
    parentGenerationId: input.parentGenerationId || "",
    approvalStatus: "pending",
    qc: null,
  };
  await saveGeneration(record);
  if (record.episodeId) await linkGenerationToEpisode(record.episodeId, record.shotId, record.id);

  try {
    const startFrame = await prepareStartFrame({ ...input, aspectRatio });
    record = {
      ...record,
      continuitySourceGenerationId: startFrame.sourceGenerationId,
      continuityFramePathname: startFrame.pathname,
      continuityFrameMimeType: startFrame.mimeType,
      initialFrameKind: startFrame.kind,
      initialFrameModel: startFrame.model,
      usedReferenceIds: startFrame.usedReferenceIds,
      omittedReferenceIds: startFrame.omittedReferenceIds,
      backendStatus: "B200 Wan 대기열에 등록 중",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(record);

    const { baseUrl, apiKey } = apiConfig();
    const form = new FormData();
    form.set("job_id", record.id);
    form.set("prompt", record.prompt);
    form.set("aspect_ratio", aspectRatio);
    form.set("duration_seconds", String(durationSeconds));
    form.set("seed", "42");
    form.set("image", new Blob([new Uint8Array(startFrame.bytes)], { type: startFrame.mimeType }), "start-image");
    const response = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: authenticatedHeaders(apiKey),
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`Wan job submission failed with ${response.status}`);
    const job = await response.json() as WanJob;
    record = {
      ...record,
      operationName: job.id || record.id,
      backendStatus: job.stage || "Wan 생성 대기 중",
      backendQueuePosition: Math.max(0, job.queue_position || 0),
      backendStartedAt: job.started_at || "",
      estimatedSecondsRemaining: Math.max(0, job.estimated_seconds_remaining || 0),
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(record);
    return record;
  } catch (error) {
    const failed = {
      ...record,
      status: "failed" as const,
      backendStatus: "Wan 연결 실패",
      error: "B200 Wan 영상 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(failed);
    throw error;
  }
}

export async function refreshWanGeneration(record: ShotGenerationRecord) {
  if (record.status !== "generating") return record;
  const { baseUrl, apiKey } = apiConfig();
  const response = await fetch(`${baseUrl}/jobs/${record.operationName}`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Wan job polling failed with ${response.status}`);
  const job = await response.json() as WanJob;
  if (job.status === "queued" || job.status === "loading" || job.status === "running") {
    const pending = {
      ...record,
      backendStatus: job.stage || "B200 Wan 영상 생성 중",
      backendQueuePosition: Math.max(0, job.queue_position || 0),
      backendStartedAt: job.started_at || record.backendStartedAt || "",
      estimatedSecondsRemaining: Math.max(0, job.estimated_seconds_remaining || 0),
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(pending);
    return pending;
  }
  if (job.status === "failed") {
    console.error(`[wan.failed] generationId=${record.id} jobId=${job.id}`, job.error || "Unknown Wan worker error");
    const failed = {
      ...record,
      status: "failed" as const,
      backendStatus: "B200 Wan 생성 실패",
      error: "B200에서 고난도 영상을 만들지 못했습니다. 다시 시도해 주세요.",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(failed);
    return failed;
  }

  if (record.backendStatus !== "Wan 완성 영상을 안전하게 저장 중") {
    const storing = {
      ...record,
      backendStatus: "Wan 완성 영상을 안전하게 저장 중",
      backendQueuePosition: 0,
      estimatedSecondsRemaining: 15,
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(storing);
    return storing;
  }

  const videoResponse = await fetch(`${baseUrl}/jobs/${record.operationName}/video`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!videoResponse.ok) throw new Error(`Wan video download failed with ${videoResponse.status}`);
  const videoBytes = await videoResponse.arrayBuffer();
  if (!videoBytes.byteLength || videoBytes.byteLength > MAX_VIDEO_BYTES) throw new Error("Wan video is empty or too large");
  const videoPathname = generationVideoPath(record.id);
  await put(videoPathname, videoBytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: videoResponse.headers.get("content-type") || "video/mp4",
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
  const ready = {
    ...record,
    status: "ready" as const,
    backendStatus: "Wan 고난도 영상 생성 완료",
    backendQueuePosition: 0,
    estimatedSecondsRemaining: 0,
    videoPathname,
    error: "",
    updatedAt: new Date().toISOString(),
  };
  await saveGeneration(ready);
  return ready;
}
