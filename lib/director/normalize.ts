import type { DirectorPlan } from "@/lib/director/types";

type UnknownRecord = Record<string, unknown>;

function record(value: unknown): UnknownRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Director output contains an invalid object");
  }
  return value as UnknownRecord;
}

function string(value: unknown, field: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Director output is missing ${field}`);
  return value.trim();
}

export function normalizeDirectorPlan(value: unknown, validReferenceIds: Set<string>): DirectorPlan {
  const root = record(value);
  if (!Array.isArray(root.scenes) || root.scenes.length === 0) {
    throw new Error("Director output has no scenes");
  }

  let totalEstimatedSeconds = 0;
  let totalShots = 0;
  const scenes = root.scenes.map((sceneValue, sceneIndex) => {
    const source = record(sceneValue);
    if (!Array.isArray(source.shots) || source.shots.length === 0) {
      throw new Error(`Director scene ${sceneIndex + 1} has no shots`);
    }

    const sceneNumber = sceneIndex + 1;
    const shots = source.shots.map((shotValue, shotIndex) => {
      const shot = record(shotValue);
      const rawSeconds = typeof shot.estimatedSeconds === "number" ? shot.estimatedSeconds : 6;
      const estimatedSeconds = Math.min(8, Math.max(4, Math.round(rawSeconds)));
      const referenceIds = Array.isArray(shot.referenceIds)
        ? [...new Set(shot.referenceIds.filter((id): id is string => typeof id === "string" && validReferenceIds.has(id)))].slice(0, 6)
        : [];

      totalEstimatedSeconds += estimatedSeconds;
      totalShots += 1;
      return {
        id: `${sceneNumber}-${shotIndex + 1}`,
        title: string(shot.title, "shot.title"),
        action: string(shot.action, "shot.action"),
        estimatedSeconds,
        referenceIds,
        referenceReason: typeof shot.referenceReason === "string" ? shot.referenceReason.trim() : "",
        startState: string(shot.startState, "shot.startState"),
        endState: string(shot.endState, "shot.endState"),
        prompt: string(shot.prompt, "shot.prompt"),
      };
    });

    const requestedMasterId = typeof source.sceneMasterReferenceId === "string" ? source.sceneMasterReferenceId : "";
    return {
      id: `scene-${sceneNumber}`,
      number: sceneNumber,
      title: string(source.title, "scene.title"),
      summary: string(source.summary, "scene.summary"),
      setting: string(source.setting, "scene.setting"),
      sceneMasterReferenceId: validReferenceIds.has(requestedMasterId) ? requestedMasterId : "",
      shots,
    };
  });

  return {
    title: string(root.title, "title"),
    summary: string(root.summary, "summary"),
    totalEstimatedSeconds,
    totalShots,
    scenes,
  };
}
