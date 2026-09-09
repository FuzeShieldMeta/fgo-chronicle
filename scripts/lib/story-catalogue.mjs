import labels from "../../src/data/story-chapters.json" with { type: "json" };

/** Discover canonical story wars and verify known source identities.
 * @param {Array<Record<string, any>>} wars
 */
export function buildStoryCatalogue(wars) {
  const chapters = [];
  const warnings = [];
  for (const war of wars) {
    if (
      !war.flags?.includes("mainScenario") ||
      war.flags.includes("areaBoardShortcut") ||
      !war.lastQuestId
    )
      continue;
    const known = labels.find((chapter) => chapter.warId === war.id);
    const originalName = war.originalLongName ?? war.longName;
    if (
      !Number.isInteger(war.id) ||
      war.id <= 0 ||
      !Number.isInteger(war.lastQuestId) ||
      war.lastQuestId <= 0 ||
      !Number.isInteger(war.priority ?? war.id) ||
      typeof originalName !== "string" ||
      !originalName.trim() ||
      (known &&
        (known.originalName !== originalName ||
          known.lastQuestId !== war.lastQuestId))
    ) {
      warnings.push({ warId: war.id, reason: "Story identity needs review" });
      continue;
    }
    const quests = (war.spots ?? []).flatMap(
      (/** @type {Record<string, any>} */ spot) => spot.quests ?? [],
    );
    if (
      !quests.some(
        (/** @type {Record<string, any>} */ quest) =>
          quest.id === war.lastQuestId && quest.type === "main",
      )
    ) {
      warnings.push({
        warId: war.id,
        reason:
          "Final quest detail unavailable; only explicit final-quest missions can be mapped",
      });
    }
    chapters.push({
      warId: war.id,
      name: known?.name ?? war.longName ?? originalName,
      originalName,
      lastQuestId: war.lastQuestId,
      optional:
        known?.optional ??
        (war.flags.includes("isWarIconFree") ||
          war.flags.includes("closeAfterClear")),
      sortOrder: war.priority ?? war.id,
    });
  }
  chapters.sort((a, b) => a.sortOrder - b.sortOrder || a.warId - b.warId);
  if (
    new Set(chapters.map((chapter) => chapter.warId)).size !==
      chapters.length ||
    new Set(chapters.map((chapter) => chapter.lastQuestId)).size !==
      chapters.length
  )
    throw new Error("Ambiguous story catalogue");
  return { chapters, warnings };
}

/** Upsert discovered stories within the pipeline transaction. Never delete missing stories.
 * @param {Record<string, any>} db
 * @param {ReturnType<typeof buildStoryCatalogue>} catalogue
 * @param {{dryRun: boolean}} options
 */
export async function reconcileStoryCatalogue(db, catalogue, options) {
  const existing = await db.storyChapter.findMany();
  const changes = catalogue.chapters.filter((chapter) => {
    const previous = existing.find(
      (/** @type {Record<string, any>} */ row) => row.warId === chapter.warId,
    );
    return (
      !previous ||
      Object.entries(chapter).some(([key, value]) => previous[key] !== value)
    );
  });
  const unsafe = changes.some((chapter) => {
    const previous = existing.find(
      (/** @type {Record<string, any>} */ row) => row.warId === chapter.warId,
    );
    return (
      previous &&
      (previous.originalName !== chapter.originalName ||
        previous.lastQuestId !== chapter.lastQuestId ||
        previous.optional !== chapter.optional ||
        previous.sortOrder !== chapter.sortOrder)
    );
  });
  const limitExceeded = changes.length > 100 || unsafe;
  if (!options.dryRun && limitExceeded)
    throw new Error("Story catalogue changes need review");
  if (!options.dryRun)
    for (const chapter of changes)
      await db.storyChapter.upsert({
        where: { warId: chapter.warId },
        create: chapter,
        update: chapter,
      });
  return {
    checked: catalogue.chapters.length,
    changes: changes.length,
    limitExceeded,
    warnings: catalogue.warnings,
  };
}
