import { randomUUID } from "node:crypto";
import { del, head } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { isReferenceCategory, type ReferenceRecord } from "@/lib/references/types";
import { getReference, listReferences, saveReference } from "@/lib/references/storage";

const REFERENCE_IMAGE_PATH = /^references\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpe?g|png|webp|avif|heic|heif)$/i;

export async function GET() {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    return NextResponse.json({ references: await listReferences() });
  } catch (error) {
    logServerError("references.list", error, requestId);
    return jsonError("Reference 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    const imagePathname = typeof body.imagePathname === "string" ? body.imagePathname : "";
    const originalFilename = typeof body.originalFilename === "string" ? body.originalFilename.slice(0, 180) : "";
    const pathMatch = imagePathname.match(REFERENCE_IMAGE_PATH);

    if (!pathMatch || pathMatch[1] !== id || !name || name.length > 80 || description.length > 500 || !isReferenceCategory(body.category)) {
      return jsonError("Reference 이름, 카테고리 또는 이미지 정보를 확인해 주세요.", 400, requestId);
    }

    const image = await head(imagePathname);
    if (!image.contentType.startsWith("image/")) {
      return jsonError("지원하는 이미지 파일이 아닙니다.", 400, requestId);
    }

    const existing = await getReference(id);
    const now = new Date().toISOString();
    const record: ReferenceRecord = {
      version: 1,
      id,
      name,
      description,
      category: body.category,
      imagePathname,
      originalFilename,
      contentType: image.contentType,
      size: image.size,
      uploadedAt: existing?.uploadedAt || now,
      updatedAt: now,
    };

    await saveReference(record);
    if (existing && existing.imagePathname !== imagePathname) {
      try {
        await del(existing.imagePathname);
      } catch (cleanupError) {
        logServerError("references.replace.cleanup", cleanupError, requestId);
      }
    }

    return NextResponse.json({ reference: record }, { status: existing ? 200 : 201 });
  } catch (error) {
    logServerError("references.create", error, requestId);
    return jsonError("Reference 저장 중 문제가 생겼습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
