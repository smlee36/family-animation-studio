import "server-only";

import { refreshLtxGeneration, startLtxGeneration } from "@/lib/generations/ltx";
import type { LtxPreset, LtxRenderMode, ShotGenerationRecord, VideoAspectRatio, VideoGenerationProvider, VeoQualityTier } from "@/lib/generations/types";
import { refreshVeoGeneration, startVeoGeneration, type ContinuityFrameInput } from "@/lib/generations/veo";

export type StartVideoGenerationInput = {
  id: string;
  episodeId?: string;
  shotId: string;
  prompt: string;
  estimatedSeconds: number;
  referenceIds: string[];
  provider?: VideoGenerationProvider;
  qualityTier?: VeoQualityTier;
  ltxPreset?: LtxPreset;
  ltxRenderMode?: LtxRenderMode;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  continuityFrame?: ContinuityFrameInput;
  aspectRatio?: VideoAspectRatio;
};

export function defaultVideoProvider(): VideoGenerationProvider {
  const configured = process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase();
  if (configured === "google" || configured === "ltx") return configured;
  return process.env.LTX_API_BASE?.trim() && process.env.LTX_API_KEY?.trim() ? "ltx" : "google";
}

export async function startVideoGeneration(input: StartVideoGenerationInput) {
  const provider = input.provider || defaultVideoProvider();
  if (provider === "ltx") return startLtxGeneration(input);
  const record = await startVeoGeneration(input);
  if (record.provider === "google") return record;
  return { ...record, provider: "google" as const };
}

export async function refreshVideoGeneration(record: ShotGenerationRecord) {
  const provider = record.provider || (record.model.toLowerCase().includes("ltx") ? "ltx" : "google");
  return provider === "ltx" ? refreshLtxGeneration(record) : refreshVeoGeneration(record);
}
