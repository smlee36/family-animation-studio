import { redirect } from "next/navigation";
import { Studio } from "@/app/_components/studio";
import { getEnvironmentStatus } from "@/lib/env";
import { getEpisode } from "@/lib/episodes/storage";
import type { EpisodeStudioState } from "@/lib/episodes/types";
import { getGeneration } from "@/lib/generations/storage";
import { generationView } from "@/lib/generations/types";
import { listReferences } from "@/lib/references/storage";
import { hasValidSession } from "@/lib/session";
import { getStoryInputs } from "@/lib/story-inputs/storage";
import { storyInputView } from "@/lib/story-inputs/types";

export default async function StudioPage({ searchParams }: { searchParams: Promise<{ episode?: string; shot?: string }> }) {
  if (!(await hasValidSession())) redirect("/");
  const environment = getEnvironmentStatus();
  const resolvedSearchParams = await searchParams;
  const episodeId = resolvedSearchParams.episode || "";
  const focusShot = typeof resolvedSearchParams.shot === "string" && /^[a-z0-9-]{1,40}$/i.test(resolvedSearchParams.shot)
    ? resolvedSearchParams.shot
    : "";
  let initialEpisode: EpisodeStudioState | null = null;

  if (/^[0-9a-f-]{36}$/i.test(episodeId)) {
    const episode = await getEpisode(episodeId);
    if (episode) {
      const [allReferences, generationEntries, generationVersionEntries, storyboardInputs] = await Promise.all([
        listReferences(),
        Promise.all(Object.entries(episode.generationIdsByShot).map(async ([shotId, generationId]) => {
          const generation = await getGeneration(generationId);
          return generation ? [shotId, generationView(generation)] as const : null;
        })),
        Promise.all(Object.entries(episode.generationHistoryIdsByShot || {}).map(async ([shotId, generationIds]) => {
          const records = await Promise.all(generationIds.map((generationId) => getGeneration(generationId)));
          return [shotId, records.filter((record): record is NonNullable<typeof record> => Boolean(record)).map(generationView)] as const;
        })),
        getStoryInputs(episode.storyboardInputIds || []),
      ]);
      initialEpisode = {
        episode,
        references: allReferences.map(({ id, name, category, description }) => ({ id, name, category, description })),
        generations: Object.fromEntries(generationEntries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))),
        generationVersions: Object.fromEntries(generationVersionEntries),
        storyboardInputs: storyboardInputs.map(storyInputView).filter((input) => input.kind === "storyboard"),
      };
    }
  }

  return <Studio environmentReady={environment.readyForPhaseOne} initialEpisode={initialEpisode} focusShot={focusShot} />;
}
