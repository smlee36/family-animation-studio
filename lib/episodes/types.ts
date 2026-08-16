import type { DirectorPlan, DirectorReference } from "@/lib/director/types";
import type { ShotGenerationView } from "@/lib/generations/types";
import type { StoryInputView } from "@/lib/story-inputs/types";

export type EpisodeStatus = "planning" | "ready" | "failed";
export type EpisodeFormat = "landscape" | "reels";
export type SceneFrameApprovalStatus = "pending" | "approved";

export type SceneFrameRecord = {
  id: string;
  sceneId: string;
  prompt: string;
  revisionInstruction: string;
  referenceIds: string[];
  imagePathname: string;
  contentType: string;
  model: string;
  approvalStatus: SceneFrameApprovalStatus;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type EpisodeRecord = {
  version: 1;
  id: string;
  status: EpisodeStatus;
  title: string;
  story: string;
  format?: EpisodeFormat;
  storyboardInputIds?: string[];
  plan: DirectorPlan | null;
  referenceIds: string[];
  generationIdsByShot: Record<string, string>;
  generationHistoryIdsByShot?: Record<string, string[]>;
  sceneFrames?: Record<string, SceneFrameRecord>;
  error: string;
  createdAt: string;
  updatedAt: string;
};

export type EpisodeStudioState = {
  episode: EpisodeRecord;
  references: DirectorReference[];
  generations: Record<string, ShotGenerationView>;
  generationVersions: Record<string, ShotGenerationView[]>;
  storyboardInputs: StoryInputView[];
};

export function isEpisodeRecord(value: unknown): value is EpisodeRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<EpisodeRecord>;
  return record.version === 1 &&
    typeof record.id === "string" &&
    (record.status === "planning" || record.status === "ready" || record.status === "failed") &&
    typeof record.title === "string" &&
    typeof record.story === "string" &&
    (record.format === undefined || record.format === "landscape" || record.format === "reels") &&
    (record.storyboardInputIds === undefined || (Array.isArray(record.storyboardInputIds) && record.storyboardInputIds.every((id) => typeof id === "string"))) &&
    (record.plan === null || (typeof record.plan === "object" && Array.isArray(record.plan.scenes))) &&
    Array.isArray(record.referenceIds) && record.referenceIds.every((id) => typeof id === "string") &&
    Boolean(record.generationIdsByShot) && typeof record.generationIdsByShot === "object" &&
    Object.entries(record.generationIdsByShot).every(([shotId, generationId]) => Boolean(shotId) && typeof generationId === "string") &&
    (record.generationHistoryIdsByShot === undefined || (Boolean(record.generationHistoryIdsByShot) && typeof record.generationHistoryIdsByShot === "object" &&
      Object.entries(record.generationHistoryIdsByShot).every(([shotId, ids]) => Boolean(shotId) && Array.isArray(ids) && ids.every((id) => typeof id === "string")))) &&
    (record.sceneFrames === undefined || (Boolean(record.sceneFrames) && typeof record.sceneFrames === "object" &&
      Object.entries(record.sceneFrames).every(([sceneId, frame]) => {
        if (!sceneId || !frame || typeof frame !== "object") return false;
        const value = frame as Partial<SceneFrameRecord>;
        return typeof value.id === "string" && value.sceneId === sceneId && typeof value.prompt === "string" &&
          typeof value.revisionInstruction === "string" && Array.isArray(value.referenceIds) && value.referenceIds.every((id) => typeof id === "string") &&
          typeof value.imagePathname === "string" && typeof value.contentType === "string" && typeof value.model === "string" &&
          (value.approvalStatus === "pending" || value.approvalStatus === "approved") && typeof value.error === "string" &&
          typeof value.createdAt === "string" && typeof value.updatedAt === "string";
      }))) &&
    typeof record.error === "string" &&
    typeof record.createdAt === "string" &&
    typeof record.updatedAt === "string";
}
