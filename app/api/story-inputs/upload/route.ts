import { randomUUID } from "node:crypto";
import { issueSignedToken } from "@vercel/blob";
import { handleUploadPresigned, type HandleUploadPresignedBody } from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError } from "@/lib/api";
import { hasValidSession } from "@/lib/session";

const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp"];
const MAX_BYTES = 20 * 1024 * 1024;
const IMAGE_PATH = /^story-inputs\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpe?g|png|webp)$/i;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  try {
    const body = (await request.json()) as HandleUploadPresignedBody;
    if (body.type === "blob.generate-presigned-url" && !(await hasValidSession())) {
      return jsonError("로그인이 필요합니다. 다시 입장해 주세요.", 401, requestId);
    }
    const response = await handleUploadPresigned({
      request,
      body,
      getSignedToken: async (pathname, clientPayload) => {
        const match = pathname.match(IMAGE_PATH);
        const payload = JSON.parse(clientPayload || "{}") as { inputId?: unknown };
        const inputId = typeof payload.inputId === "string" ? payload.inputId : "";
        if (!match || match[1] !== inputId) throw new Error("Invalid story input pathname");
        const validUntil = Date.now() + 10 * 60 * 1000;
        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: ALLOWED_TYPES,
          maximumSizeInBytes: MAX_BYTES,
          validUntil,
        });
        return {
          token,
          urlOptions: {
            allowedContentTypes: ALLOWED_TYPES,
            maximumSizeInBytes: MAX_BYTES,
            addRandomSuffix: false,
            allowOverwrite: false,
            cacheControlMaxAge: 60 * 60 * 24,
            validUntil,
          },
        };
      },
    });
    return NextResponse.json(response);
  } catch (error) {
    logServerError("story-inputs.upload", error, requestId);
    return jsonError("이미지를 올리지 못했습니다. JPG, PNG, WebP 파일인지 확인해 주세요.", 400, requestId);
  }
}
