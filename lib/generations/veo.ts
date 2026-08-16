import "server-only";

import { get, put } from "@vercel/blob";
import { GoogleGenAI, VideoGenerationReferenceType, type VideoGenerationReferenceImage } from "@google/genai";
import type { InitialFrameKind, ShotGenerationRecord, VeoQualityTier, VideoAspectRatio } from "@/lib/generations/types";
import { generationContinuityFramePath, generationSceneMasterFramePath, generationVideoPath, saveGeneration } from "@/lib/generations/storage";
import { linkGenerationToEpisode } from "@/lib/episodes/storage";
import { getReference } from "@/lib/references/storage";
import { familyScaleLock, referenceScaleHint } from "@/lib/visual-bible";

const MAX_REFERENCE_BYTES = 5 * 1024 * 1024;
const MINOR_PATTERN = /\b(child|kid|toddler|baby|boy|girl|infant)\b|아이|아기/i;
const PERSON_PATTERN = /\b(person|people|family|father|mother|parent|child|kid|toddler|baby|boy|girl|man|woman|dad|mom)\b|가족|아빠|엄마|아이|아기/i;

type OmniReference = {
  id: string;
  category: string;
  name: string;
  description: string;
  data: string;
  mimeType: string;
};

export type ContinuityFrameInput = {
  sourceGenerationId?: string;
  data?: string;
  mimeType?: string;
  pathname?: string;
  kind?: InitialFrameKind;
  model?: string;
};

type LoadedContinuityFrame = {
  sourceGenerationId: string;
  data: string;
  mimeType: string;
  pathname: string;
  bytes?: Buffer;
  kind: InitialFrameKind;
  model: string;
};

export class SceneMasterFrameError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SceneMasterFrameError";
  }
}

function masterReferenceLockPrompt(prompt: string, constraints: string[]) {
  const identity = PERSON_PATTERN.test(prompt)
    ? "This is the exact same Korean family. Preserve their Korean facial identity, face shape, eyes, hairstyle, glasses when present, age, body proportions, and established clothing with stable facial features, natural anatomy, and no duplicate people."
    : "";
  const assets = constraints.length
    ? `Locked assets for this Shot: ${constraints.join(" | ")}.`
    : "All relevant people, locations, and objects must retain the exact appearance already defined in the Master Reference Library.";
  const scaleLock = familyScaleLock(`${prompt}\n${constraints.join("\n")}`);
  return `${prompt}\nMaster Reference lock: Every Master Reference is immutable visual canon, not loose inspiration. ${assets} Preserve exact character identity, room layout, furniture, object shape, markings, colors, and proportions. ${identity} Match the locked warm Korean family storybook artwork: soft cream and beige colors, delicate clean linework, gently rounded proportions, natural affectionate expressions, soft light, and subtle hand-painted texture. Do not reinterpret or redesign any referenced element, and do not switch to photorealism, 3D animation, anime, or another visual style.${scaleLock}`;
}

function apiKey() {
  const value = process.env.GEMINI_API_KEY?.trim();
  if (!value) throw new Error("GEMINI_API_KEY is not configured");
  return value;
}

function nearestDuration(value: number): 4 | 6 | 8 {
  if (value <= 5) return 4;
  if (value <= 7) return 6;
  return 8;
}

async function loadReferences(referenceIds: string[], allowReferences: boolean) {
  const requested = [...new Set(referenceIds)].slice(0, 3);
  const images: VideoGenerationReferenceImage[] = [];
  const used: string[] = [];
  const omitted: string[] = [];
  const constraints: string[] = [];
  for (const id of requested) {
    const reference = await getReference(id);
    if (!reference) {
      omitted.push(id);
      continue;
    }
    constraints.push(`${reference.category} '${reference.name}'${reference.description ? ` (${reference.description})` : ""}`);
    if (!allowReferences || reference.size > MAX_REFERENCE_BYTES || reference.category === "아이" || reference.category === "스토리보드") {
      omitted.push(id);
      continue;
    }
    const blob = await get(reference.imagePathname, { access: "private", useCache: true });
    if (!blob?.stream || blob.statusCode !== 200) {
      omitted.push(id);
      continue;
    }
    const bytes = await new Response(blob.stream).arrayBuffer();
    images.push({
      image: { imageBytes: Buffer.from(bytes).toString("base64"), mimeType: reference.contentType },
      referenceType: VideoGenerationReferenceType.ASSET,
    });
    used.push(id);
  }
  return { images, used, omitted, constraints };
}

async function loadOmniReferences(referenceIds: string[]) {
  const requested = [...new Set(referenceIds)].slice(0, 6);
  const references: OmniReference[] = [];
  const omitted: string[] = [];
  for (const id of requested) {
    const reference = await getReference(id);
    if (!reference || reference.size > MAX_REFERENCE_BYTES) {
      omitted.push(id);
      continue;
    }
    const blob = await get(reference.imagePathname, { access: "private", useCache: true });
    if (!blob?.stream || blob.statusCode !== 200) {
      omitted.push(id);
      continue;
    }
    const bytes = await new Response(blob.stream).arrayBuffer();
    references.push({
      id,
      category: reference.category,
      name: reference.name,
      description: reference.description,
      data: Buffer.from(bytes).toString("base64"),
      mimeType: reference.contentType,
    });
  }
  return { references, omitted };
}

async function loadContinuityFrame(input: ContinuityFrameInput | undefined): Promise<LoadedContinuityFrame | null> {
  if (!input || (!input.sourceGenerationId && !input.pathname && !input.data)) return null;
  if (input.data && input.mimeType) {
    const bytes = Buffer.from(input.data, "base64");
    if (!bytes.length) return null;
    return {
      sourceGenerationId: input.sourceGenerationId || "",
      data: input.data,
      mimeType: input.mimeType,
      pathname: input.pathname || "",
      bytes,
      kind: input.kind || "continuity",
      model: input.model || "",
    };
  }
  if (!input.pathname) return null;
  const blob = await get(input.pathname, { access: "private", useCache: true });
  if (!blob?.stream || blob.statusCode !== 200) return null;
  const bytes = Buffer.from(await new Response(blob.stream).arrayBuffer());
  return {
    sourceGenerationId: input.sourceGenerationId || "",
    data: bytes.toString("base64"),
    mimeType: input.mimeType || blob.blob.contentType || "image/jpeg",
    pathname: input.pathname,
    kind: input.kind || "continuity",
    model: input.model || "",
  };
}

async function createSceneMasterFrame(input: { id: string; prompt: string; aspectRatio?: VideoAspectRatio; pathname?: string }, references: OmniReference[]): Promise<LoadedContinuityFrame> {
  const model = process.env.GEMINI_IMAGE_MODEL?.trim() || "gemini-3.1-flash-image";
  const aspectRatio = input.aspectRatio || "16:9";
  const constraints = references.map((reference, index) =>
    `REFERENCE ${index + 1}: exact locked ${reference.category} '${reference.name}'${reference.description ? ` (${reference.description})` : ""}`,
  );
  const prompt = `${masterReferenceLockPrompt(input.prompt, constraints)}

Create one finished ${aspectRatio} Scene Master Frame for the exact beginning state of this Shot.
This must look like the supplied warm Korean family 2D storybook/webtoon reference artwork: soft cream and beige palette, delicate clean linework, gently rounded illustrated faces and bodies, soft hand-painted texture, and affectionate natural expressions.
It must be a flat 2D illustration, never a photograph, live-action person, photorealistic render, cinematic realism, 3D render, or generic anime redesign.
Copy the referenced Korean family identity, facial design, hair, glasses, clothing, body scale, object scale, and location design as faithfully as possible. Treat multi-view character sheets as identity/style sheets only; do not copy their text, labels, panel borders, or multiple poses into the scene.
Show exactly one coherent animation frame with no captions, labels, speech bubbles, watermark, split panels, or extra characters. Compose the requested start state clearly and leave natural room for the requested motion.`;
  const ai = new GoogleGenAI({ apiKey: apiKey() });
  try {
    const interaction = await ai.interactions.create({
      model,
      store: false,
      input: [
        { type: "text", text: prompt },
        ...references.map((reference) => ({ type: "image" as const, data: reference.data, mime_type: reference.mimeType })),
      ],
      response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: aspectRatio, image_size: "1K" },
      generation_config: { thinking_level: "high" },
    });
    if (!interaction.output_image?.data) {
      throw new Error(`Gemini image model returned no image${interaction.errors?.length ? `: ${JSON.stringify(interaction.errors)}` : ""}`);
    }
    const data = interaction.output_image.data.replace(/^data:image\/[^;]+;base64,/, "");
    const bytes = Buffer.from(data, "base64");
    if (!bytes.length) throw new Error("Gemini image model returned an empty image");
    return {
      sourceGenerationId: "",
      data,
      mimeType: interaction.output_image.mime_type || "image/jpeg",
      pathname: input.pathname || generationSceneMasterFramePath(input.id),
      bytes,
      kind: "scene_master",
      model,
    };
  } catch (error) {
    throw new SceneMasterFrameError("Scene Master Frame generation failed", { cause: error });
  }
}

export async function generateSceneFrameImage(input: {
  id: string;
  prompt: string;
  referenceIds: string[];
  aspectRatio: VideoAspectRatio;
  pathname: string;
}) {
  const loaded = await loadOmniReferences(input.referenceIds);
  const frame = await createSceneMasterFrame(input, loaded.references);
  return {
    bytes: frame.bytes || Buffer.from(frame.data, "base64"),
    mimeType: frame.mimeType,
    model: frame.model,
    usedReferenceIds: loaded.references.map((reference) => reference.id),
    omittedReferenceIds: loaded.omitted,
  };
}

async function startOmniGeneration(input: {
  id: string;
  episodeId?: string;
  shotId: string;
  prompt: string;
  estimatedSeconds: number;
  qualityTier?: VeoQualityTier;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  continuityFrame?: ContinuityFrameInput;
  aspectRatio?: VideoAspectRatio;
}, references: OmniReference[], omittedReferenceIds: string[], continuityFrame: LoadedContinuityFrame | null) {
  const durationSeconds = nearestDuration(input.estimatedSeconds);
  const constraints = references.map((reference) => `${reference.category} '${reference.name}'${reference.description ? ` (${reference.description})` : ""}`);
  const effectivePrompt = masterReferenceLockPrompt(input.prompt, constraints);
  // image_to_video accepts exactly one image. The Scene Master Frame already
  // contains the selected Visual Bible references, so never send the raw
  // character sheets beside it or Omni may reject them or show them literally.
  const directReferences = continuityFrame ? [] : references;
  const sourceDeclaration = continuityFrame ? "[# Sources <FIRST_FRAME>@Image1]" : "";
  const referenceDeclarations = directReferences.map((_, index) =>
    `<IMAGE_REF_${index}>@Image${index + (continuityFrame ? 2 : 1)}`,
  ).join(" ");
  const declarations = [sourceDeclaration, referenceDeclarations ? `[# References ${referenceDeclarations}]` : ""].filter(Boolean).join(" ");
  const assignments = directReferences.map((reference, index) => {
    const scaleHint = referenceScaleHint(reference.category);
    return `<IMAGE_REF_${index}> is the exact locked ${reference.category} reference named '${reference.name}'.${scaleHint ? ` ${scaleHint}` : ""}`;
  }).join("\n");
  const continuityInstruction = continuityFrame
    ? `${continuityFrame.kind === "scene_master" ? "Use the generated Scene Master Frame" : "Use the previous Shot final frame"} <FIRST_FRAME> as the exact first frame. Continue directly from its 2D illustration style, composition, camera angle, character positions, poses, gaze, clothing, lighting, background, and object placement, then animate only the requested Shot action. Never convert the illustrated people into live-action or photorealistic people.`
    : "";
  const referenceInstruction = directReferences.length
    ? "Use every <IMAGE_REF_N> as an exact visual reference for video generation, not as a literal initial frame. Preserve its linework, facial design, proportions, colors, clothing, room layout, and object design."
    : "";
  const explicitImageRoles = continuityFrame
    ? "Use Image1 as the exact starting frame of the video. It is the finished Scene Master Frame containing the locked Visual Bible identities and style."
    : directReferences.length
      ? `Use Images 1 through ${directReferences.length} only as visual references. Do not show the reference sheets, panels, labels, or text literally in the video.`
      : "";
  const prompt = `${declarations}\n${assignments}\n${effectivePrompt}\n${continuityInstruction}\n${referenceInstruction}\nAnimate only the requested Shot action.\n${explicitImageRoles}`;
  const model = process.env.GEMINI_OMNI_MODEL?.trim() || "gemini-omni-flash-preview";
  const ai = new GoogleGenAI({ apiKey: apiKey() });
  const interaction = await ai.interactions.create({
    model,
    store: false,
    input: [
      ...(continuityFrame ? [{ type: "image" as const, data: continuityFrame.data, mime_type: continuityFrame.mimeType }] : []),
      ...directReferences.map((reference) => ({ type: "image" as const, data: reference.data, mime_type: reference.mimeType })),
      { type: "text" as const, text: prompt },
    ],
    response_format: { type: "video", aspect_ratio: input.aspectRatio || "16:9", duration: `${durationSeconds}s`, delivery: "inline" },
    generation_config: { video_config: { task: continuityFrame ? "image_to_video" as const : "reference_to_video" as const } },
  });
  const output = interaction.output_video;
  if (!output?.data) throw new Error(`Gemini Omni did not return inline video data${interaction.errors?.length ? `: ${JSON.stringify(interaction.errors)}` : ""}`);
  const videoBytes = Buffer.from(output.data.replace(/^data:video\/[^;]+;base64,/, ""), "base64");
  if (!videoBytes.length) throw new Error("Gemini Omni returned an empty video");
  const videoPathname = generationVideoPath(input.id);
  await put(videoPathname, videoBytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: output.mime_type || "video/mp4",
    cacheControlMaxAge: 60 * 60 * 24 * 30,
  });
  let continuityFramePathname = continuityFrame?.pathname || "";
  if (continuityFrame?.bytes) {
    continuityFramePathname = continuityFrame.kind === "scene_master" ? generationSceneMasterFramePath(input.id) : generationContinuityFramePath(input.id);
    await put(continuityFramePathname, continuityFrame.bytes, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: continuityFrame.mimeType,
      cacheControlMaxAge: 60 * 60 * 24 * 30,
    });
  }
  const now = new Date().toISOString();
  const record: ShotGenerationRecord = {
    version: 1,
    id: input.id,
    episodeId: input.episodeId || "",
    shotId: input.shotId,
    operationName: interaction.id || `omni-${input.id}`,
    model,
    sourcePrompt: input.prompt,
    prompt,
    continuitySourceGenerationId: continuityFrame?.sourceGenerationId || "",
    continuityFramePathname,
    continuityFrameMimeType: continuityFrame?.mimeType || "",
    initialFrameKind: continuityFrame?.kind,
    initialFrameModel: continuityFrame?.model || "",
    status: "ready",
    durationSeconds,
    aspectRatio: input.aspectRatio || "16:9",
    usedReferenceIds: references.map((reference) => reference.id),
    omittedReferenceIds,
    videoPathname,
    error: "",
    createdAt: now,
    updatedAt: now,
    qualityTier: input.qualityTier || "fast",
    autoRegenerationCount: Math.min(2, Math.max(0, input.autoRegenerationCount || 0)),
    parentGenerationId: input.parentGenerationId || "",
    approvalStatus: "pending",
    qc: null,
  };
  await saveGeneration(record);
  if (record.episodeId) await linkGenerationToEpisode(record.episodeId, record.shotId, record.id);
  return record;
}

export async function startVeoGeneration(input: {
  id: string;
  episodeId?: string;
  shotId: string;
  prompt: string;
  estimatedSeconds: number;
  referenceIds: string[];
  qualityTier?: VeoQualityTier;
  autoRegenerationCount?: number;
  parentGenerationId?: string;
  continuityFrame?: ContinuityFrameInput;
  aspectRatio?: VideoAspectRatio;
}) {
  const omniReferences = await loadOmniReferences(input.referenceIds);
  let continuityFrame = await loadContinuityFrame(input.continuityFrame);
  if (!continuityFrame && omniReferences.references.length) {
    continuityFrame = await createSceneMasterFrame({ id: input.id, prompt: input.prompt, aspectRatio: input.aspectRatio }, omniReferences.references);
  }
  if (omniReferences.references.length || continuityFrame) {
    return startOmniGeneration(input, omniReferences.references, omniReferences.omitted, continuityFrame);
  }
  const containsMinor = MINOR_PATTERN.test(input.prompt);
  const references = await loadReferences(input.referenceIds, !containsMinor);
  const effectivePrompt = masterReferenceLockPrompt(input.prompt, references.constraints);
  const durationSeconds = references.images.length ? 8 : nearestDuration(input.estimatedSeconds);
  const qualityTier = input.qualityTier || "fast";
  const model = qualityTier === "fast"
    ? process.env.GEMINI_VEO_FAST_MODEL?.trim() || "veo-3.1-fast-generate-preview"
    : process.env.GEMINI_VEO_STANDARD_MODEL?.trim() || process.env.GEMINI_VEO_MODEL?.trim() || "veo-3.1-generate-preview";
  const ai = new GoogleGenAI({ apiKey: apiKey() });
  const operation = await ai.models.generateVideos({
    model,
    source: { prompt: effectivePrompt },
    config: {
      numberOfVideos: 1,
      durationSeconds,
      aspectRatio: input.aspectRatio || "16:9",
      resolution: "720p",
      personGeneration: references.images.length ? "allow_adult" : "allow_all",
      ...(references.images.length ? { referenceImages: references.images } : {}),
    },
  });
  if (!operation.name) throw new Error("Veo did not return an operation name");

  const now = new Date().toISOString();
  const record: ShotGenerationRecord = {
    version: 1,
    id: input.id,
    episodeId: input.episodeId || "",
    shotId: input.shotId,
    operationName: operation.name,
    model,
    sourcePrompt: input.prompt,
    prompt: effectivePrompt,
    continuitySourceGenerationId: "",
    continuityFramePathname: "",
    continuityFrameMimeType: "",
    initialFrameKind: undefined,
    initialFrameModel: "",
    status: "generating",
    durationSeconds,
    aspectRatio: input.aspectRatio || "16:9",
    usedReferenceIds: references.used,
    omittedReferenceIds: references.omitted,
    videoPathname: "",
    error: "",
    createdAt: now,
    updatedAt: now,
    qualityTier,
    autoRegenerationCount: Math.min(2, Math.max(0, input.autoRegenerationCount || 0)),
    parentGenerationId: input.parentGenerationId || "",
    approvalStatus: "pending",
    qc: null,
  };
  await saveGeneration(record);
  if (record.episodeId) await linkGenerationToEpisode(record.episodeId, record.shotId, record.id);
  return record;
}

type RawOperation = {
  done?: boolean;
  error?: { message?: string; code?: number; status?: string };
  response?: {
    generateVideoResponse?: {
      generatedSamples?: Array<{ video?: { uri?: string; mimeType?: string } }>;
      raiMediaFilteredReasons?: string[];
    };
  };
};

export async function refreshVeoGeneration(record: ShotGenerationRecord) {
  if (record.status !== "generating") return record;
  const key = apiKey();
  const statusResponse = await fetch(`https://generativelanguage.googleapis.com/v1beta/${record.operationName}`, {
    headers: { "x-goog-api-key": key },
    cache: "no-store",
  });
  if (!statusResponse.ok) throw new Error(`Veo operation polling failed with ${statusResponse.status}`);
  const operation = (await statusResponse.json()) as RawOperation;
  if (!operation.done) return record;

  if (operation.error) {
    const failed = { ...record, status: "failed" as const, error: operation.error.message || "Veo generation failed", updatedAt: new Date().toISOString() };
    await saveGeneration(failed);
    return failed;
  }

  const videoUri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri;
  if (!videoUri) {
    const reason = operation.response?.generateVideoResponse?.raiMediaFilteredReasons?.join(", ");
    const failed = { ...record, status: "failed" as const, error: reason || "Veo returned no generated video", updatedAt: new Date().toISOString() };
    await saveGeneration(failed);
    return failed;
  }

  const videoResponse = await fetch(videoUri, { headers: { "x-goog-api-key": key }, redirect: "follow" });
  if (!videoResponse.ok) throw new Error(`Veo video download failed with ${videoResponse.status}`);
  const videoBytes = await videoResponse.arrayBuffer();
  const pathname = generationVideoPath(record.id);
  await put(pathname, videoBytes, {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: videoResponse.headers.get("content-type") || "video/mp4",
    cacheControlMaxAge: 3600,
  });
  const ready = { ...record, status: "ready" as const, videoPathname: pathname, updatedAt: new Date().toISOString() };
  await saveGeneration(ready);
  return ready;
}
