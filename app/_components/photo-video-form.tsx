"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { FormEvent, useEffect, useState } from "react";
import type { EpisodeFormat } from "@/lib/episodes/types";
import type { ShotGenerationView } from "@/lib/generations/types";
import type { StoryInputView } from "@/lib/story-inputs/types";

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type PhotoVideoResponse = {
  episodeId?: string;
  generation?: ShotGenerationView;
  error?: string;
  requestId?: string;
};

function imageExtension(file: File) {
  if (file.type === "image/png") return "png";
  if (file.type === "image/webp") return "webp";
  return "jpg";
}

export function PhotoVideoForm() {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [instruction, setInstruction] = useState("");
  const [format, setFormat] = useState<EpisodeFormat>("reels");
  const [durationSeconds, setDurationSeconds] = useState<4 | 6 | 8>(4);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  function selectPhoto(selected: File | null) {
    if (!selected) return;
    if (!PHOTO_TYPES.has(selected.type) || selected.size <= 0 || selected.size > MAX_PHOTO_BYTES) {
      setError("JPG, PNG, WebP 사진만 20MB까지 사용할 수 있어요.");
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(selected);
    setPreviewUrl(URL.createObjectURL(selected));
    setError("");
  }

  function clearPhoto() {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setFile(null);
    setPreviewUrl("");
  }

  async function uploadPhoto(photo: File) {
    const id = crypto.randomUUID();
    const uploadId = crypto.randomUUID();
    const pathname = `story-inputs/images/${id}/${uploadId}.${imageExtension(photo)}`;
    const blob = await uploadPresigned(pathname, photo, {
      access: "private",
      handleUploadUrl: "/api/story-inputs/upload",
      clientPayload: JSON.stringify({ inputId: id }),
      multipart: photo.size > 10 * 1024 * 1024,
    });
    const response = await fetch("/api/story-inputs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id,
        kind: "photo",
        name: photo.name || "가족 사진",
        imagePathname: blob.pathname,
        contentType: photo.type,
        size: photo.size,
      }),
    });
    const body = (await response.json()) as { input?: StoryInputView; error?: string; requestId?: string };
    if (!response.ok || !body.input) {
      throw new Error(`${body.error || "사진을 저장하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
    }
    return body.input;
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!file || pending) return;
    setPending(true);
    setError("");
    try {
      const input = await uploadPhoto(file);
      const response = await fetch("/api/photo-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputId: input.id, instruction: instruction.trim(), format, durationSeconds }),
      });
      const body = (await response.json()) as PhotoVideoResponse;
      if (!response.ok || !body.episodeId || !body.generation) {
        throw new Error(`${body.error || "사진 영상 생성을 시작하지 못했습니다."}${body.requestId ? ` (문의 번호: ${body.requestId})` : ""}`);
      }
      router.push(`/studio?episode=${body.episodeId}&shot=1-1`);
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "사진 영상 생성 중 문제가 생겼습니다.");
      setPending(false);
    }
  }

  return (
    <form className="photo-video-card" onSubmit={handleSubmit} aria-busy={pending}>
      <div className="photo-video-heading">
        <span className="eyebrow">PHOTO TO VIDEO</span>
        <h2>사진 한 장을 바로 영상으로</h2>
        <p>스토리 구성 없이 사진 속 모습과 그림체를 그대로 유지해 짧은 LTX 영상을 만듭니다.</p>
      </div>

      {previewUrl && file ? (
        <div className="photo-video-preview">
          <Image src={previewUrl} alt={file.name || "선택한 사진"} fill sizes="(max-width: 640px) 88vw, 520px" unoptimized />
          <button type="button" aria-label="선택한 사진 삭제" disabled={pending} onClick={clearPhoto}>×</button>
        </div>
      ) : (
        <label className="photo-video-picker" htmlFor="photo-video-file">
          <span aria-hidden="true">＋</span>
          <strong>움직이게 만들 사진 선택</strong>
          <small>JPG, PNG, WebP · 최대 20MB</small>
        </label>
      )}
      <input
        className="visually-hidden"
        id="photo-video-file"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        disabled={pending}
        onChange={(event) => { selectPhoto(event.target.files?.[0] || null); event.currentTarget.value = ""; }}
      />
      {file ? <label className="photo-video-change" htmlFor="photo-video-file">다른 사진 선택</label> : null}

      <label className="photo-motion-field" htmlFor="photo-motion-instruction">
        <span>어떻게 움직일까요? <small>선택 사항</small></span>
        <textarea
          id="photo-motion-instruction"
          placeholder="예: 아이가 곰인형을 꼭 안고 살짝 웃어요. 카메라는 움직이지 않아요."
          value={instruction}
          maxLength={1000}
          disabled={pending}
          onChange={(event) => setInstruction(event.target.value)}
        />
      </label>

      <fieldset className="format-selector photo-format-selector" disabled={pending}>
        <legend>영상 형식</legend>
        <label className={format === "reels" ? "selected" : ""}>
          <input type="radio" name="photo-format" checked={format === "reels"} onChange={() => setFormat("reels")} />
          <span><strong>인스타 릴스</strong><small>9:16 세로</small></span>
        </label>
        <label className={format === "landscape" ? "selected" : ""}>
          <input type="radio" name="photo-format" checked={format === "landscape"} onChange={() => setFormat("landscape")} />
          <span><strong>가로 영상</strong><small>16:9 가로</small></span>
        </label>
      </fieldset>

      <fieldset className="photo-duration-selector" disabled={pending}>
        <legend>영상 길이</legend>
        {([4, 6, 8] as const).map((seconds) => (
          <label className={durationSeconds === seconds ? "selected" : ""} key={seconds}>
            <input type="radio" name="photo-duration" checked={durationSeconds === seconds} onChange={() => setDurationSeconds(seconds)} />
            <span>{seconds}초</span>
          </label>
        ))}
      </fieldset>

      <button className="primary-button" type="submit" disabled={!file || pending}>
        {pending ? <><span className="button-spinner" aria-hidden="true" />B200에 영상 작업을 등록하고 있어요…</> : "이 사진으로 영상 만들기"}
      </button>
      {pending ? <p className="phase-note" role="status">등록이 끝나면 생성 화면으로 이동합니다. 이후 페이지를 닫아도 B200 작업은 계속돼요.</p> : null}
      {error ? <p className="feedback" role="alert">{error}</p> : null}
    </form>
  );
}
