import "server-only";

import { get } from "@vercel/blob";
import OpenAI from "openai";
import type { Responses } from "openai/resources/responses/responses";
import { normalizeDirectorPlan } from "@/lib/director/normalize";
import { DIRECTOR_PLAN_SCHEMA } from "@/lib/director/schema";
import type { DirectorReference, DirectorResponse } from "@/lib/director/types";
import { listReferences } from "@/lib/references/storage";
import { getStoryInputs } from "@/lib/story-inputs/storage";
import { CHILD_SCALE_LOCK, PARENT_SCALE_LOCK, TEDDY_SCALE_LOCK } from "@/lib/visual-bible";
import type { EpisodeFormat } from "@/lib/episodes/types";

const MAX_STORYBOARD_IMAGES = 3;
const MAX_STORYBOARD_BYTES = 5 * 1024 * 1024;
const MAX_EPISODE_IMAGE_BYTES = 20 * 1024 * 1024;
const MAX_MASTER_REFERENCE_IMAGES = 12;

const DIRECTOR_INSTRUCTIONS = `You are the director of a private family animation studio.
Turn one long Korean family story into semantic Scenes, then into generation-ready Shots.

Rules:
- Group by a coherent situation, place, time, or immediate purpose. Never split by a fixed duration formula.
- Each Shot must contain exactly one main visible action, normally expressible with one principal action verb. A Shot may contain a continuing pose but not a chain of actions.
- Always split sequences such as "wake up, pick up a toy, take a parent's hand, and walk" into separate Shots. Never hide extra actions in clauses joined by and/then/while.
- Treat hand contact, picking up, putting down, handing over, opening, and drinking as their own Shot when they change the visible state. A walking Shot starts with any toy already held and any needed hand contact already established.
- Keep the story complete without padding or repetitive filler. Use as many Scenes and Shots as the narrative complexity genuinely needs.
- estimatedSeconds must be exactly 5 or 10. Use 5 seconds for one simple action and 10 seconds only when a larger continuous action genuinely needs more time.
- Write titles, summaries, actions, states, and reference reasons in natural Korean.
- Write each video prompt in concise production-ready English. Lead with positive visual instructions.
- This is a Korean family. Every video prompt containing a person must explicitly identify them as Korean: Korean father, Korean mother, and the exact 34-month-old Korean toddler boy as applicable. Never substitute a generic, Western, or unrelated family appearance.
- Every supplied Master Reference image is an immutable visual canon, never optional inspiration. Together they form one locked Visual Bible for the family members, rooms, objects, colors, and artwork. Inspect every relevant image and preserve its exact face shape, eyes, hairstyle, glasses, age, body proportions, clothing, room layout, furniture, object shape, markings, colors, and illustration style. Never replace, reinterpret, beautify, westernize, or redesign a referenced element.
- Treat the Master References' artwork as the house style for the entire Episode: a warm Korean family storybook illustration with soft cream and beige colors, delicate clean linework, gently rounded proportions, natural affectionate expressions, soft light, and subtle hand-painted texture. Match the References rather than switching to photorealism, 3D animation, anime, or a different illustration style.
- When characters recur, preserve the same identity, face, hairstyle, body proportions, Korean appearance, and appropriate clothing. Preserve backgrounds and objects within a Scene. Briefly ask for stable features, natural hands/body, and no duplicates only when relevant.
- Write the applicable fixed scale facts directly into every Shot prompt: ${CHILD_SCALE_LOCK} ${PARENT_SCALE_LOCK} ${TEDDY_SCALE_LOCK} Apply only the facts for subjects visible in that Shot. Preserve relative physical size under perspective and across frames.
- Make each Shot's startState compatible with the previous Shot's endState. End states must be visually concrete so a later system can use the last frame for continuity.
- For every Shot, select every relevant character, room, and object Master Reference ID, up to six IDs for Gemini Omni's multimodal video input. Prefer combined character/scene sheets when they accurately cover several elements. Encode the locked appearance of any additional relevant Master Reference explicitly in the English prompt.
- sceneMasterReferenceId is the best reusable scene anchor, or an empty string when none fits.
- Episode storyboard images are primary planning evidence. Read numbered panels, captions, characters, places, objects, and action order carefully. Preserve their sequence and turn visible actions into semantic Scenes and one-action Shots.
- Reconcile attached images with the user's text. When text is present it clarifies intent; when text is empty, derive the complete story from the attached images without asking for clarification.
- Master Library storyboard images are supporting references and must not override the Episode storyboard images.
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

async function episodeStoryboardInput(ids: string[]) {
  const inputs = (await getStoryInputs(ids)).filter((input) => input.size <= MAX_EPISODE_IMAGE_BYTES).slice(0, MAX_STORYBOARD_IMAGES);
  const content: Responses.ResponseInputContent[] = [];
  for (const [index, input] of inputs.entries()) {
    const blob = await get(input.imagePathname, { access: "private", useCache: false });
    if (!blob?.stream || blob.statusCode !== 200) continue;
    const bytes = await new Response(blob.stream).arrayBuffer();
    const dataUrl = `data:${input.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    content.push({ type: "input_text", text: `EPISODE STORYBOARD ${index + 1}: ${input.name}` });
    content.push({ type: "input_image", detail: "high", image_url: dataUrl });
  }
  return content;
}

async function masterReferenceImageInput(references: Awaited<ReturnType<typeof listReferences>>) {
  const categoryPriority = new Map(["아이", "엄마", "아빠", "거실", "침실", "곰인형", "물병", "장난감"].map((category, index) => [category, index]));
  const selected = references
    .filter((reference) => reference.category !== "스토리보드" && reference.size <= MAX_STORYBOARD_BYTES)
    .sort((left, right) => (categoryPriority.get(left.category) ?? 99) - (categoryPriority.get(right.category) ?? 99))
    .slice(0, MAX_MASTER_REFERENCE_IMAGES);
  const content: Responses.ResponseInputContent[] = [];
  for (const reference of selected) {
    const blob = await get(reference.imagePathname, { access: "private", useCache: false });
    if (!blob?.stream || blob.statusCode !== 200) continue;
    const bytes = await new Response(blob.stream).arrayBuffer();
    const dataUrl = `data:${reference.contentType};base64,${Buffer.from(bytes).toString("base64")}`;
    content.push({ type: "input_text", text: `MASTER REFERENCE: id=${reference.id}, category=${reference.category}, name=${reference.name}, description=${reference.description || "(none)"}` });
    content.push({ type: "input_image", detail: ["아이", "엄마", "아빠"].includes(reference.category) ? "high" : "auto", image_url: dataUrl });
  }
  return content;
}

export async function createDirectorPlan(story: string, storyboardInputIds: string[] = [], format: EpisodeFormat = "reels"): Promise<DirectorResponse & { responseId: string; model: string }> {
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
      text: `OUTPUT FORMAT: ${format === "reels" ? "Instagram Reel, vertical 9:16, usually 75-100 seconds. Keep the complete story but favor 15-18 concise visual Shots and mobile-friendly compositions with the subject centered away from top and bottom UI zones." : "Landscape family video, 16:9."}\n\nUSER STORY:\n${story || "(No text. Build the story from the Episode storyboard images.)"}\n\nMASTER REFERENCE LIBRARY:\n${JSON.stringify(referenceCatalog)}`,
    },
    ...(await episodeStoryboardInput(storyboardInputIds)),
    ...(await masterReferenceImageInput(references)),
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
