export type RequiredServerEnv =
  | "FAMILY_STUDIO_PASSCODE"
  | "OPENAI_API_KEY"
  | "GEMINI_API_KEY";

export type EnvironmentStatus = {
  readyForPhaseOne: boolean;
  configured: Record<RequiredServerEnv | "BLOB_STORAGE" | "LTX_VIDEO" | "WAN_VIDEO" | "QWEN_VISION" | "QWEN_IMAGE", boolean>;
  defaultVideoProvider: "auto" | "ltx" | "wan" | "google";
};

export function getEnvironmentStatus(): EnvironmentStatus {
  const configured = {
    FAMILY_STUDIO_PASSCODE: Boolean(process.env.FAMILY_STUDIO_PASSCODE?.trim()),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY?.trim()),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY?.trim()),
    // Marketplace Blob projects can authenticate through Vercel-managed
    // credentials that are not exposed as a readable runtime env value.
    BLOB_STORAGE: Boolean(process.env.BLOB_STORE_ID?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim()),
    LTX_VIDEO: Boolean(process.env.LTX_API_BASE?.trim() && process.env.LTX_API_KEY?.trim()),
    WAN_VIDEO: Boolean(
      process.env.WAN_API_BASE?.trim()
        && (process.env.WAN_API_KEY?.trim() || process.env.LTX_API_KEY?.trim()),
    ),
    QWEN_VISION: Boolean(process.env.QWEN_API_BASE?.trim() && process.env.QWEN_API_KEY?.trim()),
    QWEN_IMAGE: Boolean(process.env.QWEN_IMAGE_API_BASE?.trim() && (process.env.QWEN_IMAGE_API_KEY?.trim() || process.env.LTX_API_KEY?.trim())),
  };

  return {
    readyForPhaseOne: configured.FAMILY_STUDIO_PASSCODE,
    configured,
    defaultVideoProvider: configured.LTX_VIDEO
      ? (process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase() === "ltx" ? "ltx" : process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase() === "wan" ? "wan" : "auto")
      : "google",
  };
}

export function assertPasscodeConfigured(): string {
  const passcode = process.env.FAMILY_STUDIO_PASSCODE?.trim();
  if (!passcode) throw new Error("FAMILY_STUDIO_PASSCODE is not configured");
  return passcode;
}
