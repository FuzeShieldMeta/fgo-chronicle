import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "../../generated/prisma";
import { plannerStateRouter } from "~/server/api/routers/planner-state";
import { createEmptyPlannerStatePayload } from "~/app/timeline/_lib/planner-state";
import { createDefaultPlayerForecastProfile } from "~/app/timeline/_lib/player-forecast";

const url = process.env.CURATOR_QA_DATABASE_URL;
if (
  url &&
  url !==
    "postgresql://postgres:curator-test-only@127.0.0.1:55433/fgo_curator_qa"
)
  throw new Error(
    "Planner integration tests require the disposable local database.",
  );
const db = url ? new PrismaClient({ datasourceUrl: url, log: [] }) : null;
const userIds = ["test-quality-planner-a", "test-quality-planner-b"];
function payload(quartz: number) {
  const value = createEmptyPlannerStatePayload();
  value.profile = createDefaultPlayerForecastProfile("2026-10-28");
  value.profile.snapshot.balances.SAINT_QUARTZ = quartz;
  return value;
}
function caller(userId: string | null) {
  return plannerStateRouter.createCaller({
    db: db!,
    headers: new Headers(),
    session: userId
      ? { user: { id: userId }, expires: "2099-01-01T00:00:00Z" }
      : null,
  });
}
async function cleanup() {
  await db!.plannerState.deleteMany({ where: { userId: { in: userIds } } });
  await db!.user.deleteMany({ where: { id: { in: userIds } } });
}

describe.skipIf(!db)("planner state through real PostgreSQL and tRPC", () => {
  beforeEach(async () => {
    await cleanup();
    await db!.user.createMany({ data: userIds.map((id) => ({ id })) });
  });
  afterEach(cleanup);
  afterAll(async () => {
    await db?.$disconnect();
  });

  it("starts empty and persists the first validated snapshot for only its owner", async () => {
    const owner = caller(userIds[0]!);
    expect(await owner.get()).toBeNull();
    expect(
      await owner.save({ payload: payload(100), expectedRevision: null }),
    ).toMatchObject({ revision: 1, payload: payload(100) });
    const saved = await owner.get();
    expect(saved).toMatchObject({ revision: 1, payload: payload(100) });
    expect(saved?.updatedAt).toBeInstanceOf(Date);
    expect(saved).not.toHaveProperty("userId");
    expect(await caller(userIds[1]!).get()).toBeNull();
  });

  it("accepts only one of two simultaneous first saves without replacing the winning payload", async () => {
    const owner = caller(userIds[0]!);
    const results = await Promise.allSettled([
      owner.save({ payload: payload(100), expectedRevision: null }),
      owner.save({ payload: payload(200), expectedRevision: null }),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "CONFLICT" });
    expect(await owner.get()).toEqual(accepted[0]!.value);
    expect(
      await db!.plannerState.count({ where: { userId: userIds[0]! } }),
    ).toBe(1);
  });

  it("atomically checks the revision so exactly one simultaneous update wins", async () => {
    const owner = caller(userIds[0]!);
    await owner.save({ payload: payload(50), expectedRevision: null });
    const results = await Promise.allSettled([
      owner.save({ payload: payload(100), expectedRevision: 1 }),
      owner.save({ payload: payload(200), expectedRevision: 1 }),
    ]);
    const accepted = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(accepted).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toMatchObject({ code: "CONFLICT" });
    expect(accepted[0]!.value.revision).toBe(2);
    expect(await owner.get()).toEqual(accepted[0]!.value);
    await expect(
      owner.save({ payload: payload(999), expectedRevision: 1 }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await owner.get()).toEqual(accepted[0]!.value);
  });

  it("cannot select another user's record by injecting a userId into the save input", async () => {
    const first = caller(userIds[0]!),
      second = caller(userIds[1]!);
    await first.save({ payload: payload(100), expectedRevision: null });
    const otherSnapshot = await second.save({
      payload: payload(200),
      expectedRevision: null,
    });
    const attemptedOverride = {
      userId: userIds[1]!,
      payload: payload(300),
      expectedRevision: 1,
    };
    await first.save(attemptedOverride);
    expect(await first.get()).toMatchObject({
      revision: 2,
      payload: payload(300),
    });
    expect(await second.get()).toEqual(otherSnapshot);
    expect(
      await db!.plannerState.count({ where: { userId: { in: userIds } } }),
    ).toBe(2);
  });

  it("rejects anonymous reads and writes without creating a snapshot", async () => {
    await expect(caller(null).get()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    await expect(
      caller(null).save({ payload: payload(100), expectedRevision: null }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(
      await db!.plannerState.count({ where: { userId: { in: userIds } } }),
    ).toBe(0);
  });

  it("fails closed on a malformed stored payload without exposing its contents", async () => {
    await db!.plannerState.create({
      data: { userId: userIds[0]!, payload: { privateMarker: "do-not-echo" } },
    });
    await expect(caller(userIds[0]!).get()).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Cloud planner data could not be loaded.",
    });
    expect(await caller(userIds[1]!).get()).toBeNull();
  });
});
