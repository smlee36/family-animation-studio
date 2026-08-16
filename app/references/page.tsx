import { redirect } from "next/navigation";
import { ReferenceLibrary } from "@/app/_components/reference-library";
import { hasValidSession } from "@/lib/session";

export default async function ReferencesPage() {
  if (!(await hasValidSession())) redirect("/");
  return <ReferenceLibrary />;
}
