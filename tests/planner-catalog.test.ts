import { afterEach, describe, expect, it, vi } from "vitest";

const BUS_JOB_KEYS = [
  "stops",
  "routes-openapi",
  "route-patterns-openapi",
  "routes-html",
  "route-geometries",
  "timetables-xlsx",
  "walk-links",
] as const;

function createCatalogPrisma(overrides?: {
  stopCount?: number;
  routePatternCount?: number;
  routePatternStopCount?: number;
  tripCount?: number;
  timetableRoutePatternCount?: number;
  officialStopCount?: number;
  generatedStopCount?: number;
  estimatedGeneratedStopCount?: number;
  roughGeneratedStopCount?: number;
  searchableStopCount?: number;
  unresolvedStopCount?: number;
  estimatedStopTimeCount?: number;
  walkLinkCount?: number;
  routeGeometryCount?: number;
  stopProjectionCount?: number;
}) {
  const queryResults = [
    { count: overrides?.routePatternStopCount ?? 4 },
    { count: overrides?.timetableRoutePatternCount ?? 2 },
    { count: overrides?.officialStopCount ?? 8 },
    { count: overrides?.generatedStopCount ?? 0 },
    {
      count:
        overrides?.estimatedGeneratedStopCount ??
        (overrides?.generatedStopCount ?? 0),
    },
    { count: overrides?.roughGeneratedStopCount ?? 0 },
    { count: overrides?.searchableStopCount ?? 8 },
    { count: overrides?.unresolvedStopCount ?? 1 },
  ];

  return {
    place: {
      count: vi.fn().mockResolvedValue(3),
    },
    stop: {
      count: vi.fn().mockResolvedValue(overrides?.stopCount ?? 10),
    },
    routePattern: {
      count: vi.fn().mockResolvedValue(overrides?.routePatternCount ?? 2),
    },
    trip: {
      count: vi.fn().mockResolvedValue(overrides?.tripCount ?? 12),
    },
    walkLink: {
      count: vi.fn().mockResolvedValue(overrides?.walkLinkCount ?? 25),
    },
    routePatternGeometry: {
      count: vi
        .fn()
        .mockResolvedValue(
          overrides?.routeGeometryCount ?? (overrides?.routePatternCount ?? 2),
        ),
    },
    routePatternStopProjection: {
      count: vi
        .fn()
        .mockResolvedValue(
          overrides?.stopProjectionCount ?? (overrides?.routePatternStopCount ?? 4),
        ),
    },
    segmentTravelProfile: {
      count: vi.fn().mockResolvedValue(0),
    },
    stopTime: {
      count: vi.fn().mockResolvedValue(overrides?.estimatedStopTimeCount ?? 0),
    },
    ingestJob: {
      findUnique: vi.fn().mockResolvedValue({
        lastSuccessfulAt: new Date("2026-03-25T00:00:00.000Z"),
      }),
      findMany: vi.fn().mockResolvedValue(
        BUS_JOB_KEYS.map((key) => ({
          key,
          lastSuccessfulAt: new Date("2026-03-25T00:00:00.000Z"),
        })),
      ),
    },
    $queryRaw: vi
      .fn()
      .mockResolvedValueOnce([queryResults[0]])
      .mockResolvedValueOnce([queryResults[1]])
      .mockResolvedValueOnce([queryResults[2]])
      .mockResolvedValueOnce([queryResults[3]])
      .mockResolvedValueOnce([queryResults[4]])
      .mockResolvedValueOnce([queryResults[5]])
      .mockResolvedValueOnce([queryResults[6]])
      .mockResolvedValueOnce([queryResults[7]]),
  } as never;
}

describe("planner catalog readiness", () => {
  afterEach(() => {
    vi.resetModules();
    delete process.env.KAKAO_REST_API_KEY;
  });

  it("is ready when sparse official trips are loaded", async () => {
    process.env.KAKAO_REST_API_KEY = "test-key";
    const { getPlannerCatalogStatus } = await import("@/features/planner/catalog");
    const prisma = createCatalogPrisma() as unknown as {
      trip: {
        count: ReturnType<typeof vi.fn>;
      };
      stopTime: {
        count: ReturnType<typeof vi.fn>;
      };
    };

    const status = await getPlannerCatalogStatus(prisma as never);

    expect(status.ready).toBe(true);
    expect(status.timetableRoutePatternCount).toBe(status.routePatternCount);
    expect(status.officialStopCount).toBe(8);
    expect(status.generatedStopCount).toBe(0);
    expect(status.estimatedGeneratedStopCount).toBe(0);
    expect(status.roughGeneratedStopCount).toBe(0);
    expect(status.message.length).toBeGreaterThan(0);
    expect(prisma.trip.count).toHaveBeenCalledWith({
      where: {
        routePattern: {
          isActive: true,
          route: {
            isActive: true,
          },
        },
        scheduleSource: {
          is: {
            isActive: true,
          },
        },
      },
    });
    expect(prisma.stopTime.count).toHaveBeenCalledWith({
      where: {
        isEstimated: true,
        trip: {
          routePattern: {
            isActive: true,
            route: {
              isActive: true,
            },
          },
          scheduleSource: {
            is: {
              isActive: true,
            },
          },
        },
      },
    });
  });

  it("keeps ready status and advertises generated times when derived coverage exists", async () => {
    process.env.KAKAO_REST_API_KEY = "test-key";
    const { getPlannerCatalogStatus } = await import("@/features/planner/catalog");

    const status = await getPlannerCatalogStatus(
      createCatalogPrisma({
        tripCount: 8,
        timetableRoutePatternCount: 2,
        officialStopCount: 5,
        generatedStopCount: 7,
        estimatedGeneratedStopCount: 5,
        roughGeneratedStopCount: 2,
        searchableStopCount: 9,
        unresolvedStopCount: 1,
      }),
    );

    expect(status.ready).toBe(true);
    expect(status.tripCount).toBe(8);
    expect(status.generatedStopCount).toBe(7);
    expect(status.estimatedGeneratedStopCount).toBe(5);
    expect(status.roughGeneratedStopCount).toBe(2);
    expect(status.searchableStopCount).toBe(9);
    expect(status.unresolvedStopCount).toBe(1);
    expect(status.message.length).toBeGreaterThan(0);
  });

  it("stays not ready when sparse official trips are missing", async () => {
    process.env.KAKAO_REST_API_KEY = "test-key";
    const { getPlannerCatalogStatus } = await import("@/features/planner/catalog");

    const status = await getPlannerCatalogStatus(
      createCatalogPrisma({
        tripCount: 0,
        timetableRoutePatternCount: 0,
        officialStopCount: 0,
        searchableStopCount: 0,
        unresolvedStopCount: 4,
      }),
    );

    expect(status.ready).toBe(false);
    expect(status.tripCount).toBe(0);
    expect(status.timetableRoutePatternCount).toBe(0);
    expect(status.officialStopCount).toBe(0);
    expect(status.unresolvedStopCount).toBe(4);
  });
});
