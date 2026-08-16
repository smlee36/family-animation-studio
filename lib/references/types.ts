export const REFERENCE_CATEGORIES = [
  "아빠",
  "엄마",
  "아이",
  "거실",
  "침실",
  "곰인형",
  "물병",
  "장난감",
  "스토리보드",
  "기타 소품",
  "기타 장소",
] as const;

export type ReferenceCategory = (typeof REFERENCE_CATEGORIES)[number];

export type ReferenceRecord = {
  version: 1;
  id: string;
  name: string;
  description: string;
  category: ReferenceCategory;
  imagePathname: string;
  originalFilename: string;
  contentType: string;
  size: number;
  uploadedAt: string;
  updatedAt: string;
};

export function isReferenceCategory(value: unknown): value is ReferenceCategory {
  return typeof value === "string" && REFERENCE_CATEGORIES.includes(value as ReferenceCategory);
}

export function isReferenceRecord(value: unknown): value is ReferenceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ReferenceRecord>;
  return (
    record.version === 1 &&
    typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.description === "string" &&
    isReferenceCategory(record.category) &&
    typeof record.imagePathname === "string" &&
    typeof record.originalFilename === "string" &&
    typeof record.contentType === "string" &&
    typeof record.size === "number" &&
    typeof record.uploadedAt === "string" &&
    typeof record.updatedAt === "string"
  );
}
