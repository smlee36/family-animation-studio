import "server-only";

import { get, put } from "@vercel/blob";
import { GoogleGenAI, VideoGenerationReferenceType, type VideoGenerationReferenceImage } from "@google/genai";
import type { ShotGenerationRecord, VeoQualityTier } from "@/lib/generations/types";
import { generationVideoPath, saveGeneration } from "@/lib/generations/storage";
import { getReference } from "@/lib/references/storage";

const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const MINOR_PATTERN = /\b(child|kid|toddler|baby|boy|girl|infant)\b|아이|아기/i;

function apiKey() {
  const value = process.env.GEMINI_API_KEY?.trim();
  if (!value) throw new Error("GEMINI_API_KEY is not configured");
  return value;
}

function nearestDuration(value: number): 4 | 6 | 8 {
  if (value <= 5) return 4;
  if (value <= 7) return 6;
  return 8;
}

async function loadReferences(referenceIds: string[], allowReferences: boolean) {
  const requested = [...new Set(referenceIds)].slice(0, 3);
  if (!allowReferences) return { images: [] as VideoGenerationReferenceImage[], used: [], omitted: requested };

  const images: VideoGenerationReferenceImage[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  for (const id of requested) {
    const reference = await getReference(id);
    if (!reference || reference.size > MAX_REFERENCE_BYTES || reference.category === "아이" || reference.category === "스토리보드") {
      omitted.push(id);
      continue;
    }
    const blob = await get(reference.imagePathname, { access: "private", useCache: true });
    if (!blob?.stream || blob.statusCode !== 200) {
      omitted.push(id);
      continue;
    }
    const bytes = await new Response(blob.stream).arrayBuffer();
    images.push({
      image: { imageBytes: Buffer.from(bytes).toString("base64"), mimeType: reference.contentType },
      referenceType: VideoGenerationReferenceType.ASSET,
    });
    used.push(id);
  }
  return { images, used, omitted };
}

export async function startVeoGeneration(input: {
  id: string;
  shotId: string;
  prompt: string;
  estimatedSeconds: number;
  referenceIds: string[];
  qualityTier?: VeoQualityTier;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
}) {
  const containsMinor = MINOR_PATTERN.test(input.prompt);
  const references = await loadReferences(input.referenceIds, !containsMinor);
  const durationSeconds = references.images.length ? 8 : nearestDuration(input.estimatedSeconds);
  const qualityTier = input.qualityTier || "fast";
  const model = qualityTier === "fast"
    ? process.env.GEMINI_VEO_FAST_MODEL?.trim() || "veo-3.1-fast-generate-preview"
    : process.env.GEMINI_VEO_STANDARD_MODEL?.trim() || process.env.GEMINI_VEO_MODEL?.trim() || "veo-3.1-generate-preview";
  const ai = new GoogleGenAI({ apiKey: apiKey() });
  const operation = await ai.models.generateVideos({
    model,
    source: { prompt: input.prompt },
    config: {
      numberOfVideos: 1,
      durationSeconds,
      aspectRatio: "16:9",
      resolution: "720p",
      personGeneration: references.images.length ? "allow_adult" : "allow_all",
      ...(references.images.length ? { referenceImages: references.images } : {}),
    },
  });
  if (!operation.name) throw new Error("Veo did not return an operation name");

  const now = new Date().toISOString();
  const record: ShotGenerationRecord = {
    version: 1,
    id: input.id,
    shotId: input.shotId,
    operationName: operation.name,
    model,
    prompt: input.prompt,
    status: "generating",
    durationSeconds,
    usedReferenceIds: references.used,
    omittedReferenceIds: references.omitted,
    videoPathname: "",
    error: "",
    createdAt: now,
    updatedAt: now,
    qualityTier,
    autoRegenerationCount: Math.min(2, Math.max(0, input.autoRegenerationCount || 0)),
    parentGenerationId: input.parentGenerationId || "",
    approvalStatus: "pending",
    qc: null,
  };
  await saveGeneration(record);
  return record;
}

type RawOperation = {
  done?: boolean;
  error?: { message?: string; code?: number; status?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; mimeType?: string } }>;
      raiMediaFilteredReasons?: string[];
    };
  };
};

export async function refreshVeoGeneration(record: ShotGenerationRecord) {
  if (record.status !== "generating") return record;
  const key = apiKey();
  const statusResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${record.operationName}`, {
    headers: { "x-goog-api-key": key },
    cache: "no-store",
  });
  if (!statusResponse.ok) throw new Error(`Veo operation polling failed with ${statusResponse.status}`);
  const operation = (await statusResponse.json()) as RawOperation;
  if (!operation.done) return record;

  if (operation.error) {
    const failed = { ...record, status: "failed" as const, error: operation.error.message || "Veo generation failed", updatedAt: new Date().toISOString() };
    await saveGeneration(failed);
    return failed;
  }

  const videoUri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!videoUri) {
    const reason = operation.response?.generateVideoResponse?.raiMediaFilteredReasons?.join(", ");
    const failed = { ...record, status: "failed" as const, error: reason || "Veo returned no generated video", updatedAt: new Date().toISOString() };
    await saveGeneration(failed);
    return failed;
  }

  const videoResponse = await fetch(videoUri, { headers: { "x-goog-api-key": key }, redirect: "follow" });
  if (!videoResponse.ok) throw new Error(`Veo video download failed with ${videoResponse.status}`);
  const videoBytes = await videoResponse.arrayBuffer();
  const pathname = generationVideoPath(record.id);
  await put(pathname, videoBytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: videoResponse.headers.get("content-type") || "video/mp4",
    cacheControlMaxAge: 3600,
  });
  const ready = { ...record, status: "ready" as const, videoPathname: pathname, updatedAt: new Date().toISOString() };
  await saveGeneration(ready);
  return ready;
}
