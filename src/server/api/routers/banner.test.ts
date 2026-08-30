import { describe, expect, it, vi } from "vitest";

import { bannerRouter } from "~/server/api/routers/banner";

function createDatabaseMock() {
  return {
    banner: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
    servant: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
    },
  };
}

function createCaller(database: ReturnType<typeof createDatabaseMock>) {
  return bannerRouter.createCaller({
    db: database as never,
    headers: new Headers(),
    session: null,
  });
}

function createBanner(
  overrides: Partial<{
    id: string;
    startsAt: Date;
    endsAt: Date | null;
    status: "PROJECTED" | "CURATED" | "OFFICIAL";
    soloRateUp: boolean;
  }> = {},
) {
  const id = overrides.id ?? "banner-1";

  return {
    id,
    sourceKey: `source-${id}`,
    name: `Banner ${id}`,
    startsAt: overrides.startsAt ?? new Date("2026-09-01T00:00:00Z"),
    endsAt: overrides.endsAt ?? new Date("2026-09-15T00:00:00Z"),
    status: overrides.status ?? ("OFFICIAL" as const),
    sourceUrl: "https://example.com/banner",
    sourceRegion: "NA",
    createdAt: new Date("2026-08-01T00:00:00Z"),
    updatedAt: new Date("2026-08-01T00:00:00Z"),
    featured: [
      {
        bannerId: id,
        servantId: 1,
        soloRateUp: overrides.soloRateUp ?? true,
        servant: {
          id: 1,
          name: "Artoria Pendragon",
          className: "Saber",
        },
      },
    ],
  };
}

describe("bannerRouter.upcoming", () => {
  it("uses deterministic ordering for a valid date range", async () => {
    const database = createDatabaseMock();
    database.banner.findMany.mockResolvedValue([]);
    const caller = createCaller(database);
    const from = new Date("2026-09-01T00:00:00Z");
    const to = new Date("2028-09-01T00:00:00Z");

    await expect(caller.upcoming({ from, to })).resolves.toEqual([]);
    expect(database.banner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { startsAt: { gte: from, lte: to } },
        orderBy: [{ startsAt: "asc" }, { id: "asc" }],
      }),
    );
  });

  it.each([
    {
      name: "ends before it starts",
      from: new Date("2026-09-02T00:00:00Z"),
      to: new Date("2026-09-01T00:00:00Z"),
    },
    {
      name: "spans more than three years",
      from: new Date("2026-01-01T00:00:00Z"),
      to: new Date("2030-01-02T00:00:00Z"),
    },
  ])("rejects a range that $name", async ({ from, to }) => {
    const caller = createCaller(createDatabaseMock());

    await expect(caller.upcoming({ from, to })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});

describe("bannerRouter.byId", () => {
  it("returns a banner and its rate-up details", async () => {
    const database = createDatabaseMock();
    const banner = createBanner({ soloRateUp: false });
    database.banner.findUnique.mockResolvedValue(banner);

    await expect(
      createCaller(database).byId({ id: banner.id }),
    ).resolves.toEqual(banner);
    expect(database.banner.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: banner.id } }),
    );
  });

  it("reports an unknown banner", async () => {
    const database = createDatabaseMock();
    database.banner.findUnique.mockResolvedValue(null);

    await expect(
      createCaller(database).byId({ id: "missing-banner" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("bannerRouter.searchServants", () => {
  it("keeps ambiguous name matches separate", async () => {
    const database = createDatabaseMock();
    const matches = [
      { id: 1, name: "Artoria Pendragon", className: "Saber" },
      { id: 2, name: "Artoria Pendragon (Alter)", className: "Saber" },
    ];
    database.servant.findMany.mockResolvedValue(matches);

    await expect(
      createCaller(database).searchServants({ query: "Artoria" }),
    ).resolves.toEqual(matches);
    expect(database.servant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: 10,
      }),
    );
  });
});

describe("bannerRouter.bannersForServant", () => {
  it("uses a stable Servant ID and classifies every known banner", async () => {
    const database = createDatabaseMock();
    const servant = {
      id: 1,
      name: "Artoria Pendragon",
      className: "Saber",
    };
    const banners = [
      createBanner({
        id: "past",
        startsAt: new Date("2026-07-01T00:00:00Z"),
        endsAt: new Date("2026-07-15T00:00:00Z"),
      }),
      createBanner({
        id: "active",
        startsAt: new Date("2026-08-20T00:00:00Z"),
        endsAt: new Date("2026-09-05T00:00:00Z"),
        soloRateUp: false,
      }),
      createBanner({
        id: "confirmed",
        startsAt: new Date("2026-10-01T00:00:00Z"),
        endsAt: new Date("2026-10-15T00:00:00Z"),
        status: "OFFICIAL",
      }),
      createBanner({
        id: "projected",
        startsAt: new Date("2027-01-01T00:00:00Z"),
        endsAt: new Date("2027-01-15T00:00:00Z"),
        status: "PROJECTED",
      }),
    ];
    database.servant.findUnique.mockResolvedValue(servant);
    database.banner.findMany.mockResolvedValue(banners);

    const result = await createCaller(database).bannersForServant({
      servantId: servant.id,
      asOf: new Date("2026-08-30T00:00:00Z"),
    });

    expect(result.servant).toEqual(servant);
    expect(result.banners.map(({ timing }) => timing)).toEqual([
      "PAST",
      "ACTIVE",
      "CONFIRMED_FUTURE",
      "PROJECTED_FUTURE",
    ]);
    expect(result.banners[1]?.featured[0]?.soloRateUp).toBe(false);
    expect(database.banner.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { featured: { some: { servantId: servant.id } } },
      }),
    );
  });

  it("reports an unknown Servant without querying banners", async () => {
    const database = createDatabaseMock();
    database.servant.findUnique.mockResolvedValue(null);

    await expect(
      createCaller(database).bannersForServant({ servantId: 999 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(database.banner.findMany).not.toHaveBeenCalled();
  });
});
