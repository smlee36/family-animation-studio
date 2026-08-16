import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getGeneration } from "@/lib/generations/storage";
import { listReferences } from "@/lib/references/storage";
import { hasValidSession } from "@/lib/session";

export default async function LegacyGenerationPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await hasValidSession())) redirect("/");
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const generation = await getGeneration(id);
  if (!generation || generation.status !== "ready") notFound();
  const references = await listReferences();
  const referenceById = new Map(references.map((reference) => [reference.id, reference]));

  return (
    <main className="page-shell episode-detail-page legacy-detail-page">
      <header className="studio-header compact-header">
        <Link className="brand brand-link" href="/episodes"><span className="brand-mark" aria-hidden="true">←</span><span className="brand-name">지난 이야기</span></Link>
        <Link className="quiet-button nav-link" href="/studio">새 이야기</Link>
      </header>
      <section className="episode-detail-heading">
        <p className="eyebrow">SAVED VIDEO</p>
        <h1>Shot {generation.shotId}</h1>
        <p>Episode 기능을 추가하기 전에 만든 개별 영상입니다.</p>
      </section>
      <article className="saved-shot legacy-saved-shot">
        <video controls playsInline preload="metadata" src={`/api/shots/generate/${generation.id}/video`} />
        <div className="video-actions"><a className="small-action" href={`/api/shots/generate/${generation.id}/video?download=1`}>파일 저장</a></div>
        <div className="shot-references">
          <span className="meta-label">Reference</span>
          {generation.usedReferenceIds.length ? generation.usedReferenceIds.map((referenceId) => {
            const reference = referenceById.get(referenceId);
            return <span className="reference-pill" key={referenceId}>{reference ? `${reference.category} · ${reference.name}` : "저장된 Reference"}</span>;
          }) : <span className="no-reference">텍스트로 생성</span>}
        </div>
        {generation.qc ? (
          <section className="qc-result history-qc">
            <div className="qc-heading"><div><span>GPT QC</span><strong>{generation.qc.overall}</strong><small>/ 100</small></div><span className="qc-decision approved">승인</span></div>
            <p>{generation.qc.summary}</p>
          </section>
        ) : null}
        <details className="prompt-panel"><summary>프롬프트 보기</summary><p className="saved-prompt">{generation.prompt}</p></details>
      </article>
    </main>
  );
}
