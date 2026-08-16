export type RequiredServerEnv =
  | "FAMILY_STUDIO_PASSCODE"
  | "OPENAI_API_KEY"
  | "GEMINI_API_KEY";

export type EnvironmentStatus = {
  readyForPhaseOne: boolean;
  configured: Record<RequiredServerEnv | "BLOB_STORAGE" | "LTX_VIDEO", boolean>;
  defaultVideoProvider: "ltx" | "google";
};

export function getEnvironmentStatus(): EnvironmentStatus {
  const configured = {
    FAMILY_STUDIO_PASSCODE: Boolean(process.env.FAMILY_STUDIO_PASSCODE?.trim()),
    OPENAI_API_KEY: Boolean(process.env.OPENAI_API_KEY?.trim()),
    GEMINI_API_KEY: Boolean(process.env.GEMINI_API_KEY?.trim()),
    BLOB_STORAGE: Boolean(
      process.env.BLOB_STORE_ID?.trim() &&
        (process.env.VERCEL_OIDC_TOKEN?.trim() || process.env.BLOB_READ_WRITE_TOKEN?.trim()),
    ),
    LTX_VIDEO: Boolean(process.env.LTX_API_BASE?.trim() && process.env.LTX_API_KEY?.trim()),
  };

  return {
    readyForPhaseOne: configured.FAMILY_STUDIO_PASSCODE,
    configured,
    defaultVideoProvider: process.env.VIDEO_GENERATION_PROVIDER?.trim().toLowerCase() === "google" || !configured.LTX_VIDEO ? "google" : "ltx",
  };
}

export function assertPasscodeConfigured(): string {
  const passcode = process.env.FAMILY_STUDIO_PASSCODE?.trim();
  if (!passcode) throw new Error("FAMILY_STUDIO_PASSCODE is not configured");
  return passcode;
}
