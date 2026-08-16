import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { normalizeDirectorPlan } from "@/lib/director/normalize";
import { getEpisode, updateEpisodePlan } from "@/lib/episodes/storage";
import { listReferences } from "@/lib/references/storage";

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("Episode 번호가 올바르지 않습니다.", 400, requestId);
    const episode = await getEpisode(id);
    if (!episode) return jsonError("저장된 이야기를 찾을 수 없습니다.", 404, requestId);
    return NextResponse.json({ episode, requestId });
  } catch (error) {
    logServerError("episode.get", error, requestId);
    return jsonError("저장된 이야기를 불러오지 못했습니다.", 500, requestId);
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const { id } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return jsonError("Episode 번호가 올바르지 않습니다.", 400, requestId);
    const current = await getEpisode(id);
    if (!current) return jsonError("저장할 이야기를 찾을 수 없습니다.", 404, requestId);
    const body = (await request.json()) as Record<string, unknown>;
    const availableReferences = await listReferences();
    const availableReferenceIds = new Set(availableReferences.map((reference) => reference.id));
    const plan = normalizeDirectorPlan(body.plan, availableReferenceIds);
    const selectedReferenceIds = plan.scenes.flatMap((scene) => scene.shots.flatMap((shot) => shot.referenceIds));
    const episode = await updateEpisodePlan(id, plan, selectedReferenceIds);
    return NextResponse.json({ episode, requestId });
  } catch (error) {
    logServerError("episode.update", error, requestId);
    return jsonError("이야기 수정 내용을 저장하지 못했습니다.", 500, requestId);
  }
}
