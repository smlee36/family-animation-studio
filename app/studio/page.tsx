import { redirect } from "next/navigation";
import { Studio } from "@/app/_components/studio";
import { getEnvironmentStatus } from "@/lib/env";
import { hasValidSession } from "@/lib/session";

export default async function StudioPage() {
  if (!(await hasValidSession())) redirect("/");
  const environment = getEnvironmentStatus();

  return <Studio environmentReady={environment.readyForPhaseOne} />;
}
