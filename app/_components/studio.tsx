"use client";

import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { PhotoVideoForm } from "@/app/_components/photo-video-form";
import type { DirectorPlan, DirectorReference } from "@/lib/director/types";
import type { EpisodeFormat, EpisodeStudioState, FinalVideoRecord, SceneFrameRecord } from "@/lib/episodes/types";
import type { LtxPreset, LtxRenderMode, ShotGenerationView, VideoGenerationProvider } from "@/lib/generations/types";
import type { StoryInputView } from "@/lib/story-inputs/types";

const DRAFT_KEY = "family-studio-story-draft";
const QC_FRAME_COUNT = 5;
const MAX_STORYBOARD_IMAGES = 3;
const MAX_STORYBOARD_BYTES = 20 * 1024 * 1024;
const STORYBOARD_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PendingStoryboard = { key: string; file: File; previewUrl: string };

type DirectorApiResponse = {
  episodeId?: string;
  plan?: DirectorPlan;
  references?: DirectorReference[];
  error?: string;
  requestId?: string;
};

type GenerationApiResponse = {
  generation?: ShotGenerationView;
  autoRegeneration?: ShotGenerationView | null;
  autoRegenerationError?: string;
  error?: string;
  requestId?: string;
};

type SceneFrameApiResponse = {
  frame?: SceneFrameRecord;
  error?: string;
  requestId?: string;
};

type FinalVideoApiResponse = {
  finalVideo?: FinalVideoRecord | null;
  error?: string;
  requestId?: string;
};

type LtxBatchModeView = {
  enabled: boolean;
  state: "off" | "starting" | "ready" | "restoring" | "error";
  residentReady: boolean;
  axRunning: boolean;
  idleRestoreSeconds: number;
  message: string;
};

function imageExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

function apiError(body: GenerationApiResponse, fallback: string) {
  return `${body.error || fallback}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`;
}

function waitForMediaEvent(media: HTMLMediaElement, eventName: "loadedmetadata" | "loadeddata" | "seeked", timeoutMs = 30_000) {
  return new Promise<void>((resolve, reject) => {
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("영상 프레임 준비 시간이 초과되었습니다."));
    }, timeoutMs);
    const onEvent = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("영상 프레임을 불러오지 못했습니다."));
    };
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      media.removeEventListener(eventName, onEvent);
      media.removeEventListener("error", onError);
    };
    media.addEventListener(eventName, onEvent, { once: true });
    media.addEventListener("error", onError, { once: true });
  });
}

function seekVideoFrame(video: HTMLVideoElement, targetTime: number, timeoutMs = 20_000) {
  return new Promise<void>((resolve, reject) => {
    let intervalId = 0;
    const timeoutId = window.setTimeout(() => {
      cleanup();
      reject(new Error("iPhone에서 영상 프레임 위치를 준비하는 시간이 초과되었습니다. 검수 다시 시도를 눌러주세요."));
    }, timeoutMs);
    const isReady = () => video.readyState >= 2 && !video.seeking && Math.abs(video.currentTime - targetTime) < 0.2;
    const check = () => {
      if (!isReady()) return;
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("영상 검수용 화면을 불러오지 못했습니다."));
    };
    const cleanup = () => {
      window.clearTimeout(timeoutId);
      window.clearInterval(intervalId);
      video.removeEventListener("seeked", check);
      video.removeEventListener("timeupdate", check);
      video.removeEventListener("loadeddata", check);
      video.removeEventListener("error", onError);
    };
    video.addEventListener("seeked", check);
    video.addEventListener("timeupdate", check);
    video.addEventListener("loadeddata", check);
    video.addEventListener("error", onError, { once: true });
    intervalId = window.setInterval(check, 100);
    video.currentTime = targetTime;
    check();
  });
}

async function captureVideoFramesAtRatios(videoUrl: string, ratios: number[]) {
  let localVideoUrl = "";
  let videoSource = videoUrl;
  try {
    const response = await fetch(videoUrl, { cache: "no-store", credentials: "same-origin" });
    if (!response.ok) throw new Error(`video fetch returned ${response.status}`);
    const videoBlob = await response.blob();
    if (!videoBlob.size) throw new Error("video fetch returned an empty file");
    localVideoUrl = URL.createObjectURL(videoBlob);
    videoSource = localVideoUrl;
  } catch (error) {
    // Mobile Safari can reject a full fetch of a range-streamed MP4 with the
    // opaque message "Load failed" even though its native media loader can
    // play and seek the exact same authenticated, same-origin URL.
    console.warn("[qc.frames] Blob preload failed; using native media loading.", error);
  }
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  video.style.position = "fixed";
  video.style.width = "1px";
  video.style.height = "1px";
  video.style.opacity = "0";
  video.style.pointerEvents = "none";
  document.body.appendChild(video);
  video.src = videoSource;
  video.load();
  try {
    if (video.readyState < 1) await waitForMediaEvent(video, "loadedmetadata");
    if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("영상 길이를 확인하지 못했습니다.");
    if (video.readyState < 2) {
      await waitForMediaEvent(video, "loadeddata", 45_000);
    }

    const scale = Math.min(1, 640 / Math.max(1, video.videoWidth));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("영상 검수 화면을 준비하지 못했습니다.");

    const frames: string[] = [];
    for (const ratio of ratios) {
      const targetTime = Math.min(Math.max(0.05, video.duration * ratio), Math.max(0.05, video.duration - 0.08));
      if (Math.abs(video.currentTime - targetTime) > 0.01) {
        await seekVideoFrame(video, targetTime);
      }
      if (video.readyState < 2) await waitForMediaEvent(video, "loadeddata");
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      frames.push(canvas.toDataURL("image/jpeg", 0.72));
    }
    return frames;
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (/load failed|failed to fetch|network request failed/i.test(message)) {
      throw new Error("iPhone에서 검수용 영상을 불러오지 못했습니다. 영상을 재생한 뒤 검수 다시 시도를 눌러주세요.");
    }
    throw error;
  } finally {
    video.pause();
    video.removeAttribute("src");
    video.load();
    video.remove();
    if (localVideoUrl) URL.revokeObjectURL(localVideoUrl);
  }
}

async function captureVideoFrames(videoUrl: string) {
  const frameCount = /iPhone|iPad|iPod/i.test(navigator.userAgent) ? 3 : QC_FRAME_COUNT;
  const ratios = Array.from({ length: frameCount }, (_, index) => index === 0 ? 0.02 : 0.9 * index / (frameCount - 1));
  return captureVideoFramesAtRatios(videoUrl, ratios);
}

async function captureFinalVideoFrame(videoUrl: string) {
  const [frame] = await captureVideoFramesAtRatios(videoUrl, [1]);
  if (!frame) throw new Error("이전 Shot의 마지막 화면을 준비하지 못했습니다.");
  return frame;
}

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `약 ${seconds}초`;
  return `약 ${minutes}분${seconds ? ` ${seconds}초` : ""}`;
}

function formatRemainingTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.ceil(totalSeconds));
  if (seconds <= 30) return "약 30초 이내";
  if (seconds < 60) return "약 1분 이내";
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `약 ${minutes}분`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `약 ${hours}시간${remainingMinutes ? ` ${remainingMinutes}분` : ""}`;
}

function ltxProgressStage(generation: ShotGenerationView) {
  const status = generation.backendStatus;
  if (/저장/.test(status)) return 2;
  if (/실행|생성 중/.test(status) && !/대기|등록|연결|준비/.test(status)) return 1;
  return 0;
}

function ltxRemainingSeconds(generation: ShotGenerationView, nowMs: number) {
  const measuredAt = Date.parse(generation.updatedAt);
  const elapsedSincePoll = nowMs && Number.isFinite(measuredAt) ? Math.max(0, (nowMs - measuredAt) / 1000) : 0;
  if (generation.estimatedSecondsRemaining > 0) {
    return Math.max(0, generation.estimatedSecondsRemaining - elapsedSincePoll);
  }
  const stage = ltxProgressStage(generation);
  if (stage === 2) return 15;
  const presetMultiplier = generation.ltxPreset === "gentle" ? 1 : 1.2;
  const baseSeconds = generation.ltxRenderMode === "preview"
    ? generation.durationSeconds >= 10
      ? (generation.ltxPreset === "gentle" ? 240 : 300)
      : (generation.ltxPreset === "gentle" ? 120 : 150)
    : ({ 4: 360, 5: 360, 6: 450, 8: 570, 10: 720 } as const)[generation.durationSeconds] * presetMultiplier;
  if (stage === 0) return baseSeconds * (generation.backendQueuePosition + 1);
  const startedAt = Date.parse(generation.backendStartedAt);
  const elapsed = nowMs && Number.isFinite(startedAt) ? Math.max(0, (nowMs - startedAt) / 1000) : 0;
  return Math.max(30, baseSeconds - elapsed);
}

function LtxGenerationProgress({ generation, nowMs }: { generation: ShotGenerationView; nowMs: number }) {
  const stage = ltxProgressStage(generation);
  const queueCopy = generation.backendQueuePosition > 0 ? ` · 앞에 ${generation.backendQueuePosition}개` : "";
  const labels = ["대기 중", "LTX 실행 중", "저장 중"];
  return (
    <section className="ltx-generation-progress" aria-label="LTX 영상 생성 진행 상황" aria-live="polite">
      <div className="ltx-progress-summary">
        <strong>{labels[stage]}{stage === 0 ? queueCopy : ""}</strong>
        <span>예상 남은 시간 {formatRemainingTime(ltxRemainingSeconds(generation, nowMs))}</span>
      </div>
      <ol>
        {labels.map((label, index) => (
          <li className={index < stage ? "done" : index === stage ? "active" : ""} key={label}>
            <span aria-hidden="true">{index < stage ? "✓" : index + 1}</span>
            <small>{label}</small>
          </li>
        ))}
      </ol>
      <p>{generation.backendStatus || "B200 작업 상태를 확인하고 있어요."}</p>
    </section>
  );
}

function ltxPresetForShot(shot: DirectorPlan["scenes"][number]["shots"][number]): LtxPreset {
  const text = `${shot.title} ${shot.action} ${shot.prompt}`;
  if (/camera|dolly|pan|zoom|tracking|카메라|줌|패닝|이동 촬영/i.test(text)) return "camera";
  if (/run|walk|jump|carry|hand over|stand up|sit down|달리|걷|뛰|점프|이동|건네|일어나|앉아/i.test(text)) return "action";
  return "gentle";
}

function newLtxDuration(seconds: number): 5 | 10 {
  return seconds < 8 ? 5 : 10;
}

export function Studio({
  environmentReady,
  initialEpisode = null,
  focusShot = "",
}: {
  environmentReady: boolean;
  initialEpisode?: EpisodeStudioState | null;
  focusShot?: string;
}) {
  const router = useRouter();
  const [episodeId, setEpisodeId] = useState(initialEpisode?.episode.id || "");
  const [format, setFormat] = useState<EpisodeFormat>(initialEpisode?.episode.format || "reels");
  const [story, setStory] = useState(initialEpisode?.episode.story || "");
  const [plan, setPlan] = useState<DirectorPlan | null>(initialEpisode?.episode.plan || null);
  const [references, setReferences] = useState<DirectorReference[]>(initialEpisode?.references || []);
  const [storyboardInputs, setStoryboardInputs] = useState<StoryInputView[]>(initialEpisode?.storyboardInputs || []);
  const [pendingStoryboards, setPendingStoryboards] = useState<PendingStoryboard[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialEpisode?.episode.error || "");
  const [generations, setGenerations] = useState<Record<string, ShotGenerationView>>(initialEpisode?.generations || {});
  const [generationVersions, setGenerationVersions] = useState<Record<string, ShotGenerationView[]>>(initialEpisode?.generationVersions || {});
  const [videoProvider, setVideoProvider] = useState<VideoGenerationProvider>("ltx");
  const [sceneFrames, setSceneFrames] = useState<Record<string, SceneFrameRecord>>(initialEpisode?.episode.sceneFrames || {});
  const [sceneFrameInstructions, setSceneFrameInstructions] = useState<Record<string, string>>({});
  const [sceneFrameMessages, setSceneFrameMessages] = useState<Record<string, string>>({});
  const [pendingSceneFrames, setPendingSceneFrames] = useState<Set<string>>(new Set());
  const [allSceneFramesPending, setAllSceneFramesPending] = useState(false);
  const [qcPendingShots, setQcPendingShots] = useState<Set<string>>(new Set());
  const [qcMessages, setQcMessages] = useState<Record<string, string>>({});
  const [revisionText, setRevisionText] = useState<Record<string, string>>({});
  const [revisionPendingShots, setRevisionPendingShots] = useState<Set<string>>(new Set());
  const [referenceEditorShotId, setReferenceEditorShotId] = useState("");
  const [referenceDrafts, setReferenceDrafts] = useState<Record<string, string[]>>({});
  const [referenceSavingShotIds, setReferenceSavingShotIds] = useState<Set<string>>(new Set());
  const [progressNowMs, setProgressNowMs] = useState(0);
  const [ltxBatchMode, setLtxBatchMode] = useState<LtxBatchModeView | null>(null);
  const [ltxBatchPending, setLtxBatchPending] = useState(false);
  const [ltxBatchMessage, setLtxBatchMessage] = useState("");
  const [bulkGenerationPending, setBulkGenerationPending] = useState(false);
  const [bulkGenerationProgress, setBulkGenerationProgress] = useState({ completed: 0, total: 0, message: "" });
  const bulkGenerationStopRef = useRef(false);
  const [finalVideo, setFinalVideo] = useState<FinalVideoRecord | null>(initialEpisode?.episode.finalVideo || null);
  const [finalVideoPending, setFinalVideoPending] = useState(false);
  const [finalVideoMessage, setFinalVideoMessage] = useState("");
  const [openScenes, setOpenScenes] = useState<Set<string>>(
    new Set((() => {
      const scenes = initialEpisode?.episode.plan?.scenes || [];
      const focusedScene = focusShot ? scenes.find((scene) => scene.shots.some((shot) => shot.id === focusShot)) : null;
      const initialScene = focusedScene || scenes[0];
      return initialScene ? [initialScene.id] : [];
    })()),
  );
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);
  const pendingStoryboardsRef = useRef(pendingStoryboards);
  const initialPendingGenerationsRef = useRef(
    Object.entries(initialEpisode?.generations || {}).filter(([, generation]) => generation.status === "generating"),
  );
  pendingStoryboardsRef.current = pendingStoryboards;

  const hasActiveLtxGeneration = Object.values(generations).some(
    (generation) => generation.provider === "ltx" && generation.status === "generating",
  );

  useEffect(() => {
    if (!hasActiveLtxGeneration) return;
    const interval = window.setInterval(() => setProgressNowMs(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [hasActiveLtxGeneration]);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/system/status", { cache: "no-store" })
      .then((response) => response.json())
      .then((body: { videoBackend?: { batchMode?: LtxBatchModeView | null } }) => {
        if (!cancelled) setLtxBatchMode(body.videoBackend?.batchMode || null);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ltxBatchMode?.enabled && ltxBatchMode?.state !== "restoring") return;
    const interval = window.setInterval(() => {
      void fetch("/api/system/status", { cache: "no-store" })
        .then((response) => response.json())
        .then((body: { videoBackend?: { batchMode?: LtxBatchModeView | null } }) => {
          setLtxBatchMode(body.videoBackend?.batchMode || null);
        })
        .catch(() => undefined);
    }, 30_000);
    return () => window.clearInterval(interval);
  }, [ltxBatchMode?.enabled, ltxBatchMode?.state]);

  useEffect(() => {
    if (!episodeId || finalVideo?.status !== "generating") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response = await fetch(`/api/episodes/${episodeId}/final-video`, { cache: "no-store" });
        const body = (await response.json()) as FinalVideoApiResponse;
        if (!response.ok) throw new Error(`${body.error || "최종 영상 상태를 확인하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
        if (!cancelled && body.finalVideo) {
          setFinalVideo(body.finalVideo);
          if (body.finalVideo.status === "ready") setFinalVideoMessage("최종 영상이 완성되었습니다.");
          if (body.finalVideo.status === "failed") setFinalVideoMessage(body.finalVideo.error || "최종 영상 병합에 실패했습니다.");
        }
      } catch (caught) {
        if (!cancelled) setFinalVideoMessage(caught instanceof Error ? caught.message : "최종 영상 상태를 확인하지 못했습니다.");
      }
    };
    void poll();
    const interval = window.setInterval(() => void poll(), 10_000);
    return () => { cancelled = true; window.clearInterval(interval); };
  }, [episodeId, finalVideo?.status]);

  useEffect(() => () => {
    pendingStoryboardsRef.current.forEach((input) => URL.revokeObjectURL(input.previewUrl));
  }, []);

  useEffect(() => {
    if (!focusShot || !plan) return;
    const frame = requestAnimationFrame(() => {
      document.getElementById(`shot-${focusShot}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusShot, plan]);

  useEffect(() => {
    if (!plan || initialPendingGenerationsRef.current.length === 0) return;
    const pendingGenerations = initialPendingGenerationsRef.current.splice(0);
    let cancelled = false;

    for (const [shotId, initialGeneration] of pendingGenerations) {
      void (async () => {
        let generation = initialGeneration;
        try {
          for (let attempt = 0; attempt < 90 && generation.status === "generating" && !cancelled; attempt += 1) {
            const response = await fetch(`/api/shots/generate/${generation.id}`, { cache: "no-store" });
            const body = (await response.json()) as GenerationApiResponse;
            if (!response.ok || !body.generation) {
              throw new Error(apiError(body, "영상 생성 상태를 다시 불러오지 못했습니다."));
            }
            generation = body.generation;
            if (!cancelled) setGenerations((current) => ({ ...current, [shotId]: generation }));
            if (generation.status === "generating") {
              await new Promise((resolve) => window.setTimeout(resolve, 10_000));
            }
          }
          if (!cancelled && generation.status === "ready") {
            setQcMessages((current) => ({ ...current, [shotId]: "영상 생성을 이어서 완료했어요. 검수 다시 시도를 눌러 확인할 수 있어요." }));
          }
        } catch (caught) {
          if (!cancelled) {
            setQcMessages((current) => ({
              ...current,
              [shotId]: caught instanceof Error ? caught.message : "영상 생성 상태를 다시 불러오지 못했습니다.",
            }));
          }
        }
      })();
    }

    return () => {
      cancelled = true;
    };
  }, [plan]);

  function selectStoryboardFiles(files: FileList | null) {
    if (!files) return;
    const available = Math.max(0, MAX_STORYBOARD_IMAGES - storyboardInputs.length - pendingStoryboards.length);
    const selected = Array.from(files).slice(0, available);
    const invalid = selected.find((file) => !STORYBOARD_TYPES.has(file.type) || file.size > MAX_STORYBOARD_BYTES);
    if (invalid) {
      setError("JPG, PNG, WebP 이미지만 장당 20MB까지 추가할 수 있어요.");
      return;
    }
    if (!available) {
      setError("스토리보드 이미지는 최대 3장까지 추가할 수 있어요.");
      return;
    }
    setPendingStoryboards((current) => [...current, ...selected.map((file) => ({ key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }))]);
    setError(Array.from(files).length > available ? "스토리보드 이미지는 최대 3장까지 추가됩니다." : "");
  }

  function removePendingStoryboard(key: string) {
    setPendingStoryboards((current) => current.filter((input) => {
      if (input.key === key) URL.revokeObjectURL(input.previewUrl);
      return input.key !== key;
    }));
  }

  async function uploadStoryboard(file: File) {
    const id = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const pathname = `story-inputs/images/${id}/${uploadId}.${imageExtension(file)}`;
    const blob = await uploadPresigned(pathname, file, {
      access: "private",
      handleUploadUrl: "/api/story-inputs/upload",
      clientPayload: JSON.stringify({ inputId: id }),
      multipart: file.size > 10 * 1024 * 1024,
    });
    const response = await fetch("/api/story-inputs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, kind: "storyboard", name: file.name || "스토리보드", imagePathname: blob.pathname, contentType: file.type, size: file.size }),
    });
    const body = (await response.json()) as { input?: StoryInputView; error?: string; requestId?: string };
    if (!response.ok || !body.input) throw new Error(`${body.error || "이미지를 저장하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
    return body.input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedStory = story.trim();
    const hasStoryboard = storyboardInputs.length + pendingStoryboards.length > 0;
    if ((trimmedStory.length < 10 && !hasStoryboard) || pending) {
      if (trimmedStory.length < 10 && !hasStoryboard) setError("이야기를 적거나 스토리보드 이미지를 추가해 주세요.");
      return;
    }

    setPending(true);
    setError("");
    setPlan(null);
    try {
      const uploadedInputs = [...storyboardInputs];
      for (const pendingInput of pendingStoryboards) uploadedInputs.push(await uploadStoryboard(pendingInput.file));
      setStoryboardInputs(uploadedInputs);
      pendingStoryboards.forEach((input) => URL.revokeObjectURL(input.previewUrl));
      setPendingStoryboards([]);
      const response = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story: trimmedStory, storyboardInputIds: uploadedInputs.map((input) => input.id), format }),
      });
      const body = (await response.json()) as DirectorApiResponse;
      if (!response.ok || !body.plan) {
        const suffix = body.requestId ? ` (문의 번호: ${body.requestId})` : "";
        throw new Error(`${body.error || "이야기를 구성하지 못했습니다."}${suffix}`);
      }
      setPlan(body.plan);
      setReferences(body.references || []);
      setEpisodeId(body.episodeId || "");
      setSceneFrames({});
      setOpenScenes(new Set(body.plan.scenes[0] ? [body.plan.scenes[0].id] : []));
      sessionStorage.removeItem(DRAFT_KEY);
      if (body.episodeId) router.replace(`/studio?episode=${body.episodeId}`, { scroll: false });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "이야기를 구성하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  async function generateSceneFrame(sceneId: string) {
    if (!episodeId || pendingSceneFrames.has(sceneId)) return null;
    setPendingSceneFrames((current) => new Set(current).add(sceneId));
    setSceneFrameMessages((current) => ({ ...current, [sceneId]: "" }));
    try {
      const response = await fetch(`/api/episodes/${episodeId}/scenes/${sceneId}/frame`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: sceneFrameInstructions[sceneId] || "" }),
      });
      const body = (await response.json()) as SceneFrameApiResponse;
      if (!response.ok || !body.frame) {
        throw new Error(`${body.error || "Scene 이미지를 만들지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
      }
      setSceneFrames((current) => ({ ...current, [sceneId]: body.frame as SceneFrameRecord }));
      setSceneFrameInstructions((current) => ({ ...current, [sceneId]: "" }));
      return body.frame;
    } catch (caught) {
      setSceneFrameMessages((current) => ({ ...current, [sceneId]: caught instanceof Error ? caught.message : "Scene 이미지 생성 중 문제가 생겼습니다." }));
      return null;
    } finally {
      setPendingSceneFrames((current) => {
        const next = new Set(current);
        next.delete(sceneId);
        return next;
      });
    }
  }

  async function generateMissingSceneFrames() {
    if (!plan || allSceneFramesPending) return;
    setAllSceneFramesPending(true);
    try {
      for (const scene of plan.scenes) {
        if (!sceneFrames[scene.id]) await generateSceneFrame(scene.id);
      }
    } finally {
      setAllSceneFramesPending(false);
    }
  }

  async function approveSceneFrame(sceneId: string, approved: boolean) {
    if (!episodeId || pendingSceneFrames.has(sceneId)) return;
    setPendingSceneFrames((current) => new Set(current).add(sceneId));
    setSceneFrameMessages((current) => ({ ...current, [sceneId]: "" }));
    try {
      const response = await fetch(`/api/episodes/${episodeId}/scenes/${sceneId}/frame`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      const body = (await response.json()) as SceneFrameApiResponse;
      if (!response.ok || !body.frame) throw new Error(`${body.error || "Scene 이미지 승인을 저장하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
      setSceneFrames((current) => ({ ...current, [sceneId]: body.frame as SceneFrameRecord }));
    } catch (caught) {
      setSceneFrameMessages((current) => ({ ...current, [sceneId]: caught instanceof Error ? caught.message : "Scene 이미지 승인 중 문제가 생겼습니다." }));
    } finally {
      setPendingSceneFrames((current) => {
        const next = new Set(current);
        next.delete(sceneId);
        return next;
      });
    }
  }

  function updatePrompt(sceneId: string, shotId: string, prompt: string) {
    setPlan((current) => current && ({
      ...current,
      scenes: current.scenes.map((scene) => scene.id !== sceneId ? scene : {
        ...scene,
        shots: scene.shots.map((shot) => shot.id === shotId ? { ...shot, prompt } : shot),
      }),
    }));
  }

  async function saveCurrentPlan(planToSave = plan) {
    if (!episodeId || !planToSave) return false;
    try {
      const response = await fetch(`/api/episodes/${episodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planToSave }),
      });
      if (!response.ok) throw new Error("프롬프트 수정 내용을 저장하지 못했습니다.");
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "프롬프트 수정 내용을 저장하지 못했습니다.");
      return false;
    }
  }

  function openReferenceEditor(shotId: string, referenceIds: string[]) {
    setReferenceDrafts((current) => ({ ...current, [shotId]: [...referenceIds] }));
    setReferenceEditorShotId((current) => current === shotId ? "" : shotId);
  }

  function toggleShotReference(shotId: string, referenceId: string) {
    setReferenceDrafts((current) => {
      const selected = current[shotId] || [];
      if (selected.includes(referenceId)) return { ...current, [shotId]: selected.filter((id) => id !== referenceId) };
      if (selected.length >= 6) {
        setQcMessages((messages) => ({ ...messages, [shotId]: "고정 기준은 Shot당 최대 6장까지 선택할 수 있어요." }));
        return current;
      }
      setQcMessages((messages) => ({ ...messages, [shotId]: "" }));
      return { ...current, [shotId]: [...selected, referenceId] };
    });
  }

  async function saveShotReferences(sceneId: string, shotId: string) {
    if (!plan || referenceSavingShotIds.has(shotId)) return;
    const referenceIds = referenceDrafts[shotId] || [];
    const updatedPlan: DirectorPlan = {
      ...plan,
      scenes: plan.scenes.map((scene) => scene.id !== sceneId ? scene : {
        ...scene,
        shots: scene.shots.map((shot) => shot.id === shotId ? {
          ...shot,
          referenceIds,
          referenceReason: referenceIds.length ? "사용자가 선택한 고정 Visual Bible" : "직접 전달 이미지 없이 전체 Visual Bible의 분석 조건을 적용",
        } : shot),
      }),
    };
    setReferenceSavingShotIds((current) => new Set(current).add(shotId));
    setQcMessages((current) => ({ ...current, [shotId]: "" }));
    try {
      if (!(await saveCurrentPlan(updatedPlan))) return;
      setPlan(updatedPlan);
      setReferenceEditorShotId("");
    } finally {
      setReferenceSavingShotIds((current) => {
        const next = new Set(current);
        next.delete(shotId);
        return next;
      });
    }
  }

  async function pollGeneration(shotId: string, initialGeneration: ShotGenerationView) {
    let generation = initialGeneration;
    for (let attempt = 0; attempt < 90 && generation.status === "generating"; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 10_000));
      const pollResponse = await fetch(`/api/shots/generate/${generation.id}`, { cache: "no-store" });
      const pollBody = (await pollResponse.json()) as GenerationApiResponse;
      if (!pollResponse.ok || !pollBody.generation) {
        throw new Error(apiError(pollBody, "영상 생성 상태를 확인하지 못했습니다."));
      }
      generation = pollBody.generation;
      setGenerations((current) => ({ ...current, [shotId]: generation }));
    }
    if (generation.status === "generating") throw new Error("영상 생성이 오래 걸리고 있습니다. 잠시 후 다시 시도해 주세요.");
    return generation;
  }

  function rememberGenerationVersion(shotId: string, generation: ShotGenerationView | undefined) {
    if (!generation?.id || generation.status !== "ready") return;
    setGenerationVersions((current) => {
      const versions = current[shotId] || [];
      const next = versions.some((item) => item.id === generation.id)
        ? versions.map((item) => item.id === generation.id ? generation : item)
        : [...versions, generation];
      return { ...current, [shotId]: next };
    });
  }

  function previousShotInSameScene(shotId: string) {
    if (!plan) return null;
    for (const scene of plan.scenes) {
      const shotIndex = scene.shots.findIndex((item) => item.id === shotId);
      if (shotIndex > 0) return scene.shots[shotIndex - 1];
      if (shotIndex === 0) return null;
    }
    return null;
  }

  async function runQcCycle(shot: DirectorPlan["scenes"][number]["shots"][number], initialGeneration: ShotGenerationView) {
    let generation = initialGeneration;
    setQcPendingShots((current) => new Set(current).add(shot.id));
    setQcMessages((current) => ({ ...current, [shot.id]: "" }));
    try {
      while (generation.status === "ready") {
        const frames = await captureVideoFrames(generation.videoUrl);
        const response = await fetch(`/api/shots/generate/${generation.id}/qc`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            frames,
            shot: {
              title: shot.title,
              action: shot.action,
              prompt: shot.prompt,
              startState: shot.startState,
              endState: shot.endState,
            },
          }),
        });
        const body = (await response.json()) as GenerationApiResponse;
        if (!response.ok || !body.generation) throw new Error(apiError(body, "GPT 영상 검수를 완료하지 못했습니다."));
        generation = body.generation;
        setGenerations((current) => ({ ...current, [shot.id]: generation }));
        if (body.autoRegenerationError) {
          setQcMessages((current) => ({ ...current, [shot.id]: body.autoRegenerationError || "" }));
        }
        if (!body.autoRegeneration) break;
        rememberGenerationVersion(shot.id, body.generation);
        generation = body.autoRegeneration;
        setGenerations((current) => ({ ...current, [shot.id]: generation }));
        generation = await pollGeneration(shot.id, generation);
        if (generation.status !== "ready") break;
      }
    } catch (caught) {
      setQcMessages((current) => ({
        ...current,
        [shot.id]: caught instanceof Error ? caught.message : "GPT 영상 검수 중 문제가 생겼습니다.",
      }));
    } finally {
      setQcPendingShots((current) => {
        const next = new Set(current);
        next.delete(shot.id);
        return next;
      });
    }
  }

  async function generateShot(
    shot: DirectorPlan["scenes"][number]["shots"][number],
    ltxRenderMode: LtxRenderMode = "preview",
    generationSnapshot: Record<string, ShotGenerationView> = generations,
  ): Promise<ShotGenerationView | null> {
    const shotScene = plan?.scenes.find((scene) => scene.shots.some((item) => item.id === shot.id));
    if (!shotScene) return null;
    const currentGeneration = generationSnapshot[shot.id];
    const previousShot = previousShotInSameScene(shot.id);
    const previousGeneration = previousShot ? generationSnapshot[previousShot.id] : undefined;
    let continuityFrame = "";
    let continuitySourceGenerationId = "";
    if (previousShot) {
      if (!previousGeneration || previousGeneration.status !== "ready" || !previousGeneration.videoUrl) {
        setQcMessages((current) => ({ ...current, [shot.id]: `연속 생성을 위해 앞 Shot ${previousShot.id} 영상을 먼저 완성해 주세요.` }));
        return null;
      }
      setQcMessages((current) => ({ ...current, [shot.id]: `앞 Shot ${previousShot.id}의 마지막 프레임을 연결하고 있어요…` }));
      try {
        continuityFrame = await captureFinalVideoFrame(previousGeneration.videoUrl);
        continuitySourceGenerationId = previousGeneration.id;
      } catch (caught) {
        setQcMessages((current) => ({
          ...current,
          [shot.id]: caught instanceof Error ? caught.message : "이전 Shot의 마지막 프레임을 준비하지 못했습니다.",
        }));
        return null;
      }
    }
    rememberGenerationVersion(shot.id, generations[shot.id]);
    setGenerations((current) => ({
      ...current,
      [shot.id]: {
        id: "",
        episodeId,
        shotId: shot.id,
        model: "",
        provider: videoProvider,
        ltxPreset: ltxPresetForShot(shot),
        ltxRenderMode,
        backendStatus: videoProvider === "ltx" ? "B200 연결 중" : "Google 연결 중",
        backendQueuePosition: 0,
        backendStartedAt: "",
        estimatedSecondsRemaining: 0,
        prompt: shot.prompt,
        continuitySourceGenerationId,
        initialFrameKind: "",
        status: "generating",
        durationSeconds: 5,
        aspectRatio: format === "reels" ? "9:16" : "16:9",
        usedReferenceIds: [],
        omittedReferenceIds: [],
        error: "",
        createdAt: "",
        updatedAt: "",
        videoUrl: "",
        qualityTier: "fast",
        autoRegenerationCount: 0,
        parentGenerationId: "",
        approvalStatus: "pending",
        qc: null,
      },
    }));
    setQcMessages((current) => ({ ...current, [shot.id]: "" }));

    try {
      const startResponse = await fetch("/api/shots/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          episodeId,
          sceneId: shotScene.id,
          shotId: shot.id,
          prompt: shot.prompt,
          estimatedSeconds: newLtxDuration(shot.estimatedSeconds),
          referenceIds: shot.referenceIds,
          provider: videoProvider,
          ltxPreset: ltxPresetForShot(shot),
          ltxRenderMode,
          continuityFrame,
          continuitySourceGenerationId,
          sceneMasterGenerationId: currentGeneration?.initialFrameKind === "scene_master" ? currentGeneration.id : "",
        }),
      });
      const startBody = (await startResponse.json()) as GenerationApiResponse;
      if (!startResponse.ok || !startBody.generation) {
        throw new Error(apiError(startBody, "영상 생성을 시작하지 못했습니다."));
      }

      let generation = startBody.generation;
      setGenerations((current) => ({ ...current, [shot.id]: generation }));
      generation = await pollGeneration(shot.id, generation);
      if (generation.status === "ready" && (generation.provider !== "ltx" || generation.ltxRenderMode === "final")) {
        await runQcCycle(shot, generation);
      }
      return generation;
    } catch (caught) {
      setGenerations((current) => ({
        ...current,
        [shot.id]: {
          ...(current[shot.id] || {}),
          id: current[shot.id]?.id || "",
          episodeId: current[shot.id]?.episodeId || episodeId,
          shotId: shot.id,
          model: current[shot.id]?.model || "",
          provider: current[shot.id]?.provider || videoProvider,
          ltxPreset: current[shot.id]?.ltxPreset || ltxPresetForShot(shot),
          ltxRenderMode: current[shot.id]?.ltxRenderMode || ltxRenderMode,
          backendStatus: current[shot.id]?.backendStatus || "",
          backendQueuePosition: current[shot.id]?.backendQueuePosition || 0,
          backendStartedAt: current[shot.id]?.backendStartedAt || "",
          estimatedSecondsRemaining: current[shot.id]?.estimatedSecondsRemaining || 0,
          prompt: current[shot.id]?.prompt || shot.prompt,
          continuitySourceGenerationId: current[shot.id]?.continuitySourceGenerationId || continuitySourceGenerationId,
          initialFrameKind: current[shot.id]?.initialFrameKind || "",
          status: "failed",
          durationSeconds: current[shot.id]?.durationSeconds || 5,
          aspectRatio: current[shot.id]?.aspectRatio || (format === "reels" ? "9:16" : "16:9"),
          usedReferenceIds: current[shot.id]?.usedReferenceIds || [],
          omittedReferenceIds: current[shot.id]?.omittedReferenceIds || [],
          error: caught instanceof Error ? caught.message : "영상 생성 중 문제가 생겼습니다.",
          createdAt: current[shot.id]?.createdAt || "",
          updatedAt: new Date().toISOString(),
          videoUrl: "",
          qualityTier: current[shot.id]?.qualityTier || "fast",
          autoRegenerationCount: current[shot.id]?.autoRegenerationCount || 0,
          parentGenerationId: current[shot.id]?.parentGenerationId || "",
          approvalStatus: current[shot.id]?.approvalStatus || "pending",
          qc: current[shot.id]?.qc || null,
        },
      }));
      return null;
    }
  }

  async function reviseAndRegenerate(sceneId: string, shot: DirectorPlan["scenes"][number]["shots"][number]) {
    const instruction = (revisionText[shot.id] || "").trim();
    if (!plan || instruction.length < 2 || revisionPendingShots.has(shot.id)) return;
    setRevisionPendingShots((current) => new Set(current).add(shot.id));
    setQcMessages((current) => ({ ...current, [shot.id]: "" }));
    try {
      const reviseResponse = await fetch("/api/shots/revise", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPrompt: shot.prompt, instruction, action: shot.action, startState: shot.startState, endState: shot.endState }),
      });
      const reviseBody = (await reviseResponse.json()) as { prompt?: string; error?: string; requestId?: string };
      if (!reviseResponse.ok || !reviseBody.prompt) {
        throw new Error(`${reviseBody.error || "수정 프롬프트를 만들지 못했습니다."}${reviseBody.requestId ? ` (문의 번호: ${reviseBody.requestId})` : ""}`);
      }
      const revisedShot = { ...shot, prompt: reviseBody.prompt };
      const revisedPlan: DirectorPlan = {
        ...plan,
        scenes: plan.scenes.map((scene) => scene.id !== sceneId ? scene : {
          ...scene,
          shots: scene.shots.map((item) => item.id === shot.id ? revisedShot : item),
        }),
      };
      const saveResponse = await fetch(`/api/episodes/${episodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: revisedPlan }),
      });
      if (!saveResponse.ok) throw new Error("수정 프롬프트를 Episode에 저장하지 못했습니다.");
      setPlan(revisedPlan);
      setRevisionText((current) => ({ ...current, [shot.id]: "" }));
      await generateShot(revisedShot, generations[shot.id]?.ltxRenderMode || "preview");
    } catch (caught) {
      setQcMessages((current) => ({ ...current, [shot.id]: caught instanceof Error ? caught.message : "영상 수정 중 문제가 생겼습니다." }));
    } finally {
      setRevisionPendingShots((current) => {
        const next = new Set(current);
        next.delete(shot.id);
        return next;
      });
    }
  }

  async function restoreGenerationVersion(sceneId: string, shot: DirectorPlan["scenes"][number]["shots"][number], version: ShotGenerationView) {
    if (!plan || !episodeId) return;
    setQcMessages((current) => ({ ...current, [shot.id]: "" }));
    try {
      const response = await fetch(`/api/episodes/${episodeId}/generations`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ shotId: shot.id, generationId: version.id }),
      });
      const body = (await response.json()) as GenerationApiResponse;
      if (!response.ok || !body.generation) throw new Error(apiError(body, "이전 영상 버전을 복원하지 못했습니다."));
      rememberGenerationVersion(shot.id, generations[shot.id]);
      setGenerations((current) => ({ ...current, [shot.id]: body.generation as ShotGenerationView }));
      const restoredPlan: DirectorPlan = {
        ...plan,
        scenes: plan.scenes.map((scene) => scene.id !== sceneId ? scene : {
          ...scene,
          shots: scene.shots.map((item) => item.id === shot.id ? { ...item, prompt: version.prompt } : item),
        }),
      };
      setPlan(restoredPlan);
      await fetch(`/api/episodes/${episodeId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: restoredPlan }),
      });
    } catch (caught) {
      setQcMessages((current) => ({ ...current, [shot.id]: caught instanceof Error ? caught.message : "이전 영상 버전을 복원하지 못했습니다." }));
    }
  }

  async function approveShot(shotId: string, generation: ShotGenerationView) {
    try {
      const response = await fetch(`/api/shots/generate/${generation.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved: true }),
      });
      const body = (await response.json()) as GenerationApiResponse;
      if (!response.ok || !body.generation) throw new Error(apiError(body, "Shot을 승인하지 못했습니다."));
      setGenerations((current) => ({ ...current, [shotId]: body.generation as ShotGenerationView }));
    } catch (caught) {
      setQcMessages((current) => ({
        ...current,
        [shotId]: caught instanceof Error ? caught.message : "Shot을 승인하지 못했습니다.",
      }));
    }
  }

  async function toggleLtxBatchMode() {
    if (ltxBatchPending) return;
    setLtxBatchPending(true);
    setLtxBatchMessage("");
    try {
      const response = await fetch("/api/system/ltx-batch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !ltxBatchMode?.enabled }),
      });
      const body = (await response.json()) as { batchMode?: LtxBatchModeView; error?: string; requestId?: string };
      if (!response.ok || !body.batchMode) {
        throw new Error(`${body.error || "고속 배치 모드를 전환하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
      }
      setLtxBatchMode(body.batchMode);
      setLtxBatchMessage(body.batchMode.message);
    } catch (caught) {
      setLtxBatchMessage(caught instanceof Error ? caught.message : "고속 배치 모드를 전환하지 못했습니다.");
    } finally {
      setLtxBatchPending(false);
    }
  }

  async function enableLtxBatchForBulk() {
    if (videoProvider !== "ltx" || ltxBatchMode?.enabled) return;
    const response = await fetch("/api/system/ltx-batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    const body = (await response.json()) as { batchMode?: LtxBatchModeView; error?: string; requestId?: string };
    if (!response.ok || !body.batchMode) {
      throw new Error(`${body.error || "고속 배치 모드를 준비하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
    }
    setLtxBatchMode(body.batchMode);
  }

  async function generateAllPreviews() {
    if (!plan || bulkGenerationPending) return;
    if (Object.values(generations).some((generation) => generation.status === "generating")) {
      setBulkGenerationProgress({ completed: readyShotCount, total: orderedPlanShots.length, message: "현재 생성 중인 Shot이 끝나면 다시 눌러 이어서 만들어주세요." });
      return;
    }
    const orderedShots = plan.scenes.flatMap((scene) => scene.shots);
    const remainingShots = orderedShots.filter((shot) => generations[shot.id]?.status !== "ready");
    if (!remainingShots.length) {
      setBulkGenerationProgress({ completed: orderedShots.length, total: orderedShots.length, message: "모든 Shot 영상이 이미 준비되어 있습니다." });
      return;
    }
    bulkGenerationStopRef.current = false;
    setBulkGenerationPending(true);
    setBulkGenerationProgress({ completed: orderedShots.length - remainingShots.length, total: orderedShots.length, message: "B200 고속 배치를 준비하고 있어요." });
    const snapshot = { ...generations };
    try {
      await enableLtxBatchForBulk();
      let completed = orderedShots.length - remainingShots.length;
      for (const shot of orderedShots) {
        if (bulkGenerationStopRef.current) {
          setBulkGenerationProgress({ completed, total: orderedShots.length, message: "현재 Shot까지 저장하고 전체 생성을 멈췄습니다. 다시 누르면 이어서 생성합니다." });
          break;
        }
        if (snapshot[shot.id]?.status === "ready") continue;
        setBulkGenerationProgress({ completed, total: orderedShots.length, message: `Shot ${shot.id} 미리보기를 만들고 있어요.` });
        const generation = await generateShot(shot, "preview", snapshot);
        if (!generation || generation.status !== "ready") {
          throw new Error(`Shot ${shot.id} 생성이 완료되지 않았습니다. 다시 누르면 이 Shot부터 이어서 생성합니다.`);
        }
        snapshot[shot.id] = generation;
        completed += 1;
        setBulkGenerationProgress({ completed, total: orderedShots.length, message: `${completed}/${orderedShots.length} Shot을 준비했습니다.` });
      }
      if (!bulkGenerationStopRef.current && completed === orderedShots.length) {
        setBulkGenerationProgress({ completed, total: orderedShots.length, message: "전체 Shot 미리보기가 준비되었습니다. 확인 후 승인하거나 고화질로 바꿔주세요." });
      }
    } catch (caught) {
      setBulkGenerationProgress((current) => ({ ...current, message: caught instanceof Error ? caught.message : "전체 Shot 생성 중 문제가 생겼습니다." }));
    } finally {
      setBulkGenerationPending(false);
    }
  }

  async function createFinalVideo() {
    if (!episodeId || finalVideoPending || finalVideo?.status === "generating") return;
    setFinalVideoPending(true);
    setFinalVideoMessage("");
    try {
      const response = await fetch(`/api/episodes/${episodeId}/final-video`, { method: "POST" });
      const body = (await response.json()) as FinalVideoApiResponse;
      if (!response.ok || !body.finalVideo) {
        throw new Error(`${body.error || "최종 영상을 만들지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
      }
      setFinalVideo(body.finalVideo);
      setFinalVideoMessage("승인 영상을 Scene/Shot 순서대로 합치고 있어요.");
    } catch (caught) {
      setFinalVideoMessage(caught instanceof Error ? caught.message : "최종 영상을 만들지 못했습니다.");
    } finally {
      setFinalVideoPending(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
    router.refresh();
  }

  const orderedPlanShots = plan?.scenes.flatMap((scene) => scene.shots) || [];
  const readyShotCount = orderedPlanShots.filter((shot) => generations[shot.id]?.status === "ready").length;
  const approvedShotCount = orderedPlanShots.filter((shot) => generations[shot.id]?.status === "ready" && generations[shot.id]?.approvalStatus === "approved").length;
  const currentGenerationIds = orderedPlanShots.map((shot) => generations[shot.id]?.id || "").filter(Boolean);
  const finalVideoIsStale = Boolean(finalVideo?.status === "ready" && (
    finalVideo.shotGenerationIds.length !== currentGenerationIds.length ||
    finalVideo.shotGenerationIds.some((id, index) => id !== currentGenerationIds[index])
  ));

  return (
    <main className="page-shell studio-page">
      <header className="studio-header">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span className="brand-name">Animation Studio</span>
        </div>
        <div className="header-actions">
          <Link className="quiet-button nav-link" href="/episodes">지난 이야기</Link>
          <Link className="quiet-button nav-link" href="/references">자료실</Link>
          <button className="quiet-button" type="button" onClick={logout}>나가기</button>
        </div>
      </header>

      <section className="studio-intro">
        <h1 className="studio-title">오늘 이야기를<br />들려주세요</h1>
        <p className="studio-copy">하루 이야기를 적거나 사진 한 장을 올려주세요. 장면과 영상 구성은 스튜디오가 알아서 준비합니다.</p>
      </section>

      <form className="story-card" onSubmit={handleSubmit} aria-busy={pending}>
        <textarea
          className="story-input"
          aria-label="오늘의 가족 이야기"
          placeholder="오늘 있었던 일을 처음부터 끝까지 편하게 적어주세요."
          value={story}
          onChange={(event) => {
            const nextStory = event.target.value;
            setStory(nextStory);
            setError("");
            if (nextStory) sessionStorage.setItem(DRAFT_KEY, nextStory);
            else sessionStorage.removeItem(DRAFT_KEY);
          }}
          maxLength={12000}
          disabled={pending}
        />
        <div className="story-helper"><span>글이나 스토리보드 이미지로 알려주세요</span><span>{story.length.toLocaleString()} / 12,000</span></div>
        <fieldset className="format-selector" disabled={pending}>
          <legend>완성 영상 형식</legend>
          <label className={format === "reels" ? "selected" : ""}>
            <input type="radio" name="episode-format" value="reels" checked={format === "reels"} onChange={() => setFormat("reels")} />
            <span><strong>인스타 릴스</strong><small>9:16 세로 · Scene 이미지 없이도 생성 가능</small></span>
          </label>
          <label className={format === "landscape" ? "selected" : ""}>
            <input type="radio" name="episode-format" value="landscape" checked={format === "landscape"} onChange={() => setFormat("landscape")} />
            <span><strong>가로 영상</strong><small>16:9 · 기존 방식</small></span>
          </label>
        </fieldset>
        {storyboardInputs.length || pendingStoryboards.length ? (
          <div className="storyboard-preview-grid" aria-label="첨부한 스토리보드 이미지">
            {storyboardInputs.map((input) => (
              <div className="storyboard-preview" key={input.id}>
                <Image src={input.imageUrl} alt={input.name} fill sizes="120px" unoptimized />
                <button type="button" aria-label={`${input.name} 삭제`} disabled={pending} onClick={() => setStoryboardInputs((current) => current.filter((item) => item.id !== input.id))}>×</button>
              </div>
            ))}
            {pendingStoryboards.map((input) => (
              <div className="storyboard-preview" key={input.key}>
                <Image src={input.previewUrl} alt={input.file.name} fill sizes="120px" unoptimized />
                <button type="button" aria-label={`${input.file.name} 삭제`} disabled={pending} onClick={() => removePendingStoryboard(input.key)}>×</button>
              </div>
            ))}
          </div>
        ) : null}
        <label className={`storyboard-add-button${storyboardInputs.length + pendingStoryboards.length >= MAX_STORYBOARD_IMAGES ? " disabled" : ""}`} htmlFor="storyboard-files">
          <span aria-hidden="true">＋</span>
          <strong>스토리보드 이미지 추가</strong>
          <small>JPG, PNG, WebP · 최대 3장</small>
        </label>
        <input
          className="visually-hidden"
          id="storyboard-files"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={pending || storyboardInputs.length + pendingStoryboards.length >= MAX_STORYBOARD_IMAGES}
          onChange={(event) => { selectStoryboardFiles(event.target.files); event.currentTarget.value = ""; }}
        />
        <button className="primary-button" type="submit" disabled={(story.trim().length < 10 && storyboardInputs.length + pendingStoryboards.length === 0) || pending}>
          {pending ? <><span className="button-spinner" aria-hidden="true" />이야기 구성 중…</> : "전체 이야기 만들기"}
        </button>
        {pending ? <p className="phase-note" role="status">AI Director가 상황별 Scene과 한 가지 행동 중심의 Shot을 구성하고 있어요.</p> : null}
        {error ? <p className="feedback" role="alert">{error}</p> : null}
      </form>

      <div className="creation-divider" aria-hidden="true"><span>또는</span></div>
      <PhotoVideoForm />

      {plan ? (
        <section className="episode-plan" aria-labelledby="episode-plan-title">
          <div className="plan-heading">
            <p className="eyebrow">DIRECTOR PLAN</p>
            <h2 id="episode-plan-title">{plan.title}</h2>
            <p>{plan.summary}</p>
            <p className="episode-format-badge">{format === "reels" ? "인스타 릴스 · 9:16 세로" : "가로 영상 · 16:9"}</p>
            <p className="identity-standard"><span aria-hidden="true">✓</span> 고정 Visual Bible: 모든 Master Reference 그대로 유지</p>
            {episodeId ? <Link className="episode-saved-link" href={`/episodes/${episodeId}`}>저장된 Episode 보기</Link> : null}
          </div>
          <div className="plan-metrics" aria-label="이야기 구성 요약">
            <div><strong>{plan.scenes.length}</strong><span>Scenes</span></div>
            <div><strong>{plan.totalShots}</strong><span>Video Shots</span></div>
            <div><strong>{formatDuration(plan.scenes.reduce((total, scene) => total + scene.shots.reduce((sceneTotal, shot) => sceneTotal + newLtxDuration(shot.estimatedSeconds), 0), 0))}</strong><span>예상 완성 길이</span></div>
          </div>

          <fieldset className="video-provider-selector">
            <legend>영상 생성 엔진</legend>
            <label className={videoProvider === "ltx" ? "selected" : ""}>
              <input type="radio" name="video-provider" value="ltx" checked={videoProvider === "ltx"} onChange={() => setVideoProvider("ltx")} />
              <span><strong>B200 · LTX-2.5</strong><small>우리 서버 오픈 모델 · 레퍼런스 그림체 우선</small></span>
            </label>
            <label className={videoProvider === "google" ? "selected" : ""}>
              <input type="radio" name="video-provider" value="google" checked={videoProvider === "google"} onChange={() => setVideoProvider("google")} />
              <span><strong>Google 영상</strong><small>B200 점검 시 사용할 백업 엔진</small></span>
            </label>
          </fieldset>

          {videoProvider === "ltx" ? (
            <section className={`ltx-batch-mode${ltxBatchMode?.enabled ? " enabled" : ""}`} aria-live="polite">
              <div>
                <strong>여러 영상 고속 생성</strong>
                <span>{ltxBatchMode?.message || "필요할 때 B200를 LTX 전용으로 전환합니다."}</span>
              </div>
              <button type="button" disabled={ltxBatchPending || ltxBatchMode?.state === "starting" || ltxBatchMode?.state === "restoring"} onClick={() => void toggleLtxBatchMode()}>
                {ltxBatchPending || ltxBatchMode?.state === "starting" ? "전환 중…" : ltxBatchMode?.state === "restoring" ? "A.X 복구 중…" : ltxBatchMode?.enabled ? "고속 모드 끄기" : "고속 모드 켜기"}
              </button>
              <p>A.X를 잠시 멈추고 LTX 모델을 GPU에 계속 유지합니다. 작업이 10분간 없으면 A.X가 자동으로 복구돼요.</p>
              {ltxBatchMessage ? <p className="ltx-batch-message">{ltxBatchMessage}</p> : null}
            </section>
          ) : null}

          <section className="bulk-generation-panel" aria-live="polite">
            <div>
              <span className="eyebrow">ALL SHOTS</span>
              <strong>전체 Shot 순서대로 만들기</strong>
              <p>완료된 영상은 건너뛰고, 같은 Scene의 앞 영상 마지막 프레임을 이어서 미리보기를 만듭니다.</p>
            </div>
            <div className="bulk-generation-metrics">
              <span><b>{readyShotCount}</b> / {orderedPlanShots.length} 준비</span>
              <span><b>{approvedShotCount}</b> 승인</span>
            </div>
            {bulkGenerationProgress.total ? (
              <div className="bulk-progress" role="status">
                <span style={{ width: `${Math.round(100 * bulkGenerationProgress.completed / Math.max(1, bulkGenerationProgress.total))}%` }} />
                <p>{bulkGenerationProgress.message}</p>
              </div>
            ) : null}
            {bulkGenerationPending ? (
              <button className="secondary-action" type="button" onClick={() => { bulkGenerationStopRef.current = true; }}>
                현재 Shot 이후 멈추기
              </button>
            ) : (
              <button className="primary-button" type="button" disabled={!orderedPlanShots.length || readyShotCount === orderedPlanShots.length || hasActiveLtxGeneration} onClick={() => void generateAllPreviews()}>
                {readyShotCount ? "이어서 전체 미리보기 만들기" : "전체 미리보기 만들기"}
              </button>
            )}
          </section>

          {format === "reels" ? (
            <section className="reels-frame-overview" aria-label="릴스 Scene 이미지 준비 상태">
              <div>
                <strong>{videoProvider === "ltx" ? "LTX는 고정 레퍼런스에서 바로 시작해요" : "Scene 시작 이미지는 선택 사항이에요"}</strong>
                <span>{Object.values(sceneFrames).filter((frame) => frame.approvalStatus === "approved").length} / {plan.scenes.length} 승인</span>
              </div>
              <p>{videoProvider === "ltx"
                ? "정지 이미지를 새로 생성하지 않고, 자료실의 Scene·캐릭터 레퍼런스를 시작 프레임으로 사용해 B200에서 영상을 만듭니다."
                : "Scene 이미지를 만들어 승인하면 정확한 시작 화면으로 사용합니다."}</p>
              {videoProvider === "google" ? (
                <button type="button" disabled={allSceneFramesPending || plan.scenes.every((scene) => Boolean(sceneFrames[scene.id]))} onClick={() => void generateMissingSceneFrames()}>
                  {allSceneFramesPending ? <><span className="button-spinner" aria-hidden="true" />Scene 이미지 준비 중…</> : "없는 Scene 이미지 모두 만들기"}
                </button>
              ) : null}
            </section>
          ) : null}

          <div className="scene-list">
            {plan.scenes.map((scene) => (
              <details
                className="scene-accordion"
                key={scene.id}
                open={openScenes.has(scene.id)}
                onToggle={(event) => {
                  const isOpen = event.currentTarget.open;
                  setOpenScenes((current) => {
                    const next = new Set(current);
                    if (isOpen) next.add(scene.id);
                    else next.delete(scene.id);
                    return next;
                  });
                }}
              >
                <summary>
                  <span className="scene-number">SCENE {String(scene.number).padStart(2, "0")}</span>
                  <span className="scene-summary-main">
                    <strong>{scene.title}</strong>
                    <small>{scene.shots.length} Shots · {scene.setting}</small>
                  </span>
                  <span className="scene-status">구성 완료</span>
                  <span className="accordion-chevron" aria-hidden="true">⌄</span>
                </summary>
                <div className="scene-content">
                  <p className="scene-description">{scene.summary}</p>
                  {scene.sceneMasterReferenceId && referenceById.get(scene.sceneMasterReferenceId) ? (
                    <p className="master-reference">Scene 기준 이미지 · {referenceById.get(scene.sceneMasterReferenceId)?.name}</p>
                  ) : null}
                  {format === "reels" && (videoProvider === "google" || Boolean(sceneFrames[scene.id])) ? (
                    <section className={`scene-frame-card${sceneFrames[scene.id]?.approvalStatus === "approved" ? " approved" : ""}`} aria-label={`Scene ${scene.number} 세로 기준 이미지`}>
                      <div className="scene-frame-heading">
                        <div><span>9:16 SCENE FRAME</span><strong>영상 시작 이미지</strong></div>
                        <span className={`scene-frame-state ${sceneFrames[scene.id]?.approvalStatus || "empty"}`}>
                          {sceneFrames[scene.id]?.approvalStatus === "approved" ? "승인 완료" : sceneFrames[scene.id] ? "확인 필요" : "이미지 전"}
                        </span>
                      </div>
                      {sceneFrames[scene.id] ? (
                        <div className="scene-frame-image">
                          <Image
                            src={`/api/episodes/${episodeId}/scenes/${scene.id}/frame?v=${sceneFrames[scene.id].id}`}
                            alt={`${scene.title} 세로 기준 이미지`}
                            fill
                            sizes="(max-width: 640px) 88vw, 420px"
                            unoptimized
                          />
                        </div>
                      ) : (
                        <div className="scene-frame-empty"><span aria-hidden="true">✦</span><p>가족 레퍼런스로 세로 장면을 먼저 만듭니다.</p></div>
                      )}
                      {pendingSceneFrames.has(scene.id) ? <p className="qc-progress" role="status"><span className="button-spinner" aria-hidden="true" />가족 모습과 그림체를 맞춰 Scene 이미지를 만들고 있어요…</p> : null}
                      <label className="scene-frame-revision" htmlFor={`scene-frame-${scene.id}`}>
                        <span>{sceneFrames[scene.id] ? "어떻게 바꿀까요?" : "이미지에 원하는 점이 있나요?"}</span>
                        <textarea
                          id={`scene-frame-${scene.id}`}
                          placeholder="예: 아이를 조금 더 작게, 곰인형은 아이 몸통만큼 크게 보여주세요."
                          value={sceneFrameInstructions[scene.id] || ""}
                          maxLength={500}
                          disabled={pendingSceneFrames.has(scene.id)}
                          onChange={(event) => setSceneFrameInstructions((current) => ({ ...current, [scene.id]: event.target.value }))}
                        />
                      </label>
                      <div className="scene-frame-actions">
                        <button type="button" disabled={pendingSceneFrames.has(scene.id)} onClick={() => void generateSceneFrame(scene.id)}>
                          {sceneFrames[scene.id] ? "수정해서 다시 만들기" : "Scene 이미지 만들기"}
                        </button>
                        {sceneFrames[scene.id] ? (
                          <button className="approve" type="button" disabled={pendingSceneFrames.has(scene.id)} onClick={() => void approveSceneFrame(scene.id, sceneFrames[scene.id].approvalStatus !== "approved")}>
                            {sceneFrames[scene.id].approvalStatus === "approved" ? "승인 취소" : "이 이미지 승인"}
                          </button>
                        ) : null}
                      </div>
                      {sceneFrameMessages[scene.id] ? <p className="feedback compact-feedback" role="alert">{sceneFrameMessages[scene.id]}</p> : null}
                      {sceneFrames[scene.id]?.approvalStatus === "approved" ? <p className="scene-frame-ready">이 이미지가 첫 Shot의 정확한 시작 화면으로 사용됩니다.</p> : null}
                    </section>
                  ) : null}
                  <div className="shot-list">
                    {scene.shots.map((shot, shotIndex) => {
                      const generation = generations[shot.id];
                      const previousGeneration = shotIndex > 0 ? generations[scene.shots[shotIndex - 1].id] : undefined;
                      const continuityIsStale = Boolean(
                        generation?.continuitySourceGenerationId &&
                        previousGeneration?.id &&
                        generation.continuitySourceGenerationId !== previousGeneration.id,
                      );
                      const previousVersions = (generationVersions[shot.id] || [])
                        .filter((version) => version.id !== generation?.id && version.status === "ready")
                        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
                      const selectedReferences = shot.referenceIds
                        .map((id) => referenceById.get(id))
                        .filter((reference): reference is DirectorReference => Boolean(reference));
                      const referenceDraft = referenceDrafts[shot.id] || shot.referenceIds;
                      return (
                        <article className="shot-card" id={`shot-${shot.id}`} key={shot.id}>
                          <div className="shot-heading">
                            <div>
                              <span className="shot-number">SHOT {shot.id}</span>
                              <h3>{shot.title}</h3>
                            </div>
                            <div className="shot-badges">
                              {generation ? <span className={`model-tier ${generation.provider === "ltx" ? "ltx" : generation.model.includes("omni") ? "omni" : generation.qualityTier}`}>{generation.provider === "ltx" ? `LTX · ${generation.ltxRenderMode === "preview" ? "미리보기" : "고화질"}` : generation.model.includes("omni") ? "OMNI" : generation.qualityTier === "fast" ? "FAST" : "STANDARD"}</span> : null}
                              {generation?.continuitySourceGenerationId ? <span className={`continuity-badge${continuityIsStale ? " stale" : ""}`}>{continuityIsStale ? "연결 다시 필요" : "이전 프레임 연결"}</span> : null}
                              {generation?.initialFrameKind === "scene_master" ? <span className="continuity-badge">2D Scene 기준 프레임</span> : null}
                              <span className="shot-duration">{newLtxDuration(shot.estimatedSeconds)}초</span>
                            </div>
                          </div>
                          <p className="shot-action">{shot.action}</p>
                          <div className="continuity-row">
                            <span><b>시작</b>{shot.startState}</span>
                            <span className="continuity-arrow" aria-hidden="true">→</span>
                            <span><b>끝</b>{shot.endState}</span>
                          </div>
                          <div className="shot-references">
                            <span className="meta-label">고정 기준</span>
                            {selectedReferences.length ? selectedReferences.map((reference) => (
                              <span className="reference-pill" key={reference.id}>{reference.category} · {reference.name}</span>
                            )) : <span className="no-reference">직접 전달 이미지 없음</span>}
                          </div>
                          {shot.referenceReason ? <p className="reference-reason">{shot.referenceReason}</p> : null}
                          <button className="reference-change-button" type="button" onClick={() => openReferenceEditor(shot.id, shot.referenceIds)}>
                            {referenceEditorShotId === shot.id ? "고정 기준 선택 닫기" : "고정 기준 직접 선택·변경"}
                          </button>
                          {referenceEditorShotId === shot.id ? (
                            <section className="shot-reference-editor" aria-label={`Shot ${shot.id} 고정 기준 선택`}>
                              <div className="shot-reference-editor-heading">
                                <strong>자료실에서 최대 6장 선택</strong>
                                <span>{referenceDraft.length} / 6</span>
                              </div>
                              <div className="shot-reference-options">
                                {references.map((reference) => {
                                  const checked = referenceDraft.includes(reference.id);
                                  return (
                                    <label className={checked ? "selected" : ""} key={reference.id}>
                                      <input type="checkbox" checked={checked} onChange={() => toggleShotReference(shot.id, reference.id)} />
                                      <span className="shot-reference-thumbnail">
                                        <Image src={`/api/references/${reference.id}/image`} alt="" fill sizes="54px" unoptimized />
                                      </span>
                                      <span><b>{reference.name}</b><small>{reference.category}</small></span>
                                    </label>
                                  );
                                })}
                              </div>
                              <div className="shot-reference-editor-actions">
                                <button type="button" onClick={() => setReferenceEditorShotId("")}>취소</button>
                                <button type="button" disabled={referenceSavingShotIds.has(shot.id)} onClick={() => void saveShotReferences(scene.id, shot.id)}>
                                  {referenceSavingShotIds.has(shot.id) ? "저장 중…" : "이 선택으로 저장"}
                                </button>
                              </div>
                            </section>
                          ) : null}
                          <details className="prompt-panel">
                            <summary>프롬프트 보기·수정</summary>
                            <textarea
                              aria-label={`Shot ${shot.id} 프롬프트`}
                              value={shot.prompt}
                              onChange={(event) => updatePrompt(scene.id, shot.id, event.target.value)}
                              onBlur={() => void saveCurrentPlan()}
                            />
                          </details>
                          {generation?.status === "ready" ? (
                            <div className="shot-video-result">
                              <video className={generation.aspectRatio === "9:16" ? "portrait-video" : undefined} controls playsInline preload="metadata" src={generation.videoUrl} />
                              <a
                                className="video-download-primary"
                                href={`${generation.videoUrl}?download=1`}
                                download={`family-animation-${shot.id}.mp4`}
                              >
                                영상 다운로드
                              </a>
                              {generation.provider === "ltx" && generation.ltxRenderMode === "preview" ? (
                                <section className="preview-approval-panel">
                                  <div><strong>빠른 미리보기</strong><span>움직임과 구도를 확인한 뒤 고화질로 완성하세요.</span></div>
                                  <button type="button" onClick={() => generateShot(shot, "final")}>미리보기 승인 · 고화질 만들기</button>
                                </section>
                              ) : null}
                              {qcPendingShots.has(shot.id) ? (
                                <p className="qc-progress" role="status"><span className="button-spinner" aria-hidden="true" />GPT가 영상 품질을 검수하고 있어요…</p>
                              ) : null}
                              {generation.qc ? (
                                <section className="qc-result" aria-label={`Shot ${shot.id} 품질 검수`}>
                                  <div className="qc-heading">
                                    <div><span>GPT QC</span><strong>{generation.qc.overall}</strong><small>/ 100</small></div>
                                    <span className={`qc-decision ${generation.approvalStatus}`}>
                                      {generation.approvalStatus === "approved" ? "승인" : "사용자 확인 필요"}
                                    </span>
                                  </div>
                                  <div className="qc-score-grid">
                                    <span>캐릭터 <b>{generation.qc.scores.characterConsistency}</b></span>
                                    <span>얼굴 <b>{generation.qc.scores.faceStability}</b></span>
                                    <span>손·신체 <b>{generation.qc.scores.handsBody}</b></span>
                                    <span>배경 <b>{generation.qc.scores.backgroundConsistency}</b></span>
                                    <span>소품 <b>{generation.qc.scores.objectConsistency}</b></span>
                                    <span>움직임 <b>{generation.qc.scores.motionNaturalness}</b></span>
                                    <span>Reference <b>{generation.qc.scores.referenceMatch}</b></span>
                                    <span>연결성 <b>{generation.qc.scores.continuity}</b></span>
                                  </div>
                                  <p>{generation.qc.summary}</p>
                                  {generation.autoRegenerationCount ? <p className="qc-attempt">고정 기준 자동 보정 {generation.autoRegenerationCount}/2회</p> : null}
                                </section>
                              ) : null}
                              <section className="video-revision-panel" aria-label={`Shot ${shot.id} 영상 수정`}>
                                <label htmlFor={`revision-${shot.id}`}>
                                  {generation.approvalStatus === "approved" ? "승인 완료 · 그래도 수정할 수 있어요" : "어떻게 바꿀까요?"}
                                </label>
                                <textarea
                                  id={`revision-${shot.id}`}
                                  placeholder="예: 아이 표정을 더 밝게 하고 카메라를 조금 더 가까이 보여주세요."
                                  value={revisionText[shot.id] || ""}
                                  maxLength={500}
                                  disabled={revisionPendingShots.has(shot.id)}
                                  onChange={(event) => setRevisionText((current) => ({ ...current, [shot.id]: event.target.value }))}
                                />
                                <div>
                                  <small>{generation.approvalStatus === "approved" ? "승인 영상은 그대로 보관하고 수정본을 새로 만듭니다." : "현재 영상은 이전 버전으로 보관됩니다."}</small>
                                  <button
                                    type="button"
                                    disabled={(revisionText[shot.id] || "").trim().length < 2 || revisionPendingShots.has(shot.id)}
                                    onClick={() => reviseAndRegenerate(scene.id, shot)}
                                  >
                                    {revisionPendingShots.has(shot.id) ? "수정 준비 중…" : generation.approvalStatus === "approved" ? "승인본 유지하고 수정본 만들기" : "수정해서 새 영상 만들기"}
                                  </button>
                                </div>
                              </section>
                              {qcMessages[shot.id] ? <p className="feedback compact-feedback" role="alert">{qcMessages[shot.id]}</p> : null}
                              <div className="video-actions">
                                {generation.approvalStatus !== "approved" && !(generation.provider === "ltx" && generation.ltxRenderMode === "preview") ? (
                                  <button className="small-action" type="button" onClick={() => approveShot(shot.id, generation)}>이대로 승인</button>
                                ) : null}
                                <button className="small-action" type="button" onClick={() => generateShot(shot, generation.ltxRenderMode)}>{generation.provider === "ltx" && generation.ltxRenderMode === "preview" ? "미리보기 다시 생성" : videoProvider === "ltx" ? "LTX로 다시 생성" : selectedReferences.length ? "고정 기준으로 다시 생성" : "Fast로 다시 생성"}</button>
                                {!generation.qc && !qcPendingShots.has(shot.id) && !(generation.provider === "ltx" && generation.ltxRenderMode === "preview") ? (
                                  <button className="small-action" type="button" onClick={() => runQcCycle(shot, generation)}>검수 다시 시도</button>
                                ) : null}
                              </div>
                              {previousVersions.length ? (
                                <details className="video-version-history">
                                  <summary>이전 영상 {previousVersions.length}개 보기</summary>
                                  <div className="video-version-list">
                                    {previousVersions.map((version, index) => (
                                      <article key={version.id}>
                                        <div><strong>이전 버전 {previousVersions.length - index}</strong><span>{version.provider === "ltx" ? "LTX-2.5" : version.model.includes("omni") ? "OMNI" : version.qualityTier.toUpperCase()} · {version.qc ? `QC ${version.qc.overall}` : "QC 없음"}</span></div>
                                        <video className={version.aspectRatio === "9:16" ? "portrait-video" : undefined} controls playsInline preload="metadata" src={version.videoUrl} />
                                        <button type="button" onClick={() => restoreGenerationVersion(scene.id, shot, version)}>이 버전으로 복원</button>
                                      </article>
                                    ))}
                                  </div>
                                </details>
                              ) : null}
                            </div>
                          ) : (
                            <>
                              {generation?.status === "generating" && generation.provider === "ltx" ? (
                                <LtxGenerationProgress generation={generation} nowMs={progressNowMs} />
                              ) : null}
                              {videoProvider === "ltx" && generation?.status !== "generating" ? (
                                <div className="ltx-render-actions">
                                  <button className="shot-generate-button" type="button" disabled={!shot.prompt.trim()} onClick={() => generateShot(shot, "preview")}>빠른 미리보기 만들기</button>
                                  <button className="small-action" type="button" disabled={!shot.prompt.trim()} onClick={() => generateShot(shot, "final")}>바로 고화질 만들기</button>
                                  <small>미리보기는 낮은 해상도·8단계로 빠르게 확인합니다.</small>
                                </div>
                              ) : (
                                <button
                                  className="shot-generate-button"
                                  type="button"
                                  disabled={generation?.status === "generating" || !shot.prompt.trim()}
                                  onClick={() => generateShot(shot)}
                                >
                                  {generation?.status === "generating" ? <><span className="button-spinner" aria-hidden="true" />{generation.provider === "ltx" ? generation.backendStatus || "B200 LTX 영상 생성 중…" : selectedReferences.length ? "고정 기준 영상 생성 중…" : generation.qualityTier === "standard" ? "Standard 보정 생성 중…" : "Fast 영상 생성 중…"}</> : generation?.status === "failed" ? "다시 생성" : "영상 만들기"}
                                </button>
                              )}
                            </>
                          )}
                          {format === "reels" && sceneFrames[scene.id]?.approvalStatus !== "approved" ? <p className="generation-note">Scene 이미지가 없어 고정 레퍼런스를 시작 프레임으로 사용합니다.</p> : null}
                          {qcPendingShots.has(shot.id) && generation?.status === "generating" ? <p className="generation-note">QC 결과에 따라 고정 기준 보정 영상을 만들고 있어요.</p> : null}
                          {generation?.omittedReferenceIds.length ? (
                            <p className="generation-note">
                              {selectedReferences.some((reference) => reference.category === "아이")
                                ? "아이 Shot은 Veo 정책상 아이 이미지를 직접 전달하지 않지만, 얼굴·머리·체형·의상·그림체는 Master Reference 고정 조건으로 적용됩니다."
                                : "직접 전달할 수 없는 이미지는 분석된 모든 시각 특징을 고정 조건으로 적용합니다."}
                            </p>
                          ) : null}
                          {generation?.status === "failed" && generation.error ? <p className="feedback compact-feedback" role="alert">{generation.error}</p> : null}
                        </article>
                      );
                    })}
                  </div>
                </div>
              </details>
            ))}
          </div>

          <section className={`final-video-panel${finalVideo?.status === "ready" ? " ready" : ""}`} aria-live="polite">
            <div className="final-video-heading">
              <div><span className="eyebrow">FINAL EPISODE</span><h3>최종 영상 만들기</h3></div>
              <span>{approvedShotCount}/{orderedPlanShots.length} 승인</span>
            </div>
            <p>모든 승인 영상을 Scene과 Shot 순서대로 하드컷으로 합쳐 하나의 MP4로 저장합니다.</p>
            {finalVideo?.status === "ready" && !finalVideoIsStale ? (
              <div className="final-video-result">
                <video className={finalVideo.aspectRatio === "9:16" ? "portrait-video" : undefined} controls playsInline preload="metadata" src={`/api/episodes/${episodeId}/final-video/video`} />
                <a className="primary-link" href={`/api/episodes/${episodeId}/final-video/video?download=1`}>최종 영상 다운로드</a>
              </div>
            ) : null}
            {finalVideoIsStale ? <p className="feedback compact-feedback">Shot 영상이 변경되어 최종 영상을 다시 만들어야 합니다.</p> : null}
            {finalVideo?.status === "generating" ? <p className="phase-note"><span className="button-spinner" aria-hidden="true" />{finalVideo.backendStatus || "B200에서 영상을 합치고 있어요."}</p> : null}
            {finalVideoMessage ? <p className={finalVideo?.status === "failed" ? "feedback compact-feedback" : "generation-note"}>{finalVideoMessage}</p> : null}
            {finalVideo?.status !== "generating" ? (
              <button className="primary-button" type="button" disabled={finalVideoPending || !orderedPlanShots.length || approvedShotCount !== orderedPlanShots.length} onClick={() => void createFinalVideo()}>
                {finalVideoPending ? "병합 준비 중…" : finalVideo?.status === "ready" ? "최종 영상 다시 만들기" : "최종 영상 만들기"}
              </button>
            ) : null}
            {approvedShotCount !== orderedPlanShots.length ? <small>모든 Shot을 확인하고 승인하면 버튼이 활성화됩니다.</small> : null}
          </section>
        </section>
      ) : null}

      <div className="readiness" aria-label={environmentReady ? "서버 준비 완료" : "서버 설정 확인 필요"}>
        <span className={`status-dot${environmentReady ? " ready" : ""}`} aria-hidden="true" />
        {environmentReady ? "가족 전용 서버 연결됨" : "서버 환경설정을 확인해 주세요"}
      </div>
    </main>
  );
}
