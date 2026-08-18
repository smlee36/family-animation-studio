import "server-only";

import type { VideoAspectRatio } from "@/lib/generations/types";

type QwenImageReference = {
  id: string;
  data: string;
  mimeType: string;
};

type QwenImageJob = {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  stage?: string;
  error?: string;
  model?: string;
};

function config() {
  const base = process.env.QWEN_IMAGE_API_BASE?.trim();
  const token = process.env.QWEN_IMAGE_API_KEY?.trim() || process.env.LTX_API_KEY?.trim();
  if (!base || !token) throw new Error("QWEN_IMAGE_API_BASE or QWEN_IMAGE_API_KEY is not configured");
  return { base: base.replace(/\/$/, ""), token };
}

async function workerFetch(path: string, init?: RequestInit) {
  const { base, token } = config();
  return fetch(`${base}${path}`, {
    ...init,
    cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, ...(init?.headers || {}) },
    signal: AbortSignal.timeout(285_000),
  });
}

export function qwenImageConfigured() {
  return Boolean(process.env.QWEN_IMAGE_API_BASE?.trim() && (process.env.QWEN_IMAGE_API_KEY?.trim() || process.env.LTX_API_KEY?.trim()));
}

export async function getQwenImageServiceStatus() {
  if (!qwenImageConfigured()) return { reachable: false, modelReady: false, model: "", queueDepth: 0 };
  try {
    const response = await workerFetch("/health");
    if (!response.ok) return { reachable: false, modelReady: false, model: "", queueDepth: 0 };
    const body = await response.json() as { ok?: boolean; model_ready?: boolean; model?: string; queue_depth?: number };
    return { reachable: body.ok === true, modelReady: body.model_ready === true, model: body.model || "", queueDepth: body.queue_depth || 0 };
  } catch {
    return { reachable: false, modelReady: false, model: "", queueDepth: 0 };
  }
}

export async function generateQwenSceneFrame(input: {
  id: string;
  prompt: string;
  aspectRatio: VideoAspectRatio;
  references: QwenImageReference[];
}) {
  if (!input.references.length) throw new Error("Qwen Image Edit requires at least one Master Reference");
  const form = new FormData();
  form.set("image_id", input.id);
  form.set("prompt", input.prompt);
  form.set("aspect_ratio", input.aspectRatio);
  form.set("seed", "42");
  for (const reference of input.references.slice(0, 6)) {
    form.append("reference_images", new Blob([Buffer.from(reference.data, "base64")], { type: reference.mimeType }), `${reference.id}.image`);
  }
  const started = await workerFetch("/jobs", { method: "POST", body: form });
  if (!started.ok) throw new Error(`Qwen Image worker rejected the job (${started.status}): ${(await started.text()).slice(0, 500)}`);
  let job = await started.json() as QwenImageJob;
  const deadline = Date.now() + 270_000;
  while (job.status === "queued" || job.status === "running") {
    if (Date.now() >= deadline) throw new Error(`Qwen Image job ${input.id} is still running (${job.stage || job.status})`);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const response = await workerFetch(`/jobs/${input.id}`);
    if (!response.ok) throw new Error(`Qwen Image status failed (${response.status})`);
    job = await response.json() as QwenImageJob;
  }
  if (job.status !== "succeeded") throw new Error(job.error || "Qwen Image generation failed");
  const image = await workerFetch(`/jobs/${input.id}/image`);
  if (!image.ok) throw new Error(`Qwen Image download failed (${image.status})`);
  const bytes = Buffer.from(await image.arrayBuffer());
  if (!bytes.length) throw new Error("Qwen Image worker returned an empty image");
  return { bytes, mimeType: image.headers.get("content-type") || "image/jpeg", model: job.model || "Qwen-Image-Edit-2511" };
}
