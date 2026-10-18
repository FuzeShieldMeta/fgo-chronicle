import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PrismaClient, type Prisma } from "../../../generated/prisma";
import { syncMaintenanceCompensation } from "./maintenance-compensation";
import {
  cronSourceAuthority,
  type GlobalSourceAuthority,
} from "./global-source-authority";
import { effectiveReward, rewardDateShift } from "./effective-schedule";
import { reviewEventInclude } from "./curator-review";
import type { MaintenanceNotice } from "./maintenance-notices";
import { getGlobalCandidateQueue } from "./global-candidate-queue";

it("keeps compensation evidence out of the event-date review queue", async () => {
  const findMany = vi
    .fn<
      (input: {
        where?: Prisma.GlobalEventCandidateWhereInput;
      }) => Promise<unknown[]>
    >()
    .mockResolvedValue([]);
  const count = vi
    .fn<
      (input: {
        where?: Prisma.GlobalEventCandidateWhereInput;
      }) => Promise<number>
    >()
    .mockResolvedValue(0);
  await getGlobalCandidateQueue(
    { globalEventCandidate: { findMany, count } } as unknown as PrismaClient,
    {},
  );
  expect(findMany.mock.calls[0]![0].where?.NOT).toEqual({
    sourceRecordId: { endsWith: ":maintenance" },
  });
  expect(count.mock.calls[0]![0].where).toEqual(
    findMany.mock.calls[0]![0].where,
  );
});

const url = process.env.CURATOR_QA_DATABASE_URL;
if (
  url &&
  url !==
    "postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa"
)
  throw Error("Disposable local QA database required.");
const db = url ? new PrismaClient({ datasourceUrl: url, log: [] }) : null;
const secret = "maintenance-test-secret";
const authority = cronSourceAuthority(
  new Request("https://example.test", {
    headers: { authorization: `Bearer ${secret}` },
  }),
  secret,
);
const jp: MaintenanceNotice = {
  region: "JP",
  url: "https://news.fate-go.jp/2025/0409plmil/",
  contentHash: `sha256:${"a".repeat(64)}`,
  startsAt: "2025-04-09T04:00:00.000Z",
  endsAt: "2025-04-09T09:00:00.000Z",
  distributionStartsAt: "2025-04-09T09:00:00.000Z",
  amount: 5,
  recipients: "Existing JP players",
  launchNames: ["QAイベント"],
};
const na: MaintenanceNotice = {
  ...jp,
  region: "NA",
  url: "https://webview.fate-go.us/2027/0409_maintenance/",
  contentHash: `sha256:${"b".repeat(64)}`,
  startsAt: "2027-04-09T04:00:00.000Z",
  endsAt: "2027-04-09T09:00:00.000Z",
  distributionStartsAt: "2027-04-09T09:00:00.000Z",
  amount: 4,
  recipients: "Existing Global players",
  launchNames: ["QA Event"],
};
const options = { dryRun: false, asOf: new Date("2027-04-10") };
const load = (notices: MaintenanceNotice[]) => async () => ({
  notices,
  coverageLimited: false,
});
const eventId = "maintenance-qa-event";

describe.skipIf(!db)("maintenance publication in PostgreSQL", () => {
  beforeAll(async () => {
    const rewardWhere = { rewardSource: { eventId } };
    const rewardIds = (
      await db!.rewardDefinition.findMany({
        where: rewardWhere,
        select: { id: true },
      })
    ).map((row) => row.id);
    await db!.rewardCuration.deleteMany({
      where: { rewardId: { in: rewardIds } },
    });
    await db!.rewardGlobalBaseline.deleteMany({ where: { eventId } });
    await db!.rewardDateOverlay.deleteMany({
      where: { rewardId: { in: rewardIds } },
    });
    await db!.rewardDefinition.deleteMany({ where: rewardWhere });
    await db!.rewardSource.deleteMany({ where: { eventId } });
    await db!.globalEventCandidate.deleteMany({
      where: { targetEventId: eventId },
    });
    await db!.event.deleteMany({
      where: { id: { in: [eventId, "maintenance-qa-duplicate"] } },
    });
    await db!.event.create({
      data: {
        id: eventId,
        sourceKey: "qa:maintenance:event",
        name: "QAイベント",
        type: "MAIN_EVENT",
        startsAt: new Date(na.endsAt),
        sourceStartsAt: new Date(jp.endsAt),
        status: "PROJECTED",
        sourceRegion: "JP_PROJECTED",
      },
    });
  });
  afterAll(async () => {
    await db?.$disconnect();
  });
  const source = () =>
    db!.rewardSource.findFirstOrThrow({
      where: { eventId },
      include: { rewards: { include: { globalBaseline: true } } },
    });
  it("checks authority before fetching or writing", async () => {
    let fetched = false;
    await expect(
      syncMaintenanceCompensation(
        db!,
        {} as GlobalSourceAuthority,
        options,
        async () => {
          fetched = true;
          return { notices: [], coverageLimited: false };
        },
      ),
    ).rejects.toThrow();
    expect(fetched).toBe(false);
  });
  it("dry-run writes no rewards or evidence", async () => {
    expect(
      await syncMaintenanceCompensation(
        db!,
        authority,
        { ...options, dryRun: true },
        load([jp]),
      ),
    ).toMatchObject({ changed: 1 });
    expect(await db!.rewardSource.count({ where: { eventId } })).toBe(0);
  });
  it("puts explicit JP SQ on the first event day and repeats without changes", async () => {
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([jp])),
    ).toMatchObject({ changed: 1 });
    const created = await source();
    expect(created).toMatchObject({
      status: "PROJECTED",
      rewards: [
        {
          amount: 5,
          expectedAt: new Date(na.endsAt),
          dateBasis: "START_RELATIVE",
          defaultIncluded: true,
        },
      ],
    });
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([jp])),
    ).toMatchObject({ changed: 0 });
    expect((await source()).rewards[0]!.id).toBe(created.rewards[0]!.id);
  });
  it("does not choose between duplicate launch records", async () => {
    await db!.event.create({
      data: {
        id: "maintenance-qa-duplicate",
        sourceKey: "qa:maintenance:duplicate",
        name: "QAイベント",
        type: "MAIN_EVENT",
        startsAt: new Date(na.endsAt),
        sourceStartsAt: new Date(jp.endsAt),
        status: "PROJECTED",
        sourceRegion: "JP_PROJECTED",
      },
    });
    try {
      expect(
        await syncMaintenanceCompensation(db!, authority, options, load([jp])),
      ).toMatchObject({ changed: 0, unresolved: 1 });
    } finally {
      await db!.event.delete({ where: { id: "maintenance-qa-duplicate" } });
    }
  });
  it("keeps a projected payment on the opening after an event move", async () => {
    const original = (await source()).rewards[0]!;
    const moved = new Date("2027-04-12T09:00:00.000Z");
    await db!.event.update({
      where: { id: eventId },
      data: { startsAt: moved },
    });
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([jp])),
    ).toMatchObject({ changed: 1 });
    expect((await source()).rewards[0]).toMatchObject({
      id: original.id,
      expectedAt: moved,
    });
    await db!.event.update({
      where: { id: eventId },
      data: { startsAt: new Date(na.endsAt) },
    });
    await syncMaintenanceCompensation(db!, authority, options, load([jp]));
  });
  it("Global confirmation replaces the estimate while preserving its ID and JP data", async () => {
    const old = (await source()).rewards[0]!;
    await db!.event.update({
      where: { id: eventId },
      data: { name: "QA Event", status: "OFFICIAL" },
    });
    expect(
      await syncMaintenanceCompensation(
        db!,
        authority,
        { ...options, dryRun: true },
        load([na]),
      ),
    ).toMatchObject({ confirmed: 1 });
    expect(await db!.rewardGlobalBaseline.count({ where: { eventId } })).toBe(
      0,
    );
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([na])),
    ).toMatchObject({ changed: 1, confirmed: 1 });
    const confirmed = await source();
    expect(confirmed).toMatchObject({
      status: "OFFICIAL",
      rewards: [
        {
          id: old.id,
          amount: 5,
          globalBaseline: {
            amount: 4,
            expectedAt: new Date(na.distributionStartsAt),
          },
        },
      ],
    });
    expect(await db!.rewardSource.count({ where: { eventId } })).toBe(1);
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([na])),
    ).toMatchObject({ changed: 0 });
    // JP notices never downgrade a confirmed payment.
    await db!.event.update({
      where: { id: eventId },
      data: { name: "QAイベント" },
    });
    expect(
      await syncMaintenanceCompensation(db!, authority, options, load([jp])),
    ).toMatchObject({ changed: 0 });
  });
  it("preserves curator-owned amounts and exclusions", async () => {
    const reward = (await source()).rewards[0]!;
    await db!.rewardCuration.create({
      data: {
        rewardId: reward.id,
        active: true,
        ownedFields: ["amount", "defaultIncluded"],
        itemType: "SAINT_QUARTZ",
        amount: 2,
        expectedAt: reward.expectedAt,
        nature: "DETERMINISTIC",
        eligibility: null,
        defaultIncluded: false,
        revision: 1,
      },
    });
    const event = await db!.event.findUniqueOrThrow({
      where: { id: eventId },
      include: reviewEventInclude,
    });
    const current = event.rewardSources[0]!.rewards[0]!;
    expect(
      effectiveReward(current, rewardDateShift(event, current)),
    ).toMatchObject({ amount: 2, defaultIncluded: false });
  });
  it("rolls back a confirmation if its audit fails, and reports the failure", async () => {
    await db!.event.update({
      where: { id: eventId },
      data: { name: "QA Event" },
    });
    await db!.$executeRawUnsafe(
      "CREATE FUNCTION qa_maintenance_reject() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA audit rejection'; END; $$",
    );
    await db!.$executeRawUnsafe(
      'CREATE TRIGGER qa_maintenance_reject BEFORE INSERT ON "CuratorChange" FOR EACH ROW EXECUTE FUNCTION qa_maintenance_reject()',
    );
    try {
      expect(
        await syncMaintenanceCompensation(
          db!,
          authority,
          options,
          load([{ ...na, amount: 6 }]),
        ),
      ).toMatchObject({ status: "failed", failed: 1, changed: 0 });
      expect((await source()).rewards[0]!.globalBaseline!.amount).toBe(4);
    } finally {
      await db!.$executeRawUnsafe(
        'DROP TRIGGER qa_maintenance_reject ON "CuratorChange"',
      );
      await db!.$executeRawUnsafe("DROP FUNCTION qa_maintenance_reject()");
    }
  });
});
