import { randomUUID } from "node:crypto";
import { issueSignedToken } from "@vercel/blob";
import {
  handleUploadPresigned,
  type HandleUploadPresignedBody,
} from "@vercel/blob/client";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError } from "@/lib/api";
import { hasValidSession } from "@/lib/session";

const ALLOWED_IMAGE_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/avif",
  "image/heic",
  "image/heif",
];
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const REFERENCE_IMAGE_PATH = /^references\/images\/([0-9a-f-]{36})\/([0-9a-f-]{36})\.(jpe?g|png|webp|avif|heic|heif)$/i;

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
        const match = pathname.match(REFERENCE_IMAGE_PATH);
        let referenceId = "";
        try {
          const parsed = JSON.parse(clientPayload || "{}") as { referenceId?: unknown };
          referenceId = typeof parsed.referenceId === "string" ? parsed.referenceId : "";
        } catch {
          throw new Error("Invalid reference upload payload");
        }

        if (!match || match[1] !== referenceId) throw new Error("Invalid reference image pathname");

        const validUntil = Date.now() + 10 * 60 * 1000;
        const token = await issueSignedToken({
          pathname,
          operations: ["put"],
          allowedContentTypes: ALLOWED_IMAGE_TYPES,
          maximumSizeInBytes: MAX_IMAGE_BYTES,
          validUntil,
        });

        return {
          token,
          urlOptions: {
            allowedContentTypes: ALLOWED_IMAGE_TYPES,
            maximumSizeInBytes: MAX_IMAGE_BYTES,
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
    logServerError("references.upload", error, requestId);
    return jsonError("이미지 업로드 준비 중 문제가 생겼습니다. 파일 형식과 크기를 확인해 주세요.", 400, requestId);
  }
}
