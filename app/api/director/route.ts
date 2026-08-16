import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { createDirectorPlan } from "@/lib/director/create-plan";

export const maxDuration = 180;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as { story?: unknown };
    const story = typeof body.story === "string" ? body.story.trim() : "";
    if (story.length < 10) return jsonError("이야기를 조금 더 자세히 들려주세요.", 400, requestId);
    if (story.length > 12_000) return jsonError("이야기는 12,000자 이내로 적어주세요.", 400, requestId);

    const result = await createDirectorPlan(story);
    console.info(
      `[director.create] requestId=${requestId} responseId=${result.responseId} model=${result.model} scenes=${result.plan.scenes.length} shots=${result.plan.totalShots}`,
    );
    return NextResponse.json({ plan: result.plan, references: result.references, requestId });
  } catch (error) {
    logServerError("director.create", error, requestId);
    if (error instanceof OpenAI.APIError) {
      if (error.status === 401 || error.status === 403) {
        return jsonError("AI Director 연결 설정을 확인해 주세요.", 503, requestId);
      }
      if (error.status === 429) {
        return jsonError("AI Director 요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, requestId);
      }
    }
    return jsonError("이야기 장면을 구성하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
