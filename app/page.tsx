import { redirect } from "next/navigation";
import { LoginForm } from "@/app/_components/login-form";
import { hasValidSession } from "@/lib/session";

export default async function LoginPage() {
  if (await hasValidSession()) redirect("/studio");

  return (
    <main className="page-shell login-page">
      <section className="login-card" aria-labelledby="login-title">
        <div className="brand"><span className="brand-mark" aria-hidden="true">✦</span> 우리집 Animation Studio</div>
        <h1 className="login-title" id="login-title">우리 가족의 이야기를<br />영상으로 남겨요.</h1>
        <p className="login-copy">부부만 함께 사용하는 비공개 가족 애니메이션 스튜디오입니다.</p>
        <LoginForm />
      </section>
    </main>
  );
}
