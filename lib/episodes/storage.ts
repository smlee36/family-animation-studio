import "server-only";

import { get, list, put } from "@vercel/blob";
import type { DirectorPlan } from "@/lib/director/types";
import { isEpisodeRecord, type EpisodeFormat, type EpisodeRecord, type FinalVideoRecord, type SceneFrameRecord } from "@/lib/episodes/types";

const METADATA_PREFIX = "episodes/meta/";

export function episodeMetadataPath(id: string) {
  return `${METADATA_PREFIX}${id}.json`;
}

async function readEpisode(pathname: string): Promise<EpisodeRecord | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result?.stream || result.statusCode !== 200) return null;
  const value = (await new Response(result.stream).json()) as unknown;
  return isEpisodeRecord(value) ? value : null;
}

export async function getEpisode(id: string) {
  return readEpisode(episodeMetadataPath(id));
}

export async function listEpisodes() {
  const episodes: EpisodeRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: METADATA_PREFIX, limit: 1000, cursor });
    const records = await Promise.all(page.blobs.map((blob) => readEpisode(blob.pathname)));
    episodes.push(...records.filter((record): record is EpisodeRecord => Boolean(record)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return episodes.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveEpisode(record: EpisodeRecord) {
  await put(episodeMetadataPath(record.id), JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}

export async function createEpisodeDraft(id: string, story: string, storyboardInputIds: string[] = [], format: EpisodeFormat = "reels") {
  const now = new Date().toISOString();
  const record: EpisodeRecord = {
    version: 1,
    id,
    status: "planning",
    title: "새로운 가족 이야기",
    story,
    format,
    storyboardInputIds: [...new Set(storyboardInputIds)],
    plan: null,
    referenceIds: [],
    generationIdsByShot: {},
    generationHistoryIdsByShot: {},
    sceneFrames: {},
    error: "",
    createdAt: now,
    updatedAt: now,
  };
  await saveEpisode(record);
  return record;
}

export async function saveSceneFrame(episodeId: string, frame: SceneFrameRecord) {
  const current = await getEpisode(episodeId);
  if (!current) return null;
  const updated: EpisodeRecord = {
    ...current,
    sceneFrames: { ...current.sceneFrames, [frame.sceneId]: frame },
    updatedAt: new Date().toISOString(),
  };
  await saveEpisode(updated);
  return updated;
}

export async function completeEpisodePlan(id: string, plan: DirectorPlan, referenceIds: string[]) {
  const current = await getEpisode(id);
  if (!current) return null;
  const completed: EpisodeRecord = {
    ...current,
    status: "ready",
    title: plan.title,
    plan,
    referenceIds: [...new Set(referenceIds)],
    error: "",
    updatedAt: new Date().toISOString(),
  };
  await saveEpisode(completed);
  return completed;
}

export async function failEpisodePlan(id: string, message: string) {
  const current = await getEpisode(id);
  if (!current) return;
  await saveEpisode({
    ...current,
    status: "failed",
    error: message,
    updatedAt: new Date().toISOString(),
  });
}

export async function updateEpisodePlan(id: string, plan: DirectorPlan, referenceIds?: string[]) {
  const current = await getEpisode(id);
  if (!current) return null;
  const updated: EpisodeRecord = {
    ...current,
    status: "ready",
    title: plan.title,
    plan,
    referenceIds: referenceIds ? [...new Set(referenceIds)] : current.referenceIds,
    updatedAt: new Date().toISOString(),
  };
  await saveEpisode(updated);
  return updated;
}

export async function linkGenerationToEpisode(episodeId: string, shotId: string, generationId: string) {
  const current = await getEpisode(episodeId);
  if (!current) return null;
  const previousHistory = current.generationHistoryIdsByShot?.[shotId] || [];
  const previousCurrent = current.generationIdsByShot[shotId];
  const generationHistory = [...new Set([...previousHistory, ...(previousCurrent ? [previousCurrent] : []), generationId])];
  const updated: EpisodeRecord = {
    ...current,
    generationIdsByShot: { ...current.generationIdsByShot, [shotId]: generationId },
    generationHistoryIdsByShot: { ...current.generationHistoryIdsByShot, [shotId]: generationHistory },
    updatedAt: new Date().toISOString(),
  };
  await saveEpisode(updated);
  return updated;
}

export async function saveEpisodeFinalVideo(episodeId: string, finalVideo: FinalVideoRecord) {
  const current = await getEpisode(episodeId);
  if (!current) return null;
  const updated: EpisodeRecord = {
    ...current,
    finalVideo,
    updatedAt: new Date().toISOString(),
  };
  await saveEpisode(updated);
  return updated;
}
