import Link from "next/link";
import { redirect } from "next/navigation";
import { listEpisodes } from "@/lib/episodes/storage";
import { listGenerations } from "@/lib/generations/storage";
import { hasValidSession } from "@/lib/session";

function dateLabel(value: string) {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Seoul" }).format(new Date(value));
}

export default async function EpisodesPage() {
  if (!(await hasValidSession())) redirect("/");
  const [episodes, generations] = await Promise.all([listEpisodes(), listGenerations()]);
  const generationById = new Map(generations.map((generation) => [generation.id, generation]));
  const legacyGenerations = generations.filter(
    (generation) => !generation.episodeId && generation.status === "ready" && !generation.shotId.startsWith("qc-"),
  );

  return (
    <main className="page-shell history-page">
      <header className="studio-header compact-header">
        <Link className="brand brand-link" href="/studio">
          <span className="brand-mark" aria-hidden="true">✦</span>
          <span className="brand-name">Animation Studio</span>
        </Link>
        <div className="header-actions">
          <Link className="quiet-button nav-link" href="/studio">새 이야기</Link>
          <Link className="quiet-button nav-link" href="/references">자료실</Link>
        </div>
      </header>

      <section className="history-heading">
        <p className="eyebrow">FAMILY ARCHIVE</p>
        <h1 className="studio-title">지난 이야기</h1>
        <p className="studio-copy">부부가 만든 Episode와 영상, 프롬프트, QC 결과가 함께 보관됩니다.</p>
      </section>

      {episodes.length ? (
        <div className="episode-history-list">
          {episodes.map((episode) => {
            const totalShots = episode.plan?.totalShots || 0;
            const shotGenerations = Object.values(episode.generationIdsByShot)
              .map((id) => generationById.get(id))
              .filter((generation) => Boolean(generation));
            const readyCount = shotGenerations.filter((generation) => generation?.status === "ready").length;
            const approvedCount = shotGenerations.filter((generation) => generation?.approvalStatus === "approved").length;
            return (
              <Link className="episode-history-card" href={`/episodes/${episode.id}`} key={episode.id}>
                <div className="episode-history-topline">
                  <time dateTime={episode.updatedAt}>{dateLabel(episode.updatedAt)}</time>
                  <span className={`episode-status ${episode.status}`}>{episode.status === "ready" ? "저장됨" : episode.status === "planning" ? "구성 중" : "확인 필요"}</span>
                </div>
                <h2>{episode.title}</h2>
                <p>{episode.plan?.summary || episode.story}</p>
                <div className="episode-history-metrics">
                  <span>{episode.plan?.scenes.length || 0} Scenes</span>
                  <span>{readyCount}/{totalShots} 영상</span>
                  <span>{approvedCount} 승인</span>
                </div>
              </Link>
            );
          })}
        </div>
      ) : (
        <div className="library-empty history-empty">
          <span aria-hidden="true">◇</span>
          <strong>저장된 Episode가 아직 없어요</strong>
          <p>새 이야기를 구성하면 이곳에 자동으로 저장됩니다.</p>
          <Link className="primary-link" href="/studio">첫 이야기 만들기</Link>
        </div>
      )}

      {legacyGenerations.length ? (
        <section className="legacy-history" aria-labelledby="legacy-history-title">
          <div className="section-heading-row">
            <div>
              <p className="eyebrow">EARLIER SHOTS</p>
              <h2 id="legacy-history-title">이전 개별 영상</h2>
            </div>
            <span>{legacyGenerations.length}개</span>
          </div>
          <div className="legacy-generation-grid">
            {legacyGenerations.map((generation) => (
              <Link className="legacy-generation-card" href={`/episodes/generation/${generation.id}`} key={generation.id}>
                <span className={`model-tier ${generation.model.includes("omni") ? "omni" : generation.qualityTier || "standard"}`}>{generation.model.includes("omni") ? "OMNI" : (generation.qualityTier || "standard").toUpperCase()}</span>
                <strong>Shot {generation.shotId}</strong>
                <small>{dateLabel(generation.updatedAt)} · {generation.durationSeconds}초</small>
                <span className="history-qc-score">{generation.qc ? `QC ${generation.qc.overall}` : "QC 대기"}</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}
    </main>
  );
}
