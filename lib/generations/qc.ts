import "server-only";

import { get } from "@vercel/blob";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import { getReference } from "@/lib/references/storage";
import type { InitialFrameKind, ShotQualityResult, ShotQualityScores } from "@/lib/generations/types";
import { CHILD_SCALE_LOCK, PARENT_SCALE_LOCK, TEDDY_SCALE_LOCK } from "@/lib/visual-bible";
import { qwenProviderEnabled, qwenVisionJson, type QwenVisionContent } from "@/lib/qwen/client";

const QC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores", "summary", "correctionPrompt"],
  properties: {
    scores: {
      type: "object",
      additionalProperties: false,
      required: [
        "characterConsistency",
        "faceStability",
        "handsBody",
        "backgroundConsistency",
        "objectConsistency",
        "motionNaturalness",
        "referenceMatch",
        "continuity",
      ],
      properties: {
        characterConsistency: { type: "integer", minimum: 0, maximum: 100 },
        faceStability: { type: "integer", minimum: 0, maximum: 100 },
        handsBody: { type: "integer", minimum: 0, maximum: 100 },
        backgroundConsistency: { type: "integer", minimum: 0, maximum: 100 },
        objectConsistency: { type: "integer", minimum: 0, maximum: 100 },
        motionNaturalness: { type: "integer", minimum: 0, maximum: 100 },
        referenceMatch: { type: "integer", minimum: 0, maximum: 100 },
        continuity: { type: "integer", minimum: 0, maximum: 100 },
      },
    },
    summary: { type: "string", minLength: 1, maxLength: 500 },
    correctionPrompt: { type: "string", minLength: 1, maxLength: 1_000 },
  },
} as const;

const QC_INSTRUCTIONS = `You are the quality-control reviewer for a private family animation studio.
You receive ordered still frames sampled from one generated video Shot, plus optional reference images and the intended Shot description.

Score each category from 0 to 100:
- characterConsistency: identity, hairstyle, clothing, and body proportions stay stable across the sampled frames.
- faceStability: faces remain recognizable and structurally stable.
- handsBody: hands, limbs, anatomy, and contact look natural.
- backgroundConsistency: the setting does not drift or transform unexpectedly.
- objectConsistency: key props retain their appearance and do not duplicate or disappear unexpectedly.
- motionNaturalness: infer motion from changes across ordered frames; penalize jumps, ghosting, and implausible pose changes.
- referenceMatch: the supplied Master References are immutable visual canon, not inspiration. Compare exact Korean family identity, face, hair, glasses, body proportions, clothing, room layout, furniture, object design, markings, colors, illustration style, and relative physical scale. Score below 85 when a referenced element is visibly reinterpreted, substituted, resized, or redesigned. If no reference image is supplied, judge prompt conformity without penalizing the absence of a reference.
- continuity: when a PREVIOUS SHOT FINAL FRAME is supplied, compare it directly with ORDERED VIDEO FRAME 1. Character position, pose, gaze, clothing, camera angle, lighting, background, and object placement should continue naturally unless the Shot specification explicitly requests a change. Score below 70 for an unexplained visual jump. Then judge whether the ordered frames plausibly progress from the described start state to the end state.

Use these fixed size facts whenever those subjects appear:
- ${CHILD_SCALE_LOCK}
- ${PARENT_SCALE_LOCK}
- ${TEDDY_SCALE_LOCK}
If the child looks older, taller, or adult-proportioned, keep characterConsistency and referenceMatch below 70. If the teddy is miniature, duplicated, or not large enough for the child to lie against, keep objectConsistency and referenceMatch below 70.

Write summary in concise natural Korean. Write correctionPrompt in concise production-ready English, leading with the exact scale correction and then the other most important corrections. Include the numeric child/teddy sizes above when either scale is wrong. Do not produce a long prohibition list. The frames are sparse samples, so do not claim to have inspected audio or every video frame.`;

function clampScore(value: unknown) {
  return Math.max(0, Math.min(100, Math.round(typeof value === "number" ? value : 0)));
}

function normalizeScores(value: Record<string, unknown>, hasReferences: boolean): ShotQualityScores {
  return {
    characterConsistency: clampScore(value.characterConsistency),
    faceStability: clampScore(value.faceStability),
    handsBody: clampScore(value.handsBody),
    backgroundConsistency: clampScore(value.backgroundConsistency),
    objectConsistency: clampScore(value.objectConsistency),
    motionNaturalness: clampScore(value.motionNaturalness),
    referenceMatch: hasReferences ? clampScore(value.referenceMatch) : 100,
    continuity: clampScore(value.continuity),
  };
}

function overallScore(scores: ShotQualityScores) {
  return Math.round(
    scores.characterConsistency * 0.2 +
    scores.faceStability * 0.15 +
    scores.handsBody * 0.12 +
    scores.backgroundConsistency * 0.1 +
    scores.objectConsistency * 0.1 +
    scores.motionNaturalness * 0.13 +
    scores.referenceMatch * 0.1 +
    scores.continuity * 0.1,
  );
}

async function referenceContent(referenceIds: string[]) {
  const references = (await Promise.all(referenceIds.slice(0, 6).map((id) => getReference(id))))
    .filter((reference) => Boolean(reference));
  const content = await Promise.all(references.map(async (reference) => {
    if (!reference) return [] as Responses.ResponseInputContent[];
    const blob = await get(reference.imagePathname, { access: "private", useCache: true });
    if (!blob?.stream || blob.statusCode !== 200) return [] as Responses.ResponseInputContent[];
    const bytes = await new Response(blob.stream).arrayBuffer();
    return [
      { type: "input_text", text: `REFERENCE: ${reference.category} · ${reference.name}` },
      { type: "input_image", detail: "auto", image_url: `data:${reference.contentType};base64,${Buffer.from(bytes).toString("base64")}` },
    ] satisfies Responses.ResponseInputContent[];
  }));
  return content.flat();
}

export async function evaluateShotQuality(input: {
  frames: string[];
  referenceIds: string[];
  continuityFrame?: string;
  initialFrameKind?: InitialFrameKind;
  shot: {
    title: string;
    action: string;
    prompt: string;
    startState: string;
    endState: string;
  };
}): Promise<ShotQualityResult> {
  const references = await referenceContent(input.referenceIds);
  const frameContent: Responses.ResponseInputContent[] = input.frames.flatMap((imageUrl, index) => [
    { type: "input_text", text: `ORDERED VIDEO FRAME ${index + 1} OF ${input.frames.length}` },
    { type: "input_image", detail: "auto", image_url: imageUrl },
  ]);
  const continuityContent: Responses.ResponseInputContent[] = input.continuityFrame ? [
    { type: "input_text", text: input.initialFrameKind === "scene_master"
      ? "SCENE MASTER FIRST FRAME — compare this directly with ORDERED VIDEO FRAME 1. The video's first frame must preserve its exact 2D illustration style, composition, identities, proportions, and objects; penalize any conversion to realistic or live-action people."
      : "PREVIOUS SHOT FINAL FRAME — compare this directly with ORDERED VIDEO FRAME 1 for cross-Shot continuity." },
    { type: "input_image", detail: "high", image_url: input.continuityFrame },
  ] : [];
  const allContent = [
    {
      type: "input_text" as const,
      text: `SHOT SPECIFICATION:\n${JSON.stringify(input.shot)}\n\nReference images appear first when available. Ordered sampled frames follow.`,
    },
    ...references,
    ...continuityContent,
    ...frameContent,
  ];
  if (qwenProviderEnabled("qc")) {
    try {
      const response = await qwenVisionJson({
        instructions: QC_INSTRUCTIONS,
        content: allContent as QwenVisionContent[],
        schemaName: "family_animation_shot_qc",
        schema: QC_SCHEMA,
        maxOutputTokens: 4_000,
      });
      const parsed = JSON.parse(response.outputText) as {
        scores?: Record<string, unknown>;
        summary?: unknown;
        correctionPrompt?: unknown;
      };
      const scores = normalizeScores(parsed.scores || {}, references.length > 0);
      return {
        scores,
        overall: overallScore(scores),
        summary: typeof parsed.summary === "string" ? parsed.summary : "영상 품질 검수가 완료되었습니다.",
        correctionPrompt: typeof parsed.correctionPrompt === "string" ? parsed.correctionPrompt : "Preserve stable characters, natural motion, and consistent scene details.",
        evaluatedAt: new Date().toISOString(),
        responseId: response.responseId,
        model: response.model,
      };
    } catch (error) {
      console.error("[qc.qwen-fallback]", error);
      if (process.env.QWEN_OPENAI_FALLBACK?.trim().toLowerCase() === "disabled") throw error;
    }
  }

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");
  const model = process.env.OPENAI_QC_MODEL?.trim() || "gpt-5.6-terra";
  const client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 2 });
  const response = await client.responses.create({
    model,
    instructions: QC_INSTRUCTIONS,
    input: [{
      role: "user",
      content: allContent,
    }],
    max_output_tokens: 4_000,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "family_animation_shot_qc",
        strict: true,
        schema: QC_SCHEMA,
      },
    },
  });

  if (!response.output_text) throw new Error(`OpenAI response ${response.id} did not contain output_text`);
  const parsed = JSON.parse(response.output_text) as {
    scores?: Record<string, unknown>;
    summary?: unknown;
    correctionPrompt?: unknown;
  };
  const scores = normalizeScores(parsed.scores || {}, references.length > 0);
  return {
    scores,
    overall: overallScore(scores),
    summary: typeof parsed.summary === "string" ? parsed.summary : "영상 품질 검수가 완료되었습니다.",
    correctionPrompt: typeof parsed.correctionPrompt === "string" ? parsed.correctionPrompt : "Preserve stable characters, natural motion, and consistent scene details.",
    evaluatedAt: new Date().toISOString(),
    responseId: response.id,
    model,
  };
}
