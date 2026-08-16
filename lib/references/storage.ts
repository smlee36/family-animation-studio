import "server-only";

import { del, get, list, put } from "@vercel/blob";
import { isReferenceRecord, type ReferenceRecord } from "@/lib/references/types";

const METADATA_PREFIX = "references/meta/";

export function referenceMetadataPath(id: string) {
  return `${METADATA_PREFIX}${id}.json`;
}

async function readMetadata(pathname: string): Promise<ReferenceRecord | null> {
  const result = await get(pathname, { access: "private", useCache: false });
  if (!result || result.statusCode !== 200 || !result.stream) return null;

  const value = (await new Response(result.stream).json()) as unknown;
  return isReferenceRecord(value) ? value : null;
}

export async function getReference(id: string): Promise<ReferenceRecord | null> {
  return readMetadata(referenceMetadataPath(id));
}

export async function listReferences(): Promise<ReferenceRecord[]> {
  const records: ReferenceRecord[] = [];
  let cursor: string | undefined;

  do {
    const page = await list({ prefix: METADATA_PREFIX, limit: 1000, cursor });
    const pageRecords = await Promise.all(page.blobs.map((blob) => readMetadata(blob.pathname)));
    records.push(...pageRecords.filter((record): record is ReferenceRecord => Boolean(record)));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);

  return records.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function saveReference(record: ReferenceRecord) {
  await put(referenceMetadataPath(record.id), JSON.stringify(record), {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json; charset=utf-8",
    cacheControlMaxAge: 60,
  });
}

export async function removeReference(record: ReferenceRecord) {
  await del([record.imagePathname, referenceMetadataPath(record.id)]);
}
