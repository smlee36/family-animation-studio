import Image from "next/image";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getEpisode } from "@/lib/episodes/storage";
import { getGeneration } from "@/lib/generations/storage";
import type { ShotGenerationRecord } from "@/lib/generations/types";
import { listReferences } from "@/lib/references/storage";
import { hasValidSession } from "@/lib/session";
import { getStoryInputs } from "@/lib/story-inputs/storage";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "long", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(value));
}

function QcResult({ generation }: { generation: ShotGenerationRecord }) {
  if (!generation.qc) return null;
  const { scores } = generation.qc;
  return (
    <section className="qc-result history-qc" aria-label={`Shot ${generation.shotId} 품질 검수`}>
      <div className="qc-heading">
        <div><span>GPT QC</span><strong>{generation.qc.overall}</strong><small>/ 100</small></div>
        <span className={`qc-decision ${generation.approvalStatus || "pending"}`}>{generation.approvalStatus === "approved" ? "승인" : "확인 필요"}</span>
      </div>
      <div className="qc-score-grid">
        <span>캐릭터 <b>{scores.characterConsistency}</b></span><span>얼굴 <b>{scores.faceStability}</b></span>
        <span>손·신체 <b>{scores.handsBody}</b></span><span>배경 <b>{scores.backgroundConsistency}</b></span>
        <span>소품 <b>{scores.objectConsistency}</b></span><span>움직임 <b>{scores.motionNaturalness}</b></span>
        <span>Reference <b>{scores.referenceMatch}</b></span><span>연결성 <b>{scores.continuity}</b></span>
      </div>
      <p>{generation.qc.summary}</p>
    </section>
  );
}

export default async function EpisodeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasValidSession())) redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const episode = await getEpisode(id);
  if (!episode) notFound();

  const [references, generationEntries, storyboardInputs] = await Promise.all([
    listReferences(),
    Promise.all(Object.entries(episode.generationIdsByShot).map(async ([shotId, generationId]) => [shotId, await getGeneration(generationId)] as const)),
    getStoryInputs(episode.storyboardInputIds || []),
  ]);
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));
  const generationByShot = new Map(generationEntries.filter((entry): entry is readonly [string, ShotGenerationRecord] => Boolean(entry[1])));

  return (
    <main className="page-shell episode-detail-page">
      <header className="studio-header compact-header">
        <Link className="brand brand-link" href="/episodes"><span className="brand-mark" aria-hidden="true">←</span><span className="brand-name">지난 이야기</span></Link>
        <div className="header-actions">
          <Link className="quiet-button nav-link" href={`/studio?episode=${episode.id}`}>이어서 만들기</Link>
          <Link className="quiet-button nav-link" href="/studio">새 이야기</Link>
        </div>
      </header>

      <section className="episode-detail-heading">
        <p className="eyebrow">SAVED EPISODE</p>
        <h1>{episode.title}</h1>
        <time dateTime={episode.updatedAt}>{dateLabel(episode.updatedAt)}</time>
        <p>{episode.plan?.summary || episode.story}</p>
      </section>

      {storyboardInputs.length ? (
        <section className="saved-storyboards" aria-labelledby="saved-storyboards-title">
          <h2 id="saved-storyboards-title">입력 스토리보드</h2>
          <div className="saved-storyboard-grid">
            {storyboardInputs.map((input) => (
              <a href={`/api/story-inputs/${input.id}/image`} target="_blank" rel="noreferrer" key={input.id}>
                <Image src={`/api/story-inputs/${input.id}/image`} alt={input.name} fill sizes="(max-width: 560px) 44vw, 260px" unoptimized />
              </a>
            ))}
          </div>
        </section>
      ) : null}

      {episode.story ? (
        <details className="saved-story-panel">
          <summary>원래 이야기 보기</summary>
          <p>{episode.story}</p>
        </details>
      ) : null}

      {episode.plan ? (
        <div className="saved-scene-list">
          {episode.plan.scenes.map((scene) => (
            <details className="saved-scene" key={scene.id}>
              <summary><span>SCENE {String(scene.number).padStart(2, "0")}</span><strong>{scene.title}</strong><small>{scene.shots.length} Shots</small></summary>
              <div className="saved-scene-body">
                <p>{scene.summary}</p>
                {episode.sceneFrames?.[scene.id] ? (
                  <section className="saved-scene-frame" aria-label={`${scene.title} 기준 이미지`}>
                    <div>
                      <strong>9:16 Scene 기준 이미지</strong>
                      <span>{episode.sceneFrames[scene.id].approvalStatus === "approved" ? "승인 완료" : "확인 필요"}</span>
                    </div>
                    <div className="scene-frame-image">
                      <Image
                        src={`/api/episodes/${episode.id}/scenes/${scene.id}/frame?v=${episode.sceneFrames[scene.id].id}`}
                        alt={`${scene.title} 기준 이미지`}
                        fill
                        sizes="(max-width: 640px) 88vw, 360px"
                        unoptimized
                      />
                    </div>
                  </section>
                ) : null}
                {scene.shots.map((shot) => {
                  const generation = generationByShot.get(shot.id);
                  return (
                    <article className="saved-shot" key={shot.id}>
                      <div className="saved-shot-heading">
                        <div><span className="shot-number">SHOT {shot.id}</span><h3>{shot.title}</h3></div>
                        <span className={`saved-shot-state ${generation?.status || "empty"}`}>{generation?.status === "ready" ? "영상 완료" : generation?.status === "generating" ? "생성 중" : generation?.status === "failed" ? "생성 실패" : "영상 전"}</span>
                      </div>
                      <p>{shot.action}</p>
                      <div className="shot-references">
                        <span className="meta-label">고정 기준</span>
                        {shot.referenceIds.length ? shot.referenceIds.map((referenceId) => {
                          const reference = referenceById.get(referenceId);
                          return <span className="reference-pill" key={referenceId}>{reference ? `${reference.category} · ${reference.name}` : "저장된 Reference"}</span>;
                        }) : <span className="no-reference">직접 전달 이미지 없음</span>}
                      </div>
                      {generation?.status === "ready" ? (
                        <div className="shot-video-result">
                          <video className={generation.aspectRatio === "9:16" ? "portrait-video" : undefined} controls playsInline preload="metadata" src={`/api/shots/generate/${generation.id}/video`} />
                          <div className="video-actions">
                            <a className="small-action" href={`/api/shots/generate/${generation.id}/video?download=1`}>파일 저장</a>
                            <Link className="small-action nav-link" href={`/studio?episode=${episode.id}&shot=${encodeURIComponent(shot.id)}#shot-${encodeURIComponent(shot.id)}`}>
                              {generation.approvalStatus === "approved" ? "승인 영상 수정" : "이 영상 수정"}
                            </Link>
                          </div>
                          <QcResult generation={generation} />
                        </div>
                      ) : null}
                      <details className="prompt-panel"><summary>프롬프트 보기</summary><p className="saved-prompt">{generation?.prompt || shot.prompt}</p></details>
                    </article>
                  );
                })}
              </div>
            </details>
          ))}
        </div>
      ) : (
        <p className="feedback">{episode.error || "아직 Scene 구성이 완료되지 않았습니다."}</p>
      )}
    </main>
  );
}
