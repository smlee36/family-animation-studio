"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!passcode || pending) return;
    setPending(true);
    setError("");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      const result = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(result.error || "입장할 수 없습니다.");
      router.replace("/studio");
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "잠시 후 다시 시도해 주세요.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={handleSubmit}>
      <label className="field-label" htmlFor="family-passcode">가족 비밀번호</label>
      <input
        className="text-input"
        id="family-passcode"
        type="password"
        value={passcode}
        onChange={(event) => setPasscode(event.target.value)}
        autoComplete="current-password"
        enterKeyHint="go"
        maxLength={128}
        required
      />
      <button className="primary-button" type="submit" disabled={!passcode || pending}>
        {pending ? "확인 중…" : "입장"}
      </button>
      {error ? <p className="feedback" role="alert">{error}</p> : null}
    </form>
  );
}
