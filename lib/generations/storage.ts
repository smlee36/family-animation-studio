import "server-only";

import { get, put } from "@vercel/blob";
import { isShotGenerationRecord, type ShotGenerationRecord } from "@/lib/generations/types";

const METADATA_PREFIX = "generations/meta/";

export function generationMetadataPath(id: string) {
  return `${METADATA_PREFIX}${id}.json`;
}

export function generationVideoPath(id: string) {
  return `generations/videos/${id}.mp4`;
}

export async function getGeneration(id: string): Promise<ShotGenerationRecord | null> {
  const result = await get(generationMetadataPath(id), { access: "private", useCache: false });
  if (!result?.stream || result.statusCode !== 200) return null;
  const value = (await new Response(result.stream).json()) as unknown;
  return isShotGenerationRecord(value) ? value : null;
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
