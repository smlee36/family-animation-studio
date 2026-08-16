import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { saveStoryInput } from "@/lib/story-inputs/storage";
import { storyInputView, type StoryInputRecord } from "@/lib/story-inputs/types";

const IMAGE_PATH = /^story-inputs\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpe?g|png|webp)$/i;
const ALLOWED_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    const id = typeof body.id === "string" ? body.id : "";
    const name = typeof body.name === "string" ? body.name.trim().slice(0, 120) : "";
    const imagePathname = typeof body.imagePathname === "string" ? body.imagePathname : "";
    const contentType = typeof body.contentType === "string" ? body.contentType : "";
    const size = typeof body.size === "number" ? body.size : 0;
    const match = imagePathname.match(IMAGE_PATH);
    if (!/^[0-9a-f-]{36}$/i.test(id) || !match || match[1] !== id || !name || !ALLOWED_TYPES.has(contentType) || size <= 0 || size > 20 * 1024 * 1024) {
      return jsonError("이미지 정보가 올바르지 않습니다.", 400, requestId);
    }
    const record: StoryInputRecord = { version: 1, id, name, imagePathname, contentType, size, createdAt: new Date().toISOString() };
    await saveStoryInput(record);
    return NextResponse.json({ input: storyInputView(record), requestId });
  } catch (error) {
    logServerError("story-inputs.create", error, requestId);
    return jsonError("이야기 이미지를 저장하지 못했습니다.", 500, requestId);
  }
}
