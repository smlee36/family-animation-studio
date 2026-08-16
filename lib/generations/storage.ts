import "server-only";

import { get, list, put } from "@vercel/blob";
import { isShotGenerationRecord, type ShotGenerationRecord } from "@/lib/generations/types";

const METADATA_PREFIX = "generations/meta/";

export function generationMetadataPath(id: string) {
  return `${METADATA_PREFIX}${id}.json`;
}

export function generationVideoPath(id: string) {
  return `generations/videos/${id}.mp4`;
}

export function generationContinuityFramePath(id: string) {
  return `generations/continuity/${id}.jpg`;
}

export function generationSceneMasterFramePath(id: string) {
  return `generations/scene-master/${id}.jpg`;
}

export function episodeFinalVideoPath(episodeId: string, finalVideoId: string) {
  return `episodes/final-videos/${episodeId}/${finalVideoId}.mp4`;
}

export async function getGeneration(id: string): Promise<ShotGenerationRecord | null> {
  const result = await get(generationMetadataPath(id), { access: "private", useCache: false });
  if (!result?.stream || result.statusCode !== 200) return null;
  const value = (await new Response(result.stream).json()) as unknown;
  return isShotGenerationRecord(value) ? value : null;
}

export async function listGenerations(): Promise<ShotGenerationRecord[]> {
  const records: ShotGenerationRecord[] = [];
  let cursor: string | undefined;
  do {
    const page = await list({ prefix: METADATA_PREFIX, limit: 1000, cursor });
    const values = await Promise.all(page.blobs.map(async (blob) => {
      const result = await get(blob.pathname, { access: "private", useCache: false });
      if (!result?.stream || result.statusCode !== 200) return null;
      const value = (await new Response(result.stream).json()) as unknown;
      return isShotGenerationRecord(value) ? value : null;
    }));
    records.push(...values.filter((record): record is ShotGenerationRecord => Boolean(record)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveGeneration(record: ShotGenerationRecord) {
  await put(generationMetadataPath(record.id), JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}
