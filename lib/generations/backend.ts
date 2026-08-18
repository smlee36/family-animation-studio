import "server-only";

import type { DirectorShot } from "@/lib/director/types";
import { refreshLtxGeneration, startLtxGeneration } from "@/lib/generations/ltx";
import { selectVideoProvider } from "@/lib/generations/router";
import type { ActualVideoGenerationProvider, LtxPreset, LtxRenderMode, LtxSequenceMode, ShotGenerationRecord, VideoAspectRatio, VideoGenerationProvider, VeoQualityTier } from "@/lib/generations/types";
import { refreshVeoGeneration, startVeoGeneration, type ContinuityFrameInput } from "@/lib/generations/veo";
import { refreshWanGeneration, startWanGeneration } from "@/lib/generations/wan";

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
  ltxSequenceMode?: LtxSequenceMode;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  continuityFrame?: ContinuityFrameInput;
  keyframes?: ContinuityFrameInput[];
  aspectRatio?: VideoAspectRatio;
  shot?: DirectorShot;
  retryReason?: string;
  qcFallbackProvider?: ActualVideoGenerationProvider;
};

export function defaultVideoProvider(): VideoGenerationProvider {
  const configured = process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase();
  if (configured === "google" || configured === "ltx" || configured === "wan" || configured === "auto") return configured;
  return process.env.LTX_API_BASE?.trim() && process.env.LTX_API_KEY?.trim() ? "auto" : "google";
}

export async function startVideoGeneration(input: StartVideoGenerationInput) {
  const routing = selectVideoProvider({
    // The current Wan worker accepts one start image. A three-keyframe photo
    // sequence must stay on LTX until Wan gains equivalent conditioning.
    requestedProvider: input.keyframes?.length ? "ltx" : input.provider || defaultVideoProvider(),
    shot: input.shot,
    retryReason: input.retryReason,
    qcFallbackProvider: input.qcFallbackProvider,
  });
  const routedInput = { ...input, routing };
  if (routing.selectedProvider === "ltx") return startLtxGeneration(routedInput);
  if (routing.selectedProvider === "wan") return startWanGeneration(routedInput);
  const record = await startVeoGeneration(routedInput);
  if (record.provider === "google") return record;
  return { ...record, provider: "google" as const };
}

export async function refreshVideoGeneration(record: ShotGenerationRecord) {
  const provider = record.provider || (record.model.toLowerCase().includes("ltx") ? "ltx" : record.model.toLowerCase().includes("wan") ? "wan" : "google");
  if (provider === "ltx") return refreshLtxGeneration(record);
  if (provider === "wan") return refreshWanGeneration(record);
  return refreshVeoGeneration(record);
}
