import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { NextRequest, NextResponse } from "next/server";
import { jsonError, logServerError, requireApiSession } from "@/lib/api";
import { CHILD_SCALE_LOCK, PARENT_SCALE_LOCK, TEDDY_SCALE_LOCK } from "@/lib/visual-bible";
import { appendPromptInstruction, MAX_GENERATION_PROMPT_CHARS } from "@/lib/generations/prompt";

const REVISED_PROMPT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["prompt"],
  properties: { prompt: { type: "string", minLength: 10, maxLength: 4000 } },
} as const;

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  const unauthorized = await requireApiSession();
  if (unauthorized) return unauthorized;

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const currentPrompt = typeof body.currentPrompt === "string" ? body.currentPrompt.trim() : "";
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";
    const action = typeof body.action === "string" ? body.action.trim() : "";
    const startState = typeof body.startState === "string" ? body.startState.trim() : "";
    const endState = typeof body.endState === "string" ? body.endState.trim() : "";
    if (currentPrompt.length < 10 || currentPrompt.length > MAX_GENERATION_PROMPT_CHARS || instruction.length < 2 || instruction.length > 500 || action.length > 2_000 || startState.length > 2_000 || endState.length > 2_000) {
      return jsonError("수정할 내용을 2자 이상 500자 이내로 적어주세요.", 400, requestId);
    }
    const apiKey = process.env.OPENAI_API_KEY?.trim();
    if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
    const model = process.env.OPENAI_DIRECTOR_MODEL?.trim() || "gpt-5.6-terra";
    const client = new OpenAI({ apiKey, timeout: 60_000, maxRetries: 2 });
    const response = await client.responses.create({
      model,
      store: false,
      max_output_tokens: 1_200,
      instructions: `Write one concise English amendment to append to an existing video prompt according to the user's Korean revision request. Return only the new highest-priority amendment. Do not rewrite, summarize, repeat, or shorten the existing prompt.
This is a Korean family. Every Master Reference is immutable visual canon rather than inspiration. Preserve the Korean ethnicity and exact family identity, face, hair, glasses, body, clothing, room layout, furniture, object design, markings, colors, and artwork defined by the Master References. Never substitute, beautify, westernize, reinterpret, or redesign any referenced element.
The Master References define the Episode's locked house art style. Preserve their warm Korean family storybook illustration, soft cream and beige palette, delicate clean linework, gently rounded proportions, natural affectionate expressions, soft lighting, and subtle hand-painted texture. Never switch to photorealism, 3D, anime, or another style unless the user explicitly asks to change the art style.
Preserve the Shot's single main action, exact face, hairstyle, glasses, clothing, body proportions, background, objects, start state, and end state unless the user explicitly requests a non-identity change.
Apply the relevant fixed scale facts whenever those subjects appear: ${CHILD_SCALE_LOCK} ${PARENT_SCALE_LOCK} ${TEDDY_SCALE_LOCK}
Prefer positive visual instructions. Keep continuity with adjacent Shots. Do not add unrelated actions or explanatory text.`,
      input: `CURRENT PROMPT:\n${currentPrompt}\n\nSHOT ACTION:\n${action}\n\nSTART STATE:\n${startState}\n\nEND STATE:\n${endState}\n\nUSER REVISION (KOREAN):\n${instruction}`,
      text: { format: { type: "json_schema", name: "revised_veo_prompt", strict: true, schema: REVISED_PROMPT_SCHEMA } },
    });
    if (!response.output_text) throw new Error(`OpenAI response ${response.id} did not contain output_text`);
    const parsed = JSON.parse(response.output_text) as { prompt?: unknown };
    const revisionPrompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (revisionPrompt.length < 10 || revisionPrompt.length > 4_000) throw new Error("Revised prompt was invalid");
    const prompt = appendPromptInstruction(currentPrompt, "USER REVISION — highest priority:", revisionPrompt);
    if (prompt.length > MAX_GENERATION_PROMPT_CHARS) throw new Error(`Revised prompt exceeds ${MAX_GENERATION_PROMPT_CHARS} characters`);
    console.info(`[shot.revise] requestId=${requestId} responseId=${response.id} model=${model}`);
    return NextResponse.json({ prompt, responseId: response.id, requestId });
  } catch (error) {
    logServerError("shot.revise", error, requestId);
    if (error instanceof OpenAI.APIError && error.status === 429) return jsonError("수정 요청이 많습니다. 잠시 후 다시 시도해 주세요.", 429, requestId);
    return jsonError("수정 프롬프트를 준비하지 못했습니다. 잠시 후 다시 시도해 주세요.", 500, requestId);
  }
}
