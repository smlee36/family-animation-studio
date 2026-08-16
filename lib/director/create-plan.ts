import "server-only";

import { get } from "@vercel/blob";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import { normalizeDirectorPlan } from "@/lib/director/normalize";
import { DIRECTOR_PLAN_SCHEMA } from "@/lib/director/schema";
import type { DirectorReference, DirectorResponse } from "@/lib/director/types";
import { listReferences } from "@/lib/references/storage";

const MAX_STORYBOARD_IMAGES = 3;
const MAX_STORYBOARD_BYTES = 5 * 1024 * 1024;

const DIRECTOR_INSTRUCTIONS = `You are the director of a private family animation studio.
Turn one long Korean family story into semantic Scenes, then into generation-ready Shots.

Rules:
- Group by a coherent situation, place, time, or immediate purpose. Never split by a fixed duration formula.
- Each Shot must contain exactly one main visible action, normally expressible with one principal action verb. A Shot may contain a continuing pose but not a chain of actions.
- Always split sequences such as "wake up, pick up a toy, take a parent's hand, and walk" into separate Shots. Never hide extra actions in clauses joined by and/then/while.
- Treat hand contact, picking up, putting down, handing over, opening, and drinking as their own Shot when they change the visible state. A walking Shot starts with any toy already held and any needed hand contact already established.
- Keep the story complete without padding or repetitive filler. Use as many Scenes and Shots as the narrative complexity genuinely needs.
- Write titles, summaries, actions, states, and reference reasons in natural Korean.
- Write each video prompt in concise production-ready English. Lead with positive visual instructions.
- When characters recur, preserve the same identity, face, hairstyle, body proportions, and appropriate clothing. Preserve backgrounds and objects within a Scene. Briefly ask for stable features, natural hands/body, and no duplicates only when relevant.
- Make each Shot's startState compatible with the previous Shot's endState. End states must be visually concrete so a later system can use the last frame for continuity.
- Select zero to three reference IDs from the supplied library. References are optional. Prefer the smallest high-value set and avoid redundant character/object references when one scene reference already depicts them accurately.
- sceneMasterReferenceId is the best reusable scene anchor, or an empty string when none fits.
- Storyboard images, when attached, are planning evidence. Reconcile them with the user's text; the text determines the intended story if they differ.
- Never invent a reference ID.`;

async function storyboardInput(references: Awaited<ReturnType<typeof listReferences>>) {
  const storyboards = references
    .filter((reference) => reference.category === "스토리보드" && reference.size <= MAX_STORYBOARD_BYTES)
    .slice(0, MAX_STORYBOARD_IMAGES);
  const content: Responses.ResponseInputContent[] = [];

  for (const [index, storyboard] of storyboards.entries()) {
    const blob = await get(storyboard.imagePathname, { access: "private", useCache: false });
    if (!blob?.stream || blob.statusCode !== 200) continue;
    const bytes = await new Response(blob.stream).arrayBuffer();
    const dataUrl = `data:${storyboard.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    content.push({
      type: "input_text",
      text: `Storyboard ${index + 1}: id=${storyboard.id}, name=${storyboard.name}`,
    });
    content.push({ type: "input_image", detail: "auto", image_url: dataUrl });
  }

  return content;
}

export async function createDirectorPlan(story: string): Promise<DirectorResponse & { responseId: string; model: string }> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) throw new Error("OPENAI_API_KEY is not configured");

  const references = await listReferences();
  const referenceCatalog: DirectorReference[] = references.map(({ id, name, category, description }) => ({
    id,
    name,
    category,
    description,
  }));
  const content: Responses.ResponseInputContent[] = [
    {
      type: "input_text",
      text: `USER STORY:\n${story}\n\nMASTER REFERENCE LIBRARY:\n${JSON.stringify(referenceCatalog)}`,
    },
    ...(await storyboardInput(references)),
  ];
  const model = process.env.OPENAI_DIRECTOR_MODEL?.trim() || "gpt-5.6-terra";
  const client = new OpenAI({ apiKey, timeout: 120_000, maxRetries: 2 });
  const response = await client.responses.create({
    model,
    instructions: DIRECTOR_INSTRUCTIONS,
    input: [{ role: "user", content }],
    max_output_tokens: 20_000,
    store: false,
    text: {
      format: {
        type: "json_schema",
        name: "family_animation_director_plan",
        strict: true,
        schema: DIRECTOR_PLAN_SCHEMA,
      },
    },
  });

  if (!response.output_text) throw new Error(`OpenAI response ${response.id} did not contain output_text`);
  const plan = normalizeDirectorPlan(JSON.parse(response.output_text), new Set(references.map(({ id }) => id)));
  return { plan, references: referenceCatalog, responseId: response.id, model };
}
