import "server-only";

import { get, put } from "@vercel/blob";
import { linkGenerationToEpisode } from "@/lib/episodes/storage";
import {
  generationContinuityFramePath,
  generationSceneMasterFramePath,
  generationVideoPath,
  saveGeneration,
} from "@/lib/generations/storage";
import type {
  LtxPreset,
  ShotGenerationRecord,
  VideoAspectRatio,
} from "@/lib/generations/types";
import { generateSceneFrameImage, type ContinuityFrameInput } from "@/lib/generations/veo";

const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

type LtxJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage?: string;
  error?: string;
};

function apiConfig() {
  const baseUrl = process.env.LTX_API_BASE?.trim().replace(/\/+$/, "");
  const apiKey = process.env.LTX_API_KEY?.trim();
  if (!baseUrl || !apiKey) throw new Error("LTX_API_BASE or LTX_API_KEY is not configured");
  return { baseUrl, apiKey };
}

function duration(value: number): 4 | 6 | 8 {
  if (value <= 5) return 4;
  if (value <= 7) return 6;
  return 8;
}

function authenticatedHeaders(apiKey: string) {
  return { Authorization: `Bearer ${apiKey}`, "User-Agent": "family-animation-studio/1.0" };
}

export async function getLtxServiceStatus() {
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

async function readPrivateBlob(pathname: string) {
  const result = await get(pathname, { access: "private", useCache: true });
  if (!result?.stream || result.statusCode !== 200) throw new Error("LTX start frame could not be read");
  return {
    bytes: Buffer.from(await new Response(result.stream).arrayBuffer()),
    mimeType: result.blob.contentType || "image/jpeg",
  };
}

async function prepareStartFrame(input: {
  id: string;
  prompt: string;
  referenceIds: string[];
  aspectRatio: VideoAspectRatio;
  continuityFrame?: ContinuityFrameInput;
}) {
  const frame = input.continuityFrame;
  if (frame?.data && frame.mimeType) {
    const bytes = Buffer.from(frame.data, "base64");
    if (!bytes.length) throw new Error("LTX start frame is empty");
    const kind = frame.kind || "continuity";
    const pathname = kind === "scene_master" ? generationSceneMasterFramePath(input.id) : generationContinuityFramePath(input.id);
    await put(pathname, bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: frame.mimeType,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
    return {
      bytes,
      mimeType: frame.mimeType,
      pathname,
      kind,
      model: frame.model || "uploaded-continuity-frame",
      sourceGenerationId: frame.sourceGenerationId || "",
      usedReferenceIds: input.referenceIds,
      omittedReferenceIds: [] as string[],
    };
  }
  if (frame?.pathname) {
    const loaded = await readPrivateBlob(frame.pathname);
    return {
      ...loaded,
      pathname: frame.pathname,
      kind: frame.kind || "continuity",
      model: frame.model || "stored-continuity-frame",
      sourceGenerationId: frame.sourceGenerationId || "",
      usedReferenceIds: input.referenceIds,
      omittedReferenceIds: [] as string[],
    };
  }

  const pathname = generationSceneMasterFramePath(input.id);
  const generated = await generateSceneFrameImage({
    id: input.id,
    prompt: input.prompt,
    referenceIds: input.referenceIds,
    aspectRatio: input.aspectRatio,
    pathname,
  });
  await put(pathname, generated.bytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: generated.mimeType,
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
  return {
    bytes: generated.bytes,
    mimeType: generated.mimeType,
    pathname,
    kind: "scene_master" as const,
    model: generated.model,
    sourceGenerationId: "",
    usedReferenceIds: generated.usedReferenceIds,
    omittedReferenceIds: generated.omittedReferenceIds,
  };
}

export async function startLtxGeneration(input: {
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
  ltxPreset?: LtxPreset;
}) {
  const aspectRatio = input.aspectRatio || "16:9";
  const durationSeconds = duration(input.estimatedSeconds);
  const now = new Date().toISOString();
  let record: ShotGenerationRecord = {
    version: 1,
    id: input.id,
    episodeId: input.episodeId || "",
    shotId: input.shotId,
    operationName: input.id,
    model: "LTX-2.5 Dev BF16",
    provider: "ltx",
    ltxPreset: input.ltxPreset || "gentle",
    backendStatus: "시작 프레임 준비 중",
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
      backendStatus: "B200 대기열에 등록 중",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(record);

    const { baseUrl, apiKey } = apiConfig();
    const form = new FormData();
    form.set("job_id", record.id);
    form.set("prompt", record.prompt);
    form.set("preset", record.ltxPreset || "gentle");
    form.set("aspect_ratio", aspectRatio);
    form.set("duration_seconds", String(durationSeconds));
    form.set("seed", "42");
    form.set("image", new Blob([new Uint8Array(startFrame.bytes)], { type: startFrame.mimeType }), `start.${startFrame.mimeType === "image/png" ? "png" : startFrame.mimeType === "image/webp" ? "webp" : "jpg"}`);
    const response = await fetch(`${baseUrl}/jobs`, {
      method: "POST",
      headers: authenticatedHeaders(apiKey),
      body: form,
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`LTX job submission failed with ${response.status}`);
    const job = await response.json() as LtxJob;
    record = { ...record, operationName: job.id || record.id, backendStatus: job.stage || "B200 생성 대기 중", updatedAt: new Date().toISOString() };
    await saveGeneration(record);
    return record;
  } catch (error) {
    const failed = {
      ...record,
      status: "failed" as const,
      backendStatus: "B200 연결 실패",
      error: "B200 LTX 영상 생성을 시작하지 못했습니다. 잠시 후 다시 시도해 주세요.",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(failed);
    throw error;
  }
}

export async function refreshLtxGeneration(record: ShotGenerationRecord) {
  if (record.status !== "generating") return record;
  const { baseUrl, apiKey } = apiConfig();
  const response = await fetch(`${baseUrl}/jobs/${record.operationName}`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`LTX job polling failed with ${response.status}`);
  const job = await response.json() as LtxJob;
  if (job.status === "queued" || job.status === "running") {
    if ((job.stage || "") === (record.backendStatus || "")) return record;
    const pending = { ...record, backendStatus: job.stage || "B200 영상 생성 중", updatedAt: new Date().toISOString() };
    await saveGeneration(pending);
    return pending;
  }
  if (job.status === "failed") {
    console.error(`[ltx.failed] generationId=${record.id} jobId=${job.id}`, job.error || "Unknown LTX worker error");
    const failed = {
      ...record,
      status: "failed" as const,
      backendStatus: "B200 생성 실패",
      error: "B200에서 영상을 만들지 못했습니다. 문의 번호와 함께 다시 시도해 주세요.",
      updatedAt: new Date().toISOString(),
    };
    await saveGeneration(failed);
    return failed;
  }

  const videoResponse = await fetch(`${baseUrl}/jobs/${record.operationName}/video`, {
    headers: authenticatedHeaders(apiKey),
    cache: "no-store",
    signal: AbortSignal.timeout(120_000),
  });
  if (!videoResponse.ok) throw new Error(`LTX video download failed with ${videoResponse.status}`);
  const contentLength = Number(videoResponse.headers.get("content-length") || "0");
  if (contentLength > MAX_VIDEO_BYTES) throw new Error("LTX video exceeds the storage limit");
  const videoBytes = await videoResponse.arrayBuffer();
  if (!videoBytes.byteLength || videoBytes.byteLength > MAX_VIDEO_BYTES) throw new Error("LTX video is empty or too large");
  const pathname = generationVideoPath(record.id);
  await put(pathname, videoBytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: videoResponse.headers.get("content-type") || "video/mp4",
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
  const ready = {
    ...record,
    status: "ready" as const,
    backendStatus: "완료",
    videoPathname: pathname,
    updatedAt: new Date().toISOString(),
  };
  await saveGeneration(ready);
  return ready;
}
