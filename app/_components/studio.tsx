"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FormEvent, useMemo, useState } from "react";
import type { DirectorPlan, DirectorReference } from "@/lib/director/types";

const DRAFT_KEY = "family-studio-story-draft";

type DirectorApiResponse = {
  plan?: DirectorPlan;
  references?: DirectorReference[];
  error?: string;
  requestId?: string;
};

function formatDuration(totalSeconds: number) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (!minutes) return `약 ${seconds}초`;
  return `약 ${minutes}분${seconds ? ` ${seconds}초` : ""}`;
}

export function Studio({ environmentReady }: { environmentReady: boolean }) {
  const router = useRouter();
  const [story, setStory] = useState("");
  const [plan, setPlan] = useState<DirectorPlan | null>(null);
  const [references, setReferences] = useState<DirectorReference[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const referenceById = useMemo(() => new Map(references.map((reference) => [reference.id, reference])), [references]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedStory = story.trim();
    if (trimmedStory.length < 10 || pending) {
      if (trimmedStory.length < 10) setError("이야기를 조금 더 자세히 들려주세요.");
      return;
    }

    setPending(true);
    setError("");
    setPlan(null);
    try {
      const response = await fetch("/api/director", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ story: trimmedStory }),
      });
      const body = (await response.json()) as DirectorApiResponse;
      if (!response.ok || !body.plan) {
        const suffix = body.requestId ? ` (문의 번호: ${body.requestId})` : "";
        throw new Error(`${body.error || "이야기를 구성하지 못했습니다."}${suffix}`);
      }
      setPlan(body.plan);
      setReferences(body.references || []);
      sessionStorage.removeItem(DRAFT_KEY);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "이야기를 구성하지 못했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
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

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="page-shell studio-page">
      <header className="studio-header">
        <div className="brand"><span className="brand-mark" aria-hidden="true">✦</span> Animation Studio</div>
        <div className="header-actions">
          <Link className="quiet-button nav-link" href="/references">자료실</Link>
          <button className="quiet-button" type="button" onClick={logout}>나가기</button>
        </div>
      </header>

      <section className="studio-intro">
        <h1 className="studio-title">오늘 이야기를<br />들려주세요</h1>
        <p className="studio-copy">하루 동안 있었던 일을 편하게 적어주세요. 장면과 영상 구성은 스튜디오가 알아서 준비합니다.</p>
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
        <div className="story-helper"><span>길게 적어도 괜찮아요</span><span>{story.length.toLocaleString()} / 12,000</span></div>
        <button className="primary-button" type="submit" disabled={story.trim().length < 10 || pending}>
          {pending ? <><span className="button-spinner" aria-hidden="true" />이야기 구성 중…</> : "전체 이야기 만들기"}
        </button>
        {pending ? <p className="phase-note" role="status">AI Director가 상황별 Scene과 한 가지 행동 중심의 Shot을 구성하고 있어요.</p> : null}
        {error ? <p className="feedback" role="alert">{error}</p> : null}
      </form>

      {plan ? (
        <section className="episode-plan" aria-labelledby="episode-plan-title">
          <div className="plan-heading">
            <p className="eyebrow">DIRECTOR PLAN</p>
            <h2 id="episode-plan-title">{plan.title}</h2>
            <p>{plan.summary}</p>
          </div>
          <div className="plan-metrics" aria-label="이야기 구성 요약">
            <div><strong>{plan.scenes.length}</strong><span>Scenes</span></div>
            <div><strong>{plan.totalShots}</strong><span>Video Shots</span></div>
            <div><strong>{formatDuration(plan.totalEstimatedSeconds)}</strong><span>예상 완성 길이</span></div>
          </div>

          <div className="scene-list">
            {plan.scenes.map((scene, sceneIndex) => (
              <details className="scene-accordion" key={scene.id} open={sceneIndex === 0}>
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
                  <div className="shot-list">
                    {scene.shots.map((shot) => {
                      const selectedReferences = shot.referenceIds
                        .map((id) => referenceById.get(id))
                        .filter((reference): reference is DirectorReference => Boolean(reference));
                      return (
                        <article className="shot-card" key={shot.id}>
                          <div className="shot-heading">
                            <div>
                              <span className="shot-number">SHOT {shot.id}</span>
                              <h3>{shot.title}</h3>
                            </div>
                            <span className="shot-duration">{shot.estimatedSeconds}초</span>
                          </div>
                          <p className="shot-action">{shot.action}</p>
                          <div className="continuity-row">
                            <span><b>시작</b>{shot.startState}</span>
                            <span className="continuity-arrow" aria-hidden="true">→</span>
                            <span><b>끝</b>{shot.endState}</span>
                          </div>
                          <div className="shot-references">
                            <span className="meta-label">Reference</span>
                            {selectedReferences.length ? selectedReferences.map((reference) => (
                              <span className="reference-pill" key={reference.id}>{reference.category} · {reference.name}</span>
                            )) : <span className="no-reference">텍스트로 생성</span>}
                          </div>
                          {shot.referenceReason ? <p className="reference-reason">{shot.referenceReason}</p> : null}
                          <details className="prompt-panel">
                            <summary>프롬프트 보기·수정</summary>
                            <textarea
                              aria-label={`Shot ${shot.id} 프롬프트`}
                              value={shot.prompt}
                              onChange={(event) => updatePrompt(scene.id, shot.id, event.target.value)}
                            />
                          </details>
                        </article>
                      );
                    })}
                  </div>
                </div>
              </details>
            ))}
          </div>
        </section>
      ) : null}

      <div className="readiness" aria-label={environmentReady ? "서버 준비 완료" : "서버 설정 확인 필요"}>
        <span className={`status-dot${environmentReady ? " ready" : ""}`} aria-hidden="true" />
        {environmentReady ? "가족 전용 서버 연결됨" : "서버 환경설정을 확인해 주세요"}
      </div>
    </main>
  );
}
