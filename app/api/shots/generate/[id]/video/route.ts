import { randomUUID } from "node:crypto";
import { get } from "@vercel/blob";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getGeneration } from "@/lib/generations/storage";

export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    const record = await getGeneration(id);
    if (!record || record.status !== "ready" || !record.videoPathname) return jsonError("완성된 영상을 찾을 수 없습니다.", 404, requestId);
    const range = request.headers.get("range");
    const result = await get(record.videoPathname, {
      access: "private",
      useCache: true,
      ...(range ? { headers: { Range: range } } : {}),
    });
    if (!result?.stream || result.statusCode !== 200) return jsonError("영상 파일을 불러오지 못했습니다.", 404, requestId);

    const contentRange = result.headers.get("content-range");
    const download = request.nextUrl.searchParams.get("download") === "1";
    return new NextResponse(result.stream, {
      status: contentRange ? 206 : 200,
      headers: {
        "Content-Type": result.blob.contentType || "video/mp4",
        "Content-Length": result.headers.get("content-length") || String(result.blob.size),
        "Accept-Ranges": "bytes",
        ...(contentRange ? { "Content-Range": contentRange } : {}),
        "Cache-Control": "private, max-age=3600",
        "Content-Disposition": `${download ? "attachment" : "inline"}; filename="family-shot-${record.shotId}.mp4"`,
      },
    });
  } catch (error) {
    logServerError("veo.video", error, requestId);
    return jsonError("영상 파일을 불러오지 못했습니다.", 500, requestId);
  }
}
