import type { PrismaClient } from "../../../generated/prisma";
import { runCompleteEventSchedule } from "./complete-event-schedule";
import { downloadBannerSpreadsheet } from "./banner-spreadsheet";
import { importBannerDataset } from "./banner-import";
import {
  requireSourceAuthority,
  lockSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { createImportProgress } from "./import-progress";
import { validateAnnouncementBackfillDays } from "./global-announcement-source";

type Options = Parameters<typeof runCompleteEventSchedule>[1];
type Dependencies = NonNullable<
  Parameters<typeof runCompleteEventSchedule>[3]
> & {
  downloadBanners?: typeof downloadBannerSpreadsheet;
  importBanners?: typeof importBannerDataset;
};

export async function runGeneralSync(
  database: PrismaClient,
  options: Options,
  authority: GlobalSourceAuthority,
  dependencies: Dependencies = {},
) {
  if (options.dryRun)
    throw new Error(
      "General sync does not support --dry-run. Use data:sync-event-schedule -- --dry-run for schedule-only checks.",
    );
  validateAnnouncementBackfillDays(options.announcementBackfillDays);
  await requireSourceAuthority(database, authority);
  const progress = dependencies.progress ?? createImportProgress();
  const dataset = await progress.stage("spreadsheet_download", () =>
    (dependencies.downloadBanners ?? downloadBannerSpreadsheet)(),
  );
  const banners = await progress.stage("banner_publication", () =>
    (dependencies.importBanners ?? importBannerDataset)(
      database,
      dataset,
      (tx) => lockSourceAuthority(tx, authority),
    ),
  );
  const report = await runCompleteEventSchedule(database, options, authority, {
    ...dependencies,
    progress,
  });
  return { ...report, banners: { status: "success" as const, ...banners } };
}
