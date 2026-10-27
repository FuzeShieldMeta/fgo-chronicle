import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma";
import { importBannerDataset } from "~/server/services/banner-import";
import { bannerSourceKey } from "~/server/services/banner-dataset";
import { bannerRouter } from "~/server/api/routers/banner";
import { timelineRouter } from "~/server/api/routers/timeline";

const url = process.env.CURATOR_QA_DATABASE_URL;
if (
  url &&
  url !==
    "postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa"
)
  throw new Error("Disposable local database required.");
const db = url ? new PrismaClient({ datasourceUrl: url, log: [] }) : null;
const familyId = "banner-import-qa-family";
const servantId = 996001;
const banner = {
  name: "Banner Import QA",
  startDate: "2027-01-01",
  endDate: "2027-01-15",
  sourceSchedule: "JP",
  status: "PROJECTED",
  servants: [
    {
      id: servantId,
      name: "QA Rider",
      class: "Rider",
      rarity: 5,
      faceId: 9960010,
      soloRateUp: true,
    },
  ],
};
const exact = {
  name: "Exact QA",
  sourceKey: "publisher:JP:qa:pickup:996001",
  sourceUrl: "https://news.fate-go.jp/2025/example_pu/",
  startsAt: "2027-04-02T18:00:00+09:00",
  endsAt: "2027-04-23T12:59:00+09:00",
  timePrecision: "EXACT",
  sourceSchedule: "JP",
  status: "PROJECTED",
  servants: banner.servants,
};
const ownKeys = [bannerSourceKey(banner), exact.sourceKey];
const context = () => ({ db: db!, headers: new Headers(), session: null });

async function cleanup() {
  await db!
    .$executeRaw`ALTER TABLE "Banner" DROP CONSTRAINT IF EXISTS "test_quality_reject_banner"`;
  await db!.banner.deleteMany({ where: { sourceKey: { in: ownKeys } } });
  await db!.eventFamily.deleteMany({ where: { id: familyId } });
  await db!.servant.deleteMany({ where: { id: servantId } });
}
async function importedBanner() {
  await importBannerDataset(db!, { banners: [banner] });
  return db!.banner.findUniqueOrThrow({
    where: { sourceKey: bannerSourceKey(banner) },
  });
}

describe.skipIf(!db)("transactional shared banner import", () => {
  beforeEach(async () => {
    await cleanup();
    await db!.eventFamily.create({
      data: { id: familyId, sourceKey: familyId, name: "QA" },
    });
  });
  afterEach(cleanup);
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("preserves IDs, family, visibility, assets and omitted lineups on an unchanged repeat", async () => {
    expect(await importBannerDataset(db!, { banners: [banner] })).toEqual({
      examined: 1,
      imported: 1,
      changedBanners: 1,
      servants: 1,
    });
    const saved = await db!.banner.findUniqueOrThrow({
      where: { sourceKey: bannerSourceKey(banner) },
    });
    await db!.banner.update({
      where: { id: saved.id },
      data: {
        familyId,
        hidden: true,
        sourceUrl: "https://example.test/retained-evidence",
      },
    });
    await db!.servant.update({
      where: { id: servantId },
      data: { thumbnailPath: "qa/face.png", atlasNaAvailable: true },
    });
    const lineup = await db!.summonLineup.create({
      data: {
        sourceKey: "banner-import-qa-lineup",
        bannerId: saved.id,
        name: "Verified QA lineup",
        startsAt: new Date("2027-01-01"),
        evidenceUrl: "https://example.test/qa",
        sourceRegion: "NA",
        featured: { create: { servantId, soloRateUp: true } },
      },
    });
    const before = await db!.banner.findUniqueOrThrow({
      where: { id: saved.id },
      include: { summonLineups: { include: { featured: true } } },
    });
    const repeat = await importBannerDataset(db!, {
      banners: [
        {
          ...banner,
          servants: banner.servants.map((servant) => ({
            ...servant,
            faceId: undefined,
          })),
        },
      ],
    });
    expect(repeat.changedBanners).toBe(0);
    const after = await db!.banner.findUniqueOrThrow({
      where: { id: saved.id },
      include: { summonLineups: { include: { featured: true } } },
    });
    expect(after).toEqual(before);
    expect(after.summonLineups[0]).toMatchObject({
      id: lineup.id,
      sourceKey: lineup.sourceKey,
      featured: [{ servantId, soloRateUp: true }],
    });
    expect(
      await db!.servant.findUniqueOrThrow({ where: { id: servantId } }),
    ).toMatchObject({
      faceId: 9960010,
      thumbnailPath: "qa/face.png",
      atlasNaAvailable: true,
    });
  });

  it("exposes changed memberships through the real public reader without replacing the banner", async () => {
    const saved = await importedBanner();
    await importBannerDataset(db!, {
      banners: [
        {
          ...banner,
          servants: [{ ...banner.servants[0]!, soloRateUp: false }],
        },
      ],
    });
    const visible = await bannerRouter
      .createCaller(context())
      .upcoming({ from: new Date("2027-01-01"), to: new Date("2027-01-31") });
    expect(visible.find((entry) => entry.id === saved.id)).toMatchObject({
      startsAt: new Date("2027-01-01T00:00:00Z"),
      startsAtPrecision: "DATE_ONLY",
      featured: [{ servantId, soloRateUp: false }],
    });
    expect(
      await db!.banner.count({ where: { sourceKey: bannerSourceKey(banner) } }),
    ).toBe(1);
  });

  it("rejects an invalid later record before writing any record in the dataset", async () => {
    await expect(
      importBannerDataset(db!, {
        banners: [banner, { ...exact, endsAt: "2026-01-01T00:00:00Z" }],
      }),
    ).rejects.toThrow();
    expect(
      await db!.banner.count({ where: { sourceKey: { in: ownKeys } } }),
    ).toBe(0);
    expect(
      await db!.servant.findUnique({ where: { id: servantId } }),
    ).toBeNull();
  });

  it("does not touch existing data when publication authority is rejected", async () => {
    const saved = await importedBanner();
    const before = await db!.banner.findUniqueOrThrow({
      where: { id: saved.id },
      include: { featured: true },
    });
    await expect(
      importBannerDataset(db!, { banners: [exact] }, () =>
        Promise.reject(new Error("revoked")),
      ),
    ).rejects.toThrow("revoked");
    expect(
      await db!.banner.findUniqueOrThrow({
        where: { id: saved.id },
        include: { featured: true },
      }),
    ).toEqual(before);
    expect(
      await db!.banner.findUnique({ where: { sourceKey: exact.sourceKey } }),
    ).toBeNull();
  });

  it("rolls back preceding catalogue writes when the banner write fails in PostgreSQL", async () => {
    // This test-only constraint is installed only on the guarded disposable DB.
    await db!
      .$executeRaw`ALTER TABLE "Banner" ADD CONSTRAINT "test_quality_reject_banner" CHECK ("name" <> 'Exact QA') NOT VALID`;
    await expect(
      importBannerDataset(db!, { banners: [exact] }),
    ).rejects.toThrow();
    expect(
      await db!.servant.findUnique({ where: { id: servantId } }),
    ).toBeNull();
    expect(
      await db!.banner.findUnique({ where: { sourceKey: exact.sourceKey } }),
    ).toBeNull();
  });

  it("keeps exact instants, precision and source identity after a corrected name and date", async () => {
    expect(
      (await importBannerDataset(db!, { banners: [exact] })).changedBanners,
    ).toBe(1);
    const saved = await db!.banner.findUniqueOrThrow({
      where: { sourceKey: exact.sourceKey },
    });
    expect(saved).toMatchObject({
      sourceUrl: exact.sourceUrl,
      startsAt: new Date("2027-04-02T09:00:00Z"),
      endsAt: new Date("2027-04-23T03:59:00Z"),
      startsAtPrecision: "EXACT",
      endsAtPrecision: "EXACT",
    });
    await db!.banner.update({
      where: { id: saved.id },
      data: { hidden: true, familyId },
    });
    const corrected = {
      ...exact,
      name: "Corrected Exact QA",
      startsAt: "2027-04-03T18:00:00+09:00",
    };
    await importBannerDataset(db!, { banners: [corrected] });
    expect(
      await db!.banner.findUniqueOrThrow({
        where: { sourceKey: exact.sourceKey },
      }),
    ).toMatchObject({
      id: saved.id,
      name: corrected.name,
      startsAt: new Date("2027-04-03T09:00:00Z"),
      hidden: true,
      familyId,
    });
    expect(
      (await importBannerDataset(db!, { banners: [corrected] })).changedBanners,
    ).toBe(0);
  });

  it("preserves a missing exact end and exposes exact precision in the public reader", async () => {
    const open = {
      ...exact,
      endsAt: null,
      sourceUrl: "https://news.fate-go.jp/2025/corrected_pu/",
    };
    await importBannerDataset(db!, { banners: [open] });
    const visible = await bannerRouter
      .createCaller(context())
      .upcoming({ from: new Date("2027-04-02"), to: new Date("2027-04-03") });
    expect(
      visible.find((entry) => entry.sourceKey === exact.sourceKey),
    ).toMatchObject({
      endsAt: null,
      endsAtPrecision: null,
      startsAtPrecision: "EXACT",
      startsAt: new Date("2027-04-02T09:00:00Z"),
      sourceUrl: open.sourceUrl,
    });
    expect(
      (await importBannerDataset(db!, { banners: [open] })).changedBanners,
    ).toBe(0);
  });

  it("keeps hidden banners out of discovery after reimport but preserves direct lookup for saved plans", async () => {
    const saved = await importedBanner();
    await db!.banner.update({
      where: { id: saved.id },
      data: { hidden: true },
    });
    await importBannerDataset(db!, { banners: [banner] });
    const visible = await bannerRouter
      .createCaller(context())
      .upcoming({ from: new Date("2027-01-01"), to: new Date("2027-01-31") });
    expect(visible.some((entry) => entry.id === saved.id)).toBe(false);
    expect(
      await timelineRouter
        .createCaller(context())
        .details({ kind: "BANNER", id: saved.id }),
    ).toMatchObject({ id: saved.id, hidden: true });
  });
});
