import { describe, expect, it, vi } from "vitest";
import type { GlobalEventCandidate, Prisma } from "../../../generated/prisma";
import { effectiveReward, rewardDateShift } from "./effective-schedule";
import { publishAnnouncementFamily } from "./global-announcement-publication";

const opening = new Date("2027-04-09T09:00:00Z");
const moved = new Date("2027-04-12T09:00:00Z");
const end = new Date("2027-04-30T03:59:00Z");
const eventCuration = {
  eventId: "event",
  active: true,
  revision: 1,
  ownedFields: ["startsAt", "shiftRewardDates"],
  name: "Maintenance Test Festival",
  startsAt: moved,
  endsAt: end,
  startsAtPrecision: "EXACT" as const,
  endsAtPrecision: "EXACT" as const,
  shiftRewardDates: true,
  hidden: false,
  updatedAt: moved,
};
const reward = {
  id: "reward",
  rewardSourceId: "source",
  itemType: "SAINT_QUARTZ",
  amount: 5,
  expectedAt: opening,
  nature: "DETERMINISTIC",
  eligibility: null,
  defaultIncluded: true,
  reviewedAt: null,
};

describe("maintenance dates within a family", () => {
  it("keeps an absolute payment fixed under a curator family shift", () => {
    const absolute = { ...reward, dateBasis: "ABSOLUTE" as const };
    const offset = rewardDateShift(
      { startsAt: opening, curation: eventCuration },
      absolute,
    );
    expect(offset).toBe(0);
    expect(effectiveReward(absolute, offset).expectedAt).toEqual(opening);
  });
  it("keeps an absolute confirmed baseline fixed within its family", () => {
    const confirmed = {
      ...reward,
      dateBasis: "ABSOLUTE" as const,
      globalBaseline: { ...reward, amount: 4, eventStartsAt: opening },
    };
    const offset = rewardDateShift(
      { startsAt: opening, curation: eventCuration },
      confirmed,
    );
    expect(effectiveReward(confirmed, offset)).toMatchObject({
      id: "reward",
      amount: 4,
      expectedAt: opening,
    });
  });
  it("still moves a projected first-day payment", () => {
    const projected = { ...reward, dateBasis: "START_RELATIVE" as const };
    const offset = rewardDateShift(
      { startsAt: opening, curation: eventCuration },
      projected,
    );
    expect(effectiveReward(projected, offset).expectedAt).toEqual(moved);
  });
  it.each(["UNKNOWN", "ABSOLUTE", "START_RELATIVE"] as const)(
    "publishes an official family opening without misclassifying %s maintenance",
    async (dateBasis) => {
      const execute = vi
        .fn<(...args: unknown[]) => Promise<number>>()
        .mockResolvedValue(1);
      const current = {
        id: "event",
        sourceKey: "qa:event",
        familyId: null,
        name: "Maintenance Test Festival",
        type: "MAIN_EVENT",
        startsAt: opening,
        endsAt: end,
        startsAtPrecision: "EXACT",
        endsAtPrecision: "EXACT",
        status: "PROJECTED",
        updatedAt: opening,
        dateOverlay: null,
        curation: null,
        globalBaseline: null,
        dateEvidence: [],
        rewardSources: [
          {
            id: "source",
            type: "MAINTENANCE",
            status: "PROJECTED",
            rewards: [
              {
                ...reward,
                dateBasis,
                storyWarId: null,
                curation: null,
                globalBaseline: null,
                dateOverlay: null,
              },
            ],
          },
        ],
      };
      const candidate = {
        id: "candidate",
        sourceKind: "PUBLISHER_ANNOUNCEMENT",
        sourceUrl: "https://webview.fate-go.us/2027/0410_qa_event/",
        sourceRecordId: "/2027/0410_qa_event/:period:0",
        startsAt: moved,
        endsAt: end,
        retrievedAt: moved,
        contentHash: `sha256:${"a".repeat(64)}`,
        snapshot: {
          kind: "EVENT",
          issues: [],
          sourceRecordId: "/2027/0410_qa_event/:period:0",
          context: "Event Period:",
          rawPeriod: "test period",
          startsAt: moved.toISOString(),
          endsAt: end.toISOString(),
          startTimezone: "UTC",
          endTimezone: "UTC",
          publicationAllowed: false,
          articleName: current.name,
          matching: { targetEventId: "event", reason: "UNIQUE_EVENT_MATCH" },
        },
      } as unknown as GlobalEventCandidate;
      const tx = {
        $queryRaw: vi.fn().mockResolvedValue([]),
        $executeRaw: execute,
        event: {
          findUniqueOrThrow: vi.fn().mockResolvedValue({ familyId: null }),
          findMany: vi.fn().mockResolvedValue([current]),
        },
        eventDateEvidence: { create: vi.fn().mockResolvedValue({}) },
        curatorChange: { create: vi.fn().mockResolvedValue({}) },
      } as unknown as Prisma.TransactionClient;
      await expect(
        publishAnnouncementFamily(tx, "qa-actor", candidate, "event"),
      ).resolves.toMatchObject({ changed: true });
      const insert = execute.mock.calls.find((args) =>
        String(args[0]).includes('INSERT INTO "RewardDateOverlay"'),
      );
      if (dateBasis === "START_RELATIVE") {
        expect(insert).toBeDefined();
        expect(JSON.parse(String(insert![1]))).toEqual([
          {
            rewardId: "reward",
            anchorEventId: "event",
            candidateId: "candidate",
            expectedAt: moved.toISOString(),
          },
        ]);
      } else expect(insert).toBeUndefined();
      expect(current.rewardSources[0]!.status).toBe("PROJECTED");
    },
  );
});
