import "server-only";

import OpenAI from "openai";

export type QwenVisionContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" };

function qwenConfig() {
  const baseURL = process.env.QWEN_API_BASE?.trim() || "https://b200-llm-node.technode.network/v1";
  const apiKey = process.env.QWEN_API_KEY?.trim();
  if (!apiKey) throw new Error("QWEN_API_KEY is not configured");
  return {
    baseURL,
    apiKey,
    model: process.env.QWEN_VISION_MODEL?.trim() || "x",
  };
}

function outputText(value: string | null) {
  const text = (value || "").trim();
  const closingThink = text.lastIndexOf("</think>");
  return (closingThink >= 0 ? text.slice(closingThink + 8) : text).trim();
}

export async function qwenVisionJson(input: {
  instructions: string;
  content: QwenVisionContent[];
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}) {
  const config = qwenConfig();
  // Video/image jobs temporarily release the resident Qwen server. Fail fast
  // enough for the caller to use its OpenAI fallback instead of blocking the UI.
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 90_000, maxRetries: 0 });
  const response = await client.chat.completions.create({
    model: config.model,
    messages: [
      { role: "system", content: input.instructions },
      {
        role: "user",
        content: input.content.map((part) => part.type === "input_text"
          ? { type: "text" as const, text: part.text }
          : { type: "image_url" as const, image_url: { url: part.image_url, detail: part.detail || "auto" } }),
      },
    ],
    max_completion_tokens: input.maxOutputTokens,
    temperature: 0,
    response_format: {
      type: "json_schema",
      json_schema: {
        name: input.schemaName,
        strict: true,
        schema: input.schema,
      },
    },
  });
  const text = outputText(response.choices[0]?.message.content || "");
  if (!text) throw new Error(`Qwen response ${response.id} did not contain JSON output`);
  return { outputText: text, responseId: response.id, model: config.model };
}

export function qwenProviderEnabled(scope: "director" | "qc") {
  const name = scope === "director" ? "DIRECTOR_AI_PROVIDER" : "QC_AI_PROVIDER";
  return process.env[name]?.trim().toLowerCase() === "qwen";
}
