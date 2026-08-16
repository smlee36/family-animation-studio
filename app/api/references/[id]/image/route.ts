import { randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import { NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getReference } from "@/lib/references/storage";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await context.params;
    const reference = await getReference(id);
    if (!reference) return jsonError("이미지를 찾을 수 없습니다.", 404, requestId);

    const image = await get(reference.imagePathname, { access: "private" });
    if (!image || image.statusCode !== 200 || !image.stream) {
      return jsonError("이미지를 찾을 수 없습니다.", 404, requestId);
    }

    return new NextResponse(image.stream, {
      headers: {
        "Cache-Control": "private, max-age=3600, must-revalidate",
        "Content-Type": image.blob.contentType,
        "Content-Length": String(image.blob.size),
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    logServerError("references.image", error, requestId);
    return jsonError("이미지를 불러오지 못했습니다.", 500, requestId);
  }
}
