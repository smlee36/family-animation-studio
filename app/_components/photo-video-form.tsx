"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { uploadPresigned } from "@vercel/blob/client";
import { FormEvent, useEffect, useRef, useState } from "react";
import type { EpisodeFormat } from "@/lib/episodes/types";
import type { ShotGenerationView } from "@/lib/generations/types";
import type { LtxDurationSeconds, LtxRenderMode } from "@/lib/generations/types";
import type { StoryInputView } from "@/lib/story-inputs/types";

const MAX_PHOTO_BYTES = 20 * 1024 * 1024;
const MAX_PHOTO_COUNT = 10;
const PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

type SelectedPhoto = { id: string; file: File; previewUrl: string };

type PhotoVideoResponse = {
  episodeId?: string;
  generation?: ShotGenerationView;
  generations?: ShotGenerationView[];
  warning?: string;
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
  const [photos, setPhotos] = useState<SelectedPhoto[]>([]);
  const [instruction, setInstruction] = useState("");
  const [format, setFormat] = useState<EpisodeFormat>("reels");
  const [durationSeconds, setDurationSeconds] = useState<LtxDurationSeconds>(5);
  const [renderMode, setRenderMode] = useState<LtxRenderMode>("preview");
  const [highSpeedBatch, setHighSpeedBatch] = useState(true);
  const [connectPhotos, setConnectPhotos] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const photosRef = useRef(photos);

  useEffect(() => {
    photosRef.current = photos;
  }, [photos]);

  useEffect(() => () => {
    photosRef.current.forEach((photo) => URL.revokeObjectURL(photo.previewUrl));
  }, []);

  function selectPhotos(selected: FileList | null) {
    if (!selected?.length) return;
    const files = Array.from(selected);
    if (files.some((file) => !PHOTO_TYPES.has(file.type) || file.size <= 0 || file.size > MAX_PHOTO_BYTES)) {
      setError("JPG, PNG, WebP 사진만 한 장당 20MB까지 사용할 수 있어요.");
      return;
    }
    const available = MAX_PHOTO_COUNT - photos.length;
    if (available <= 0) {
      setError(`사진은 최대 ${MAX_PHOTO_COUNT}장까지 선택할 수 있어요.`);
      return;
    }
    const accepted = files.slice(0, available).map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }));
    const nextPhotos = [...photos, ...accepted];
    setPhotos(nextPhotos);
    setConnectPhotos(nextPhotos.length === 3);
    if (nextPhotos.length === 3) setDurationSeconds(10);
    if (files.length > available) {
      setError(`사진은 최대 ${MAX_PHOTO_COUNT}장까지 선택할 수 있어요. 앞의 ${available}장만 추가했습니다.`);
      return;
    }
    setError("");
  }

  function removePhoto(id: string) {
    const selected = photos.find((photo) => photo.id === id);
    if (selected) URL.revokeObjectURL(selected.previewUrl);
    const nextPhotos = photos.filter((photo) => photo.id !== id);
    setPhotos(nextPhotos);
    if (nextPhotos.length !== 3) setConnectPhotos(false);
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
    if (!photos.length || pending) return;
    setPending(true);
    setError("");
    try {
      const inputs = await Promise.all(photos.map((photo) => uploadPhoto(photo.file)));
      const response = await fetch("/api/photo-video", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inputIds: inputs.map((input) => input.id), instruction: instruction.trim(), format, durationSeconds: connectPhotos ? 10 : durationSeconds, renderMode, highSpeedBatch, connectPhotos }),
      });
      const body = (await response.json()) as PhotoVideoResponse;
      if (!response.ok || !body.episodeId) {
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
        <h2>사진 여러 장을 바로 영상으로</h2>
        <p>사진 3장은 1→2와 2→3을 각각 연결 장면으로 만든 뒤 가운데 사진에서 이어지는 10초 영상으로 만들 수 있습니다.</p>
      </div>

      {photos.length ? (
        <div className="photo-video-selection">
          <div className="photo-video-preview-grid" aria-label={`선택한 사진 ${photos.length}장`}>
            {photos.map((photo, index) => (
              <div className="photo-video-preview" key={photo.id}>
                <Image src={photo.previewUrl} alt={`${index + 1}번째 선택 사진 ${photo.file.name}`} fill sizes="(max-width: 640px) 42vw, 240px" unoptimized />
                <span>{index + 1}</span>
                <button type="button" aria-label={`${photo.file.name} 삭제`} disabled={pending} onClick={() => removePhoto(photo.id)}>×</button>
              </div>
            ))}
          </div>
          <label className="photo-video-change" htmlFor="photo-video-file">＋ 사진 더 추가 ({photos.length}/{MAX_PHOTO_COUNT})</label>
        </div>
      ) : (
        <label className="photo-video-picker" htmlFor="photo-video-file">
          <span aria-hidden="true">＋</span>
          <strong>움직이게 만들 사진 여러 장 선택</strong>
          <small>JPG, PNG, WebP · 최대 10장 · 장당 20MB</small>
        </label>
      )}
      <input
        className="visually-hidden"
        id="photo-video-file"
        type="file"
        multiple
        accept="image/jpeg,image/png,image/webp"
        disabled={pending}
        onChange={(event) => { selectPhotos(event.target.files); event.currentTarget.value = ""; }}
      />

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

      {photos.length === 3 ? (
        <fieldset className="photo-sequence-selector" disabled={pending}>
          <legend>사진 3장 만들기 방식</legend>
          <label className={connectPhotos ? "selected" : ""}>
            <input type="radio" name="photo-sequence-mode" checked={connectPhotos} onChange={() => { setConnectPhotos(true); setDurationSeconds(10); }} />
            <span><strong>10초 연결 영상 한 편</strong><small>1→2와 2→3을 시작·끝 프레임으로 고정해 자동 연결</small></span>
          </label>
          <label className={!connectPhotos ? "selected" : ""}>
            <input type="radio" name="photo-sequence-mode" checked={!connectPhotos} onChange={() => setConnectPhotos(false)} />
            <span><strong>사진별 영상 3개</strong><small>각 사진을 독립된 영상으로 생성</small></span>
          </label>
        </fieldset>
      ) : null}

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

      {connectPhotos ? (
        <div className="photo-connected-duration"><strong>최종 길이 10초</strong><small>5초 연결 장면 2개 · 같은 가운데 프레임에서 바로 연결</small></div>
      ) : (
        <fieldset className="photo-duration-selector" disabled={pending}>
          <legend>영상 길이</legend>
          {([5, 10] as const).map((seconds) => (
            <label className={durationSeconds === seconds ? "selected" : ""} key={seconds}>
              <input type="radio" name="photo-duration" checked={durationSeconds === seconds} onChange={() => setDurationSeconds(seconds)} />
              <span>{seconds}초</span>
            </label>
          ))}
        </fieldset>
      )}

      <fieldset className="photo-render-selector" disabled={pending}>
        <legend>생성 품질</legend>
        <label className={renderMode === "preview" ? "selected" : ""}>
          <input type="radio" name="photo-render-mode" checked={renderMode === "preview"} onChange={() => setRenderMode("preview")} />
          <span><strong>빠른 미리보기</strong><small>낮은 해상도 · 8단계</small></span>
        </label>
        <label className={renderMode === "final" ? "selected" : ""}>
          <input type="radio" name="photo-render-mode" checked={renderMode === "final"} onChange={() => setRenderMode("final")} />
          <span><strong>바로 고화질</strong><small>최종 저장용</small></span>
        </label>
      </fieldset>

      <label className={`photo-batch-toggle${highSpeedBatch ? " selected" : ""}`}>
        <input type="checkbox" checked={highSpeedBatch} disabled={pending} onChange={(event) => setHighSpeedBatch(event.target.checked)} />
        <span><strong>B200 고속 배치 사용</strong><small>A.X를 잠시 멈추고 LTX를 계속 GPU에 유지 · 작업 후 자동 복구</small></span>
      </label>

      <button className="primary-button" type="submit" disabled={!photos.length || pending}>
        {pending ? <><span className="button-spinner" aria-hidden="true" />B200에 {connectPhotos ? "10초 연결 영상" : `${photos.length}개 영상`} 작업을 등록하고 있어요…</> : photos.length ? connectPhotos ? `3장 연결 10초 ${renderMode === "preview" ? "미리보기" : "고화질"} 만들기` : `${photos.length}장 ${renderMode === "preview" ? "미리보기" : "고화질"} 만들기` : "사진을 선택해 주세요"}
      </button>
      {pending ? <p className="phase-note" role="status">등록이 끝나면 생성 화면으로 이동합니다. 이후 페이지를 닫아도 B200 작업은 계속돼요.</p> : null}
      {error ? <p className="feedback" role="alert">{error}</p> : null}
    </form>
  );
}
