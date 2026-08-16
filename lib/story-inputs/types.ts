export type StoryInputRecord = {
  version: 1;
  id: string;
  kind?: "storyboard" | "photo";
  name: string;
  imagePathname: string;
  contentType: string;
  size: number;
  createdAt: string;
};

export type StoryInputView = Pick<StoryInputRecord, "id" | "name" | "contentType" | "size" | "createdAt"> & {
  kind: "storyboard" | "photo";
  imageUrl: string;
};

export function isStoryInputRecord(value: unknown): value is StoryInputRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<StoryInputRecord>;
  return record.version === 1 &&
    typeof record.id === "string" &&
    (record.kind === undefined || record.kind === "storyboard" || record.kind === "photo") &&
    typeof record.name === "string" &&
    typeof record.imagePathname === "string" &&
    typeof record.contentType === "string" &&
    typeof record.size === "number" &&
    typeof record.createdAt === "string";
}

export function storyInputView(record: StoryInputRecord): StoryInputView {
  return {
    id: record.id,
    kind: record.kind || "storyboard",
    name: record.name,
    contentType: record.contentType,
    size: record.size,
    createdAt: record.createdAt,
    imageUrl: `/api/story-inputs/${record.id}/image`,
  };
}
