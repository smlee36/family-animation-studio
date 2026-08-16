import { randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getStoryInput } from "@/lib/story-inputs/storage";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;
  try {
    const { id } = await params;
    const input = await getStoryInput(id);
    if (!input) return jsonError("이야기 이미지를 찾을 수 없습니다.", 404, requestId);
    const image = await get(input.imagePathname, { access: "private" });
    if (!image?.stream || image.statusCode !== 200) return jsonError("이야기 이미지를 찾을 수 없습니다.", 404, requestId);
    return new NextResponse(image.stream, {
      headers: {
        "Cache-Control": "private, max-age=3600, must-revalidate",
        "Content-Type": input.contentType,
        "Content-Length": String(input.size),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logServerError("story-inputs.image", error, requestId);
    return jsonError("이야기 이미지를 불러오지 못했습니다.", 500, requestId);
  }
}
