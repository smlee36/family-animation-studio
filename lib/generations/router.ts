import "server-only";

import type { DirectorShot, ShotMotionProfile } from "@/lib/director/types";
import type {
  ActualVideoGenerationProvider,
  VideoGenerationProvider,
  VideoRoutingDecision,
} from "@/lib/generations/types";

const ACTION_PATTERN = {
  walk: /(walk|run|step|crawl|걷|뛰|달리|기어가|이동)/i,
  contact: /(hand|hold|hug|embrace|touch|kiss|안아|잡아|손을|뽀뽀|기대)/i,
  transfer: /(hand over|give|receive|pass|건네|받아|전달)/i,
  pose: /(stand|sit up|lie down|get down|climb|kneel|일어나|앉아|눕|내려오|올라가|무릎)/i,
  location: /(bedroom.*living|living.*bedroom|침실.*거실|거실.*침실|방에서.*나가|문을.*통과)/i,
};

export type RoutingShot = Pick<DirectorShot, "action" | "prompt" | "startState" | "endState"> & {
  motionProfile?: ShotMotionProfile;
};

function inferredProfile(shot: RoutingShot): ShotMotionProfile {
  const text = [shot.action, shot.prompt, shot.startState, shot.endState].join(" ");
  const hasWalkingOrRunning = ACTION_PATTERN.walk.test(text);
  const hasObjectTransfer = ACTION_PATTERN.transfer.test(text);
  const hasLargePoseChange = ACTION_PATTERN.pose.test(text);
  const hasPhysicalContact = ACTION_PATTERN.contact.test(text) || hasObjectTransfer;
  const changesLocation = ACTION_PATTERN.location.test(text);
  const bodyMotion = hasWalkingOrRunning || hasLargePoseChange ? "large" : hasPhysicalContact ? "medium" : "small";
  return {
    bodyMotion,
    characterCount: 1,
    hasPhysicalContact,
    hasObjectTransfer,
    hasWalkingOrRunning,
    hasLargePoseChange,
    changesLocation,
    requiresEndFrame: hasWalkingOrRunning || hasLargePoseChange || changesLocation,
  };
}

function score(profile: ShotMotionProfile) {
  let value = profile.bodyMotion === "large" ? 3 : profile.bodyMotion === "medium" ? 1 : 0;
  if (profile.hasWalkingOrRunning) value += 3;
  if (profile.hasObjectTransfer) value += 3;
  if (profile.hasLargePoseChange) value += 3;
  if (profile.hasPhysicalContact && profile.characterCount >= 2) value += 2;
  if (profile.characterCount >= 3) value += 1;
  if (profile.requiresEndFrame) value += 1;
  if (profile.changesLocation) value += 4;
  return Math.min(10, value);
}

function wanConfigured() {
  return Boolean(
    process.env.WAN_API_BASE?.trim()
      && (process.env.WAN_API_KEY?.trim() || process.env.LTX_API_KEY?.trim()),
  );
}

function routerEnabled() {
  return process.env.HYBRID_VIDEO_ROUTER_ENABLED?.trim().toLowerCase() === "true";
}

export function selectVideoProvider(input: {
  requestedProvider?: VideoGenerationProvider;
  shot?: RoutingShot;
  previousProvider?: ActualVideoGenerationProvider;
  retryReason?: string;
  qcFallbackProvider?: ActualVideoGenerationProvider;
}): VideoRoutingDecision {
  const requested = input.requestedProvider || "auto";
  const profile = input.shot?.motionProfile || (input.shot ? inferredProfile(input.shot) : inferredProfile({
    action: "",
    prompt: "",
    startState: "",
    endState: "",
  }));
  const difficultyScore = score(profile);
  const recommendWan = difficultyScore >= 5 && !profile.changesLocation;
  const recommendedProvider: ActualVideoGenerationProvider = recommendWan ? "wan" : "ltx";
  const reasons = [
    profile.changesLocation ? "장소 변경은 별도 Shot 분리가 필요합니다." : "",
    profile.hasWalkingOrRunning ? "걷기·달리기 전신 동작" : "",
    profile.hasObjectTransfer ? "물건 전달과 양손 접촉" : "",
    profile.hasLargePoseChange ? "큰 자세 변화" : "",
    profile.hasPhysicalContact && profile.characterCount >= 2 ? "여러 인물의 신체 접촉" : "",
    input.retryReason || "",
  ].filter(Boolean);
  const reason = reasons.join(" · ") || "한 인물의 작은 움직임과 안정된 구도";

  if (input.qcFallbackProvider) {
    const selectedProvider = input.qcFallbackProvider === "wan" && (!routerEnabled() || !wanConfigured())
      ? "ltx"
      : input.qcFallbackProvider;
    return {
      mode: "qc_fallback",
      requestedProvider: requested,
      recommendedProvider: input.qcFallbackProvider,
      selectedProvider,
      reason: selectedProvider === input.qcFallbackProvider
        ? `${reason} · QC 결과에 따라 생성 엔진을 전환합니다.`
        : `${reason} · Wan 연결 전이라 LTX 보정 생성으로 진행합니다.`,
      difficultyScore,
      requiresSplit: profile.changesLocation,
      fallbackChain: input.qcFallbackProvider === "wan" ? ["wan", "ltx", "google"] : [input.qcFallbackProvider, "ltx", "google"],
    };
  }

  if (requested !== "auto") {
    return {
      mode: "manual",
      requestedProvider: requested,
      recommendedProvider,
      selectedProvider: requested,
      reason,
      difficultyScore,
      requiresSplit: profile.changesLocation,
      fallbackChain: requested === "wan" ? ["wan", "ltx", "google"] : requested === "ltx" ? ["ltx", "wan", "google"] : ["google", "ltx", "wan"],
    };
  }

  const selectedProvider: ActualVideoGenerationProvider = routerEnabled() && recommendedProvider === "wan" && wanConfigured()
    ? "wan"
    : "ltx";
  return {
    mode: routerEnabled() ? "auto" : "shadow",
    requestedProvider: "auto",
    recommendedProvider,
    selectedProvider,
    reason: selectedProvider !== recommendedProvider
      ? `${reason} · Shadow Mode 또는 Wan 연결 전이라 LTX로 생성합니다.`
      : reason,
    difficultyScore,
    requiresSplit: profile.changesLocation,
    fallbackChain: recommendedProvider === "wan" ? ["wan", "ltx", "google"] : ["ltx", "wan", "google"],
  };
}
