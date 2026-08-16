export type ShotGenerationStatus = "generating" | "ready" | "failed";

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
};

export type ShotGenerationView = Pick<
  ShotGenerationRecord,
  "id" | "shotId" | "status" | "durationSeconds" | "usedReferenceIds" | "omittedReferenceIds" | "error" | "createdAt" | "updatedAt"
> & { videoUrl: string };

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
    typeof record.createdAt === "string" && typeof record.updatedAt === "string";
}
