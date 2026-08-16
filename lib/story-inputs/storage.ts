import "server-only";

import { get, put } from "@vercel/blob";
import { isStoryInputRecord, type StoryInputRecord } from "@/lib/story-inputs/types";

const METADATA_PREFIX = "story-inputs/meta/";

export function storyInputMetadataPath(id: string) {
  return `${METADATA_PREFIX}${id}.json`;
}

export async function getStoryInput(id: string): Promise<StoryInputRecord | null> {
  const result = await get(storyInputMetadataPath(id), { access: "private", useCache: false });
  if (!result?.stream || result.statusCode !== 200) return null;
  const value = (await new Response(result.stream).json()) as unknown;
  return isStoryInputRecord(value) ? value : null;
}

export async function getStoryInputs(ids: string[]) {
  const records = await Promise.all([...new Set(ids)].map((id) => getStoryInput(id)));
  return records.filter((record): record is StoryInputRecord => Boolean(record));
}

export async function saveStoryInput(record: StoryInputRecord) {
  await put(storyInputMetadataPath(record.id), JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}
