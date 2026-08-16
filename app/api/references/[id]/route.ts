import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getReference, removeReference } from "@/lib/references/storage";

type RouteContext = { params: Promise<{ id: string }> };

export async function DELETE(_request: Request, context: RouteContext) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await context.params;
    const reference = await getReference(id);
    if (!reference) return jsonError("Reference를 찾을 수 없습니다.", 404, requestId);
    await removeReference(reference);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    logServerError("references.delete", error, requestId);
    return jsonError("Reference를 삭제하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
