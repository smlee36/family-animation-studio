export type ShotGenerationStatus = "generating" | "ready" | "failed";
export type VeoQualityTier = "fast" | "standard";
export type ShotApprovalStatus = "pending" | "approved" | "needs_review";

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
  shotId: string;
  operationName: string;
  model: string;
  prompt: string;
  status: ShotGenerationStatus;
  durationSeconds: 4 | 6 | 8;
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
  "id" | "shotId" | "status" | "durationSeconds" | "usedReferenceIds" | "omittedReferenceIds" | "error" | "createdAt" | "updatedAt"
> & {
  videoUrl: string;
  qualityTier: VeoQualityTier;
  autoRegenerationCount: number;
  parentGenerationId: string;
  approvalStatus: ShotApprovalStatus;
  qc: ShotQualityResult | null;
};

export function generationView(record: ShotGenerationRecord): ShotGenerationView {
  return {
    id: record.id,
    shotId: record.shotId,
    status: record.status,
    durationSeconds: record.durationSeconds,
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
    typeof record.operationName === "string" && typeof record.model === "string" && typeof record.prompt === "string" &&
    (record.status === "generating" || record.status === "ready" || record.status === "failed") &&
    (record.durationSeconds === 4 || record.durationSeconds === 6 || record.durationSeconds === 8) &&
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
