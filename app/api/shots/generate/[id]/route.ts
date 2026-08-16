import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { refreshVideoGeneration } from "@/lib/generations/backend";
import { getGeneration, saveGeneration } from "@/lib/generations/storage";
import { generationView } from "@/lib/generations/types";

export const maxDuration = 60;

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("영상 작업 번호가 올바르지 않습니다.", 400, requestId);
    const record = await getGeneration(id);
    if (!record) return jsonError("영상 작업을 찾을 수 없습니다.", 404, requestId);
    const refreshed = await refreshVideoGeneration(record);
    if (refreshed.status !== record.status) {
      console.info(`[video.poll] requestId=${requestId} generationId=${id} provider=${refreshed.provider || "google"} status=${refreshed.status}`);
    }
    return NextResponse.json({ generation: generationView(refreshed), requestId });
  } catch (error) {
    logServerError("video.poll", error, requestId);
    return jsonError("영상 생성 상태를 확인하지 못했습니다. 잠시 후 다시 확인해 주세요.", 500, requestId);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("영상 작업 번호가 올바르지 않습니다.", 400, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    if (body.approved !== true) return jsonError("승인 정보를 확인해 주세요.", 400, requestId);
    const record = await getGeneration(id);
    if (!record || record.status !== "ready") return jsonError("승인할 완성 영상을 찾을 수 없습니다.", 404, requestId);
    const approved = { ...record, approvalStatus: "approved" as const, updatedAt: new Date().toISOString() };
    await saveGeneration(approved);
    console.info(`[shot.approve] requestId=${requestId} generationId=${id}`);
    return NextResponse.json({ generation: generationView(approved), requestId });
  } catch (error) {
    logServerError("shot.approve", error, requestId);
    return jsonError("Shot을 승인하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
