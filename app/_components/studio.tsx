"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

const DRAFT_KEY = "family-studio-story-draft";

export function Studio({ environmentReady }: { environmentReady: boolean }) {
  const router = useRouter();
  const [story, setStory] = useState("");
  const [notice, setNotice] = useState("");

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!story.trim()) return;
    setNotice("이야기 입력을 확인했습니다. Scene 자동 구성은 Phase 3에서 연결됩니다.");
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/");
    router.refresh();
  }

  return (
    <main className="page-shell">
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

      <form className="story-card" onSubmit={handleSubmit}>
        <textarea
          className="story-input"
          aria-label="오늘의 가족 이야기"
          placeholder="오늘 있었던 일을 처음부터 끝까지 편하게 적어주세요."
          value={story}
          onChange={(event) => {
            const nextStory = event.target.value;
            setStory(nextStory);
            setNotice("");
            if (nextStory) sessionStorage.setItem(DRAFT_KEY, nextStory);
            else sessionStorage.removeItem(DRAFT_KEY);
          }}
          maxLength={12000}
        />
        <div className="story-helper"><span>길게 적어도 괜찮아요</span><span>{story.length.toLocaleString()} / 12,000</span></div>
        <button className="primary-button" type="submit" disabled={!story.trim()}>전체 이야기 만들기</button>
        {notice ? <p className="phase-note" role="status">{notice}</p> : null}
      </form>

      <div className="readiness" aria-label={environmentReady ? "서버 준비 완료" : "서버 설정 확인 필요"}>
        <span className={`status-dot${environmentReady ? " ready" : ""}`} aria-hidden="true" />
        {environmentReady ? "가족 전용 서버 연결됨" : "서버 환경설정을 확인해 주세요"}
      </div>
    </main>
  );
}
