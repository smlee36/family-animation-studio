import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { getReference, removeReference, saveReference } from "@/lib/references/storage";
import { isReferenceCategory } from "@/lib/references/types";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, context: RouteContext) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await context.params;
    const reference = await getReference(id);
    if (!reference) return jsonError("고정 기준 이미지를 찾을 수 없습니다.", 404, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description = typeof body.description === "string" ? body.description.trim() : "";
    if (!name || name.length > 80 || description.length > 500 || !isReferenceCategory(body.category)) {
      return jsonError("이름, 설명 또는 카테고리를 확인해 주세요.", 400, requestId);
    }
    const updated = { ...reference, name, description, category: body.category, updatedAt: new Date().toISOString() };
    await saveReference(updated);
    return NextResponse.json({ reference: updated, requestId });
  } catch (error) {
    logServerError("references.update", error, requestId);
    return jsonError("고정 기준을 수정하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}

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
