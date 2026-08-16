export type ShotGenerationStatus = "generating" | "ready" | "failed";
export type VeoQualityTier = "fast" | "standard";
export type VideoGenerationProvider = "google" | "ltx";
export type LtxPreset = "gentle" | "action" | "camera";
export type LtxRenderMode = "preview" | "final";
export type LtxSequenceMode = "timeline" | "montage";
export type LtxDurationSeconds = 5 | 10;
export type VideoDurationSeconds = 4 | 5 | 6 | 8 | 10;
export type ShotApprovalStatus = "pending" | "approved" | "needs_review";
export type InitialFrameKind = "continuity" | "scene_master";
export type VideoAspectRatio = "16:9" | "9:16";

export type ShotQualityScores = {
  characterConsistency: number;
  faceStability: number;
  handsBody: number;
  backgroundConsistency: number;
  objectConsistency: number;
  motionNaturalness: number;
  referenceMatch: number;
  continuity: number;
};

export type ShotQualityResult = {
  scores: ShotQualityScores;
  overall: number;
  summary: string;
  correctionPrompt: string;
  evaluatedAt: string;
  responseId: string;
  model: string;
};

export type ShotGenerationRecord = {
  version: 1;
  id: string;
  episodeId?: string;
  shotId: string;
  operationName: string;
  model: string;
  provider?: VideoGenerationProvider;
  ltxPreset?: LtxPreset;
  ltxRenderMode?: LtxRenderMode;
  backendStatus?: string;
  backendQueuePosition?: number;
  backendStartedAt?: string;
  estimatedSecondsRemaining?: number;
  sourcePrompt?: string;
  prompt: string;
  continuitySourceGenerationId?: string;
  continuityFramePathname?: string;
  continuityFrameMimeType?: string;
  keyframePathnames?: string[];
  keyframeMimeTypes?: string[];
  initialFrameKind?: InitialFrameKind;
  initialFrameModel?: string;
  status: ShotGenerationStatus;
  durationSeconds: VideoDurationSeconds;
  aspectRatio?: VideoAspectRatio;
  usedReferenceIds: string[];
  omittedReferenceIds: string[];
  videoPathname: string;
  error: string;
  createdAt: string;
  updatedAt: string;
  qualityTier?: VeoQualityTier;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  approvalStatus?: ShotApprovalStatus;
  qc?: ShotQualityResult | null;
};

export type ShotGenerationView = Pick<
  ShotGenerationRecord,
  "id" | "shotId" | "model" | "prompt" | "status" | "durationSeconds" | "usedReferenceIds" | "omittedReferenceIds" | "error" | "createdAt" | "updatedAt"
> & {
  episodeId: string;
  continuitySourceGenerationId: string;
  initialFrameKind: InitialFrameKind | "";
  videoUrl: string;
  qualityTier: VeoQualityTier;
  autoRegenerationCount: number;
  parentGenerationId: string;
  approvalStatus: ShotApprovalStatus;
  qc: ShotQualityResult | null;
  aspectRatio: VideoAspectRatio;
  provider: VideoGenerationProvider;
  ltxPreset: LtxPreset;
  ltxRenderMode: LtxRenderMode;
  backendStatus: string;
  backendQueuePosition: number;
  backendStartedAt: string;
  estimatedSecondsRemaining: number;
  keyframePathnames: string[];
  keyframeMimeTypes: string[];
};

export function generationView(record: ShotGenerationRecord): ShotGenerationView {
  return {
    id: record.id,
    episodeId: record.episodeId || "",
    shotId: record.shotId,
    model: record.model,
    provider: record.provider || (record.model.toLowerCase().includes("ltx") ? "ltx" : "google"),
    ltxPreset: record.ltxPreset || "gentle",
    ltxRenderMode: record.ltxRenderMode || "final",
    backendStatus: record.backendStatus || "",
    backendQueuePosition: record.backendQueuePosition || 0,
    backendStartedAt: record.backendStartedAt || "",
    estimatedSecondsRemaining: Math.max(0, record.estimatedSecondsRemaining || 0),
    keyframePathnames: record.keyframePathnames || [],
    keyframeMimeTypes: record.keyframeMimeTypes || [],
    prompt: record.prompt,
    continuitySourceGenerationId: record.continuitySourceGenerationId || "",
    initialFrameKind: record.initialFrameKind || "",
    status: record.status,
    durationSeconds: record.durationSeconds,
    aspectRatio: record.aspectRatio || "16:9",
    usedReferenceIds: record.usedReferenceIds,
    omittedReferenceIds: record.omittedReferenceIds,
    error: record.error,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    videoUrl: record.status === "ready" ? `/api/shots/generate/${record.id}/video` : "",
    qualityTier: record.qualityTier || "standard",
    autoRegenerationCount: record.autoRegenerationCount || 0,
    parentGenerationId: record.parentGenerationId || "",
    approvalStatus: record.approvalStatus || "pending",
    qc: record.qc || null,
  };
}

export function isShotGenerationRecord(value: unknown): value is ShotGenerationRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ShotGenerationRecord>;
  return record.version === 1 && typeof record.id === "string" && typeof record.shotId === "string" &&
    (record.episodeId === undefined || typeof record.episodeId === "string") &&
    typeof record.operationName === "string" && typeof record.model === "string" && typeof record.prompt === "string" &&
    (record.provider === undefined || record.provider === "google" || record.provider === "ltx") &&
    (record.ltxPreset === undefined || record.ltxPreset === "gentle" || record.ltxPreset === "action" || record.ltxPreset === "camera") &&
    (record.ltxRenderMode === undefined || record.ltxRenderMode === "preview" || record.ltxRenderMode === "final") &&
    (record.backendStatus === undefined || typeof record.backendStatus === "string") &&
    (record.backendQueuePosition === undefined || (Number.isInteger(record.backendQueuePosition) && record.backendQueuePosition >= 0)) &&
    (record.backendStartedAt === undefined || typeof record.backendStartedAt === "string") &&
    (record.estimatedSecondsRemaining === undefined || (typeof record.estimatedSecondsRemaining === "number" && Number.isFinite(record.estimatedSecondsRemaining) && record.estimatedSecondsRemaining >= 0)) &&
    (record.sourcePrompt === undefined || typeof record.sourcePrompt === "string") &&
    (record.continuitySourceGenerationId === undefined || typeof record.continuitySourceGenerationId === "string") &&
    (record.continuityFramePathname === undefined || typeof record.continuityFramePathname === "string") &&
    (record.continuityFrameMimeType === undefined || typeof record.continuityFrameMimeType === "string") &&
    (record.keyframePathnames === undefined || (Array.isArray(record.keyframePathnames) && record.keyframePathnames.every((pathname) => typeof pathname === "string"))) &&
    (record.keyframeMimeTypes === undefined || (Array.isArray(record.keyframeMimeTypes) && record.keyframeMimeTypes.every((mimeType) => typeof mimeType === "string"))) &&
    (record.initialFrameKind === undefined || record.initialFrameKind === "continuity" || record.initialFrameKind === "scene_master") &&
    (record.initialFrameModel === undefined || typeof record.initialFrameModel === "string") &&
    (record.status === "generating" || record.status === "ready" || record.status === "failed") &&
    (record.durationSeconds === 4 || record.durationSeconds === 5 || record.durationSeconds === 6 || record.durationSeconds === 8 || record.durationSeconds === 10) &&
    (record.aspectRatio === undefined || record.aspectRatio === "16:9" || record.aspectRatio === "9:16") &&
    Array.isArray(record.usedReferenceIds) && Array.isArray(record.omittedReferenceIds) &&
    typeof record.videoPathname === "string" && typeof record.error === "string" &&
    typeof record.createdAt === "string" && typeof record.updatedAt === "string" &&
    (record.qualityTier === undefined || record.qualityTier === "fast" || record.qualityTier === "standard") &&
    (record.autoRegenerationCount === undefined || (Number.isInteger(record.autoRegenerationCount) && record.autoRegenerationCount >= 0 && record.autoRegenerationCount <= 2)) &&
    (record.parentGenerationId === undefined || typeof record.parentGenerationId === "string") &&
    (record.approvalStatus === undefined || record.approvalStatus === "pending" || record.approvalStatus === "approved" || record.approvalStatus === "needs_review") &&
    (record.qc === undefined || record.qc === null || isShotQualityResult(record.qc));
}

function isScore(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

function isShotQualityResult(value: unknown): value is ShotQualityResult {
  if (!value || typeof value !== "object") return false;
  const result = value as Partial<ShotQualityResult>;
  const scores = result.scores as Partial<ShotQualityScores> | undefined;
  return Boolean(scores) && isScore(scores?.characterConsistency) && isScore(scores?.faceStability) &&
    isScore(scores?.handsBody) && isScore(scores?.backgroundConsistency) && isScore(scores?.objectConsistency) &&
    isScore(scores?.motionNaturalness) && isScore(scores?.referenceMatch) && isScore(scores?.continuity) &&
    isScore(result.overall) && typeof result.summary === "string" && typeof result.correctionPrompt === "string" &&
    typeof result.evaluatedAt === "string" && typeof result.responseId === "string" && typeof result.model === "string";
}
