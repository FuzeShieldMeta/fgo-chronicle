import chapters from "~/data/story-chapters.json";

export type StoryChapter = (typeof chapters)[number];

export const storyChapters = chapters;
export const mainStoryChapters = chapters.filter(
  (chapter) => !chapter.optional,
);
export const optionalStoryChapters = chapters.filter(
  (chapter) => chapter.optional,
);

export type StoryProgress = {
  mainWarId: number | null;
  optionalWarIds: number[];
};

export function hasCompletedStory(
  warId: number,
  progress: StoryProgress,
  catalogue: StoryChapter[] = storyChapters,
): boolean | null {
  const chapter = catalogue.find((chapter) => chapter.warId === warId);
  if (!chapter) return null;
  if (chapter.optional) return progress.optionalWarIds.includes(warId);
  if (progress.mainWarId === null) return null;
  if (progress.mainWarId === 0) return false;
  const mainStoryChapters = catalogue.filter((chapter) => !chapter.optional);
  const currentIndex = mainStoryChapters.findIndex(
    (item) => item.warId === progress.mainWarId,
  );
  const targetIndex = mainStoryChapters.findIndex(
    (item) => item.warId === warId,
  );
  return currentIndex < 0 ? null : targetIndex <= currentIndex;
}
