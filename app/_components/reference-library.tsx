"use client";

import Image from "next/image";
import Link from "next/link";
import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { uploadPresigned } from "@vercel/blob/client";
import {
  REFERENCE_CATEGORIES,
  type ReferenceCategory,
  type ReferenceRecord,
} from "@/lib/references/types";

type PendingImage = { key: string; file: File; name: string };

function imageExtension(file: File) {
  const fromName = file.name.split(".").pop()?.toLowerCase();
  if (fromName && ["jpg", "jpeg", "png", "webp", "avif", "heic", "heif"].includes(fromName)) return fromName;
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/heic": "heic",
    "image/heif": "heif",
  } as Record<string, string>)[file.type] || "jpg";
}

function defaultImageName(file: File) {
  return file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "새 Reference";
}

export function ReferenceLibrary() {
  const [references, setReferences] = useState<ReferenceRecord[]>([]);
  const [filter, setFilter] = useState<ReferenceCategory | "전체">("전체");
  const [showUpload, setShowUpload] = useState(false);
  const [category, setCategory] = useState<ReferenceCategory>("아이");
  const [description, setDescription] = useState("");
  const [pendingImages, setPendingImages] = useState<PendingImage[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const replacingIds = useRef(new Set<string>());

  const loadReferences = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/references", { cache: "no-store" });
      const result = (await response.json()) as { references?: ReferenceRecord[]; error?: string };
      if (!response.ok) throw new Error(result.error || "Reference 목록을 불러오지 못했습니다.");
      setReferences(result.references || []);
      setError("");
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : "Reference 목록을 불러오지 못했습니다.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialTimer = window.setTimeout(() => void loadReferences(), 0);
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") void loadReferences(true);
    };
    const refreshTimer = window.setInterval(() => {
      refreshWhenVisible();
    }, 30000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [loadReferences]);

  function selectFiles(files: FileList | null) {
    if (!files) return;
    const selected = Array.from(files).map((file) => ({
      key: crypto.randomUUID(),
      file,
      name: defaultImageName(file),
    }));
    setPendingImages(selected);
    setError("");
    setMessage("");
  }

  async function uploadAndSave(file: File, metadata: Pick<ReferenceRecord, "id" | "name" | "description" | "category">) {
    const uploadId = crypto.randomUUID();
    const pathname = `references/images/${metadata.id}/${uploadId}.${imageExtension(file)}`;
    const blob = await uploadPresigned(pathname, file, {
      access: "private",
      handleUploadUrl: "/api/references/upload",
      clientPayload: JSON.stringify({ referenceId: metadata.id }),
      multipart: file.size > 10 * 1024 * 1024,
    });

    const response = await fetch("/api/references", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...metadata,
        imagePathname: blob.pathname,
        originalFilename: file.name,
      }),
    });
    const result = (await response.json()) as { reference?: ReferenceRecord; error?: string };
    if (!response.ok || !result.reference) throw new Error(result.error || "Reference를 저장하지 못했습니다.");
    return result.reference;
  }

  async function submitUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!pendingImages.length || saving) return;
    setSaving(true);
    setError("");
    setMessage(`0 / ${pendingImages.length}장 등록 중…`);

    try {
      for (let index = 0; index < pendingImages.length; index += 1) {
        const pending = pendingImages[index];
        if (!pending.name.trim()) throw new Error("각 이미지의 이름을 입력해 주세요.");
        await uploadAndSave(pending.file, {
          id: crypto.randomUUID(),
          name: pending.name.trim(),
          description: description.trim(),
          category,
        });
        setMessage(`${index + 1} / ${pendingImages.length}장 등록 중…`);
      }
      setMessage(`${pendingImages.length}장을 가족 Reference Library에 등록했습니다.`);
      setPendingImages([]);
      setDescription("");
      setShowUpload(false);
      await loadReferences(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "업로드 중 문제가 생겼습니다.");
      setMessage("");
      await loadReferences(true);
    } finally {
      setSaving(false);
    }
  }

  async function replaceImage(reference: ReferenceRecord, file: File | undefined) {
    if (!file || replacingIds.current.has(reference.id)) return;
    replacingIds.current.add(reference.id);
    setMessage(`${reference.name} 이미지를 교체하는 중…`);
    setError("");
    try {
      await uploadAndSave(file, reference);
      setMessage(`${reference.name} 이미지를 교체했습니다.`);
      await loadReferences(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "이미지를 교체하지 못했습니다.");
      setMessage("");
    } finally {
      replacingIds.current.delete(reference.id);
    }
  }

  async function deleteReference(reference: ReferenceRecord) {
    if (!window.confirm(`“${reference.name}” Reference를 삭제할까요?`)) return;
    setError("");
    const response = await fetch(`/api/references/${reference.id}`, { method: "DELETE" });
    if (!response.ok) {
      const result = (await response.json()) as { error?: string };
      setError(result.error || "Reference를 삭제하지 못했습니다.");
      return;
    }
    setMessage(`${reference.name} Reference를 삭제했습니다.`);
    setReferences((current) => current.filter((item) => item.id !== reference.id));
  }

  const visibleReferences = filter === "전체" ? references : references.filter((reference) => reference.category === filter);

  return (
    <main className="page-shell references-page">
      <header className="studio-header compact-header">
        <Link className="brand brand-link" href="/studio"><span className="brand-mark" aria-hidden="true">✦</span> Animation Studio</Link>
        <Link className="quiet-button nav-link" href="/studio">이야기</Link>
      </header>

      <section className="library-heading">
        <div>
          <p className="eyebrow">가족 공동 자료실</p>
          <h1 className="studio-title">Master References</h1>
          <p className="studio-copy">캐릭터·장소·소품 이미지를 여러 장 모아두면 이후 Director가 Shot에 맞는 자료를 자동 선택합니다. 다른 휴대폰의 변경도 화면을 다시 열면 바로 반영됩니다.</p>
        </div>
        <button className="add-reference-button" type="button" onClick={() => setShowUpload((value) => !value)}>
          {showUpload ? "닫기" : "+ 이미지 등록"}
        </button>
      </section>

      {showUpload ? (
        <form className="upload-card" onSubmit={submitUpload}>
          <label className="field-label" htmlFor="reference-category">카테고리</label>
          <select className="select-input" id="reference-category" value={category} onChange={(event) => setCategory(event.target.value as ReferenceCategory)}>
            {REFERENCE_CATEGORIES.map((item) => <option key={item}>{item}</option>)}
          </select>

          <label className="field-label" htmlFor="reference-files">이미지</label>
          <label className="file-drop" htmlFor="reference-files">
            <strong>여러 이미지를 한 번에 선택</strong>
            <span>JPG, PNG, WebP, AVIF, HEIC · 장당 최대 20MB</span>
          </label>
          <input
            className="visually-hidden"
            id="reference-files"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
            multiple
            onChange={(event) => selectFiles(event.target.files)}
          />

          {pendingImages.length ? (
            <div className="pending-list">
              {pendingImages.map((pending, index) => (
                <label className="pending-item" key={pending.key}>
                  <span>{index + 1}</span>
                  <input
                    className="inline-name-input"
                    value={pending.name}
                    maxLength={80}
                    aria-label={`${index + 1}번째 이미지 이름`}
                    onChange={(event) => setPendingImages((current) => current.map((item) => item.key === pending.key ? { ...item, name: event.target.value } : item))}
                  />
                </label>
              ))}
            </div>
          ) : null}

          <label className="field-label" htmlFor="reference-description">설명 <span className="optional">선택</span></label>
          <textarea
            className="description-input"
            id="reference-description"
            placeholder="표정, 의상, 촬영 각도처럼 Director가 알아야 할 내용을 적어주세요."
            value={description}
            maxLength={500}
            onChange={(event) => setDescription(event.target.value)}
          />
          <button className="primary-button" type="submit" disabled={!pendingImages.length || saving}>
            {saving ? "등록 중…" : pendingImages.length ? `${pendingImages.length}장 등록하기` : "이미지를 선택해 주세요"}
          </button>
        </form>
      ) : null}

      {message ? <p className="phase-note" role="status">{message}</p> : null}
      {error ? <p className="feedback" role="alert">{error}</p> : null}

      <div className="category-strip" aria-label="Reference 카테고리">
        {(["전체", ...REFERENCE_CATEGORIES] as const).map((item) => (
          <button className={`category-chip${filter === item ? " active" : ""}`} type="button" key={item} onClick={() => setFilter(item)}>
            {item}
          </button>
        ))}
      </div>

      {loading ? <div className="library-empty">Reference 목록을 불러오는 중…</div> : visibleReferences.length ? (
        <section className="reference-grid" aria-live="polite">
          {visibleReferences.map((reference) => (
            <article className="reference-card" key={reference.id}>
              <div className="reference-image">
                <Image
                  src={`/api/references/${reference.id}/image?v=${encodeURIComponent(reference.updatedAt)}`}
                  alt={reference.name}
                  fill
                  sizes="(max-width: 520px) 50vw, 230px"
                  unoptimized
                />
              </div>
              <div className="reference-body">
                <span className="reference-category">{reference.category}</span>
                <h2>{reference.name}</h2>
                {reference.description ? <p>{reference.description}</p> : null}
                <time dateTime={reference.uploadedAt}>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(reference.uploadedAt))}</time>
                <div className="reference-actions">
                  <label className="small-action">
                    교체
                    <input
                      className="visually-hidden"
                      type="file"
                      accept="image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
                      onChange={(event) => void replaceImage(reference, event.target.files?.[0])}
                    />
                  </label>
                  <button className="small-action danger-action" type="button" onClick={() => void deleteReference(reference)}>삭제</button>
                </div>
              </div>
            </article>
          ))}
        </section>
      ) : (
        <div className="library-empty">
          <span aria-hidden="true">▧</span>
          <strong>{filter === "전체" ? "아직 등록된 Reference가 없어요" : `${filter} Reference가 아직 없어요`}</strong>
          <p>첫 이미지를 등록하면 두 사람의 휴대폰에서 함께 볼 수 있습니다.</p>
        </div>
      )}
    </main>
  );
}
