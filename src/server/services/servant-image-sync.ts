import type { PrismaClient } from "../../../generated/prisma";
import {
  servantAssets,
  isServantThumbnailPath,
} from "../../shared/servant-assets-config.mjs";
import {
  createServantImageStore,
  downloadServantFace,
  servantImagePath,
  type ServantImageStore,
} from "./servant-image-storage";

type Database = Pick<PrismaClient, "servant">;
export type ServantImageReport = {
  status: "success" | "failed" | "unavailable";
  examined: number;
  pending: number;
  uploaded: number;
  reused: number;
  updated: number;
  failed: number;
};

export async function syncServantImages(
  database: Database,
  dryRun: boolean,
  dependencies: {
    store?: ServantImageStore | null;
    download?: typeof downloadServantFace;
  } = {},
): Promise<ServantImageReport> {
  const store =
    dependencies.store === undefined
      ? createServantImageStore()
      : dependencies.store;
  const report: ServantImageReport = {
    status: store ? "success" : "unavailable",
    examined: 0,
    pending: 0,
    uploaded: 0,
    reused: 0,
    updated: 0,
    failed: 0,
  };
  // Unconfigured deployments continue to use Atlas and do not need Storage queries.
  if (!store) return report;
  const servants = await database.servant.findMany({
    select: { id: true, faceId: true, thumbnailPath: true },
  });
  report.examined = servants.length;
  const savedFaces = new Map<number, string>();
  for (const servant of servants) {
    if (
      servant.faceId &&
      isServantThumbnailPath(servant.thumbnailPath) &&
      servant.thumbnailPath!.startsWith(`faces/${servant.faceId}/`)
    )
      savedFaces.set(servant.faceId, servant.thumbnailPath!);
  }
  const faces = new Map<number, typeof servants>();
  for (const servant of servants) {
    const face = servant.faceId;
    if (
      !face ||
      (isServantThumbnailPath(servant.thumbnailPath) &&
        servant.thumbnailPath!.startsWith(`faces/${face}/`))
    )
      continue;
    const group = faces.get(face) ?? [];
    group.push(servant);
    faces.set(face, group);
  }
  report.pending = faces.size;
  if (dryRun) return report;
  const jobs = [...faces];
  if (jobs.some(([face]) => !savedFaces.has(face))) {
    try {
      await store.prepare?.();
    } catch {
      report.status = "failed";
      report.failed = jobs.length;
      return report;
    }
  }
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(servantAssets.concurrency, jobs.length) },
      async () => {
        while (next < jobs.length) {
          const [faceId, group] = jobs[next++]!;
          try {
            let path = savedFaces.get(faceId);
            if (path) report.reused++;
            else {
              const bytes = await (
                dependencies.download ?? downloadServantFace
              )(faceId);
              path = servantImagePath(faceId, bytes);
              const { reused } = await store.upload(path, bytes);
              if (reused) report.reused++;
              else report.uploaded++;
            }
            // Prevent a slow upload from overwriting a newer face or mirror reference.
            for (const servant of group) {
              const result = await database.servant.updateMany({
                where: {
                  id: servant.id,
                  faceId,
                  thumbnailPath: servant.thumbnailPath,
                },
                data: { thumbnailPath: path },
              });
              report.updated += result.count;
            }
          } catch {
            // Raw Storage/DB errors may contain credentials or connection details.
            report.failed++;
          }
        }
      },
    ),
  );
  if (report.failed) report.status = "failed";
  return report;
}
