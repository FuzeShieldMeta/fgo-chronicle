import { buildStoryCatalogue } from "./story-catalogue.mjs";

/** @param {number} questId @param {Array<Record<string, any>>} wars @param {ReturnType<typeof buildStoryCatalogue>["chapters"]} chapters */
function chapterForQuest(questId, wars, chapters) {
  return (
    chapters.find((/** @type {Record<string, any>} */ chapter) => {
      const war = wars.find((war) => war.id === chapter.warId);
      if (
        !war ||
        !war.flags?.includes("mainScenario") ||
        war.lastQuestId !== chapter.lastQuestId ||
        (war.originalLongName ?? war.longName) !== chapter.originalName
      )
        return false;
      if (questId === chapter.lastQuestId) return true;
      const quests = (war.spots ?? []).flatMap(
        (/** @type {Record<string, any>} */ spot) => spot.quests ?? [],
      );
      const target = quests.find(
        (/** @type {Record<string, any>} */ quest) => quest.id === questId,
      );
      const last = quests.find(
        (/** @type {Record<string, any>} */ quest) =>
          quest.id === chapter.lastQuestId,
      );
      if (
        !target ||
        !last ||
        target.type !== "main" ||
        target.warId !== chapter.warId
      )
        return false;
      return (
        Number.isInteger(target.chapterId) &&
        Number.isInteger(target.chapterSubId) &&
        (target.chapterId < last.chapterId ||
          (target.chapterId === last.chapterId &&
            target.chapterSubId <= last.chapterSubId))
      );
    }) ?? null
  );
}

/** Map an explicit main-quest completion condition to its parent story.
 * @param {Record<string, any>} mission
 * @param {Array<Record<string, any>>} wars
 * @param {ReturnType<typeof buildStoryCatalogue>["chapters"]} [chapters]
 */
export function storyMissionRequirement(
  mission,
  wars,
  chapters = buildStoryCatalogue(wars).chapters,
) {
  if (
    !Array.isArray(mission.conds) ||
    mission.conds.some(
      (/** @type {unknown} */ cond) => !cond || typeof cond !== "object",
    )
  )
    return null;
  const clearConditions = (mission.conds ?? []).filter(
    (/** @type {Record<string, any>} */ cond) =>
      cond.missionProgressType === "clear",
  );
  if (clearConditions.length !== 1) return null;
  const condition = clearConditions[0];
  if (
    condition.condType !== "questClear" ||
    condition.targetNum !== 1 ||
    condition.targetIds?.length !== 1
  )
    return null;
  const chapter = chapterForQuest(condition.targetIds[0], wars, chapters);
  if (!chapter) return null;
  // Unknown additional prerequisites must not be treated as satisfied by story progress.
  const starts = (mission.conds ?? []).filter(
    (/** @type {Record<string, any>} */ cond) =>
      cond.missionProgressType !== "clear",
  );
  if (
    starts.some(
      (/** @type {Record<string, any>} */ cond) =>
        !["start", "openCondition"].includes(cond.missionProgressType) ||
        cond.condType !== "questClear" ||
        cond.targetNum !== 1 ||
        cond.targetIds?.length !== 1 ||
        !(() => {
          const prerequisite = chapterForQuest(
            cond.targetIds[0],
            wars,
            chapters,
          );
          return (
            prerequisite &&
            (prerequisite.warId === chapter.warId ||
              (!prerequisite.optional &&
                chapters.indexOf(prerequisite) <= chapters.indexOf(chapter)))
          );
        })(),
    )
  )
    return null;
  return { warId: chapter.warId, name: chapter.name };
}
