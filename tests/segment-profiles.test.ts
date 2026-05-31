import { ServiceDayClass } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { matchTraceGeometryMock } = vi.hoisted(() => ({
  matchTraceGeometryMock: vi.fn(),
}));

vi.mock("@/lib/osrm", () => ({
  matchTraceGeometry: matchTraceGeometryMock,
}));

import { collectTurnTriples, runSegmentProfilesJob } from "@/worker/jobs/segment-profiles";

function makeObservation(day: string, minuteOffset: number, longitude: number) {
  return {
    deviceId: "bus-1",
    routePatternId: "pattern-1",
    externalRouteId: "route-1",
    observedAt: new Date(`${day}T08:${String(minuteOffset).padStart(2, "0")}:00.000Z`),
    latitude: 0,
    longitude,
  };
}

function makeLowFrequencyObservations() {
  return [
    "2026-05-11",
    "2026-05-12",
    "2026-05-13",
    "2026-05-14",
    "2026-05-15",
  ].flatMap((day) => [
    makeObservation(day, 0, 0),
    makeObservation(day, 5, 0.003),
    makeObservation(day, 10, 0.006),
  ]);
}

function makeRuntime(overrides: {
  observations?: Awaited<ReturnType<typeof makeLowFrequencyObservations>>;
  existingStopPassages?: Array<{
    routePatternId: string;
    sequence: number;
    deviceId: string;
    observedAt: Date;
  }>;
} = {}) {
  const segmentCreateMany = vi.fn();
  const observedCreateMany = vi.fn();
  const gnssFindMany = vi.fn().mockResolvedValue(
    overrides.observations ?? makeLowFrequencyObservations(),
  );

  return {
    runtime: {
      env: {
        osrmBusEtaBaseUrl: "http://osrm.test",
      },
      prisma: {
        vehicleDeviceMap: {
          findMany: vi.fn().mockResolvedValue([
            {
              routePatternId: "pattern-1",
              deviceId: "bus-1",
              externalRouteId: "route-1",
              routePattern: {
                geometry: {
                  geometry: {
                    coordinates: [
                      [0, 0],
                      [0.006, 0],
                    ],
                  },
                },
                stopProjections: [
                  {
                    sequence: 1,
                    stopId: "stop-a",
                    offsetMeters: 0,
                    snapDistanceMeters: 0,
                    confidence: 1,
                  },
                  {
                    sequence: 2,
                    stopId: "stop-b",
                    offsetMeters: 334,
                    snapDistanceMeters: 0,
                    confidence: 1,
                  },
                  {
                    sequence: 3,
                    stopId: "stop-c",
                    offsetMeters: 667,
                    snapDistanceMeters: 0,
                    confidence: 1,
                  },
                ],
              },
            },
          ]),
        },
        gnssObservation: {
          findMany: gnssFindMany,
        },
        segmentTravelProfile: {
          deleteMany: vi.fn(),
          createMany: segmentCreateMany,
        },
        turnDelayProfile: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        observedStopPassage: {
          deleteMany: vi.fn(),
          findMany: vi.fn().mockResolvedValue(overrides.existingStopPassages ?? []),
          createMany: observedCreateMany,
        },
      },
    } as never,
    gnssFindMany,
    segmentCreateMany,
    observedCreateMany,
  };
}

describe("segment profile helpers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-21T00:00:00.000Z"));
    matchTraceGeometryMock.mockReset();
    matchTraceGeometryMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("extracts unique turn triples from matched OSRM node lists", () => {
    expect(collectTurnTriples([10, 11, 12, 13])).toEqual([
      {
        fromOsmNodeId: "10",
        viaOsmNodeId: "11",
        toOsmNodeId: "12",
      },
      {
        fromOsmNodeId: "11",
        viaOsmNodeId: "12",
        toOsmNodeId: "13",
      },
    ]);
  });

  it("collapses consecutive duplicate nodes before building turn triples", () => {
    expect(collectTurnTriples([10, 10, 11, 12, 12, 13, 13])).toEqual([
      {
        fromOsmNodeId: "10",
        viaOsmNodeId: "11",
        toOsmNodeId: "12",
      },
      {
        fromOsmNodeId: "11",
        viaOsmNodeId: "12",
        toOsmNodeId: "13",
      },
    ]);
  });

  it("creates passages and segment profiles from low-frequency route-context observations without OSRM", async () => {
    matchTraceGeometryMock.mockResolvedValue([]);
    const { runtime, gnssFindMany, segmentCreateMany, observedCreateMany } = makeRuntime();

    const outcome = await runSegmentProfilesJob(runtime);

    expect(matchTraceGeometryMock).not.toHaveBeenCalled();
    expect(gnssFindMany).toHaveBeenCalledWith({
      where: {
        deviceId: "bus-1",
        OR: [
          {
            routePatternId: "pattern-1",
          },
          {
            routePatternId: null,
            externalRouteId: "route-1",
          },
        ],
        observedAt: {
          gte: expect.any(Date),
        },
      },
      orderBy: {
        observedAt: "asc",
      },
    });
    expect(segmentCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          routePatternId: "pattern-1",
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          sampleCount: 5,
        }),
        expect.objectContaining({
          routePatternId: "pattern-1",
          fromSequence: 2,
          toSequence: 3,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          sampleCount: 5,
        }),
      ]),
    });
    expect(observedCreateMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          routePatternId: "pattern-1",
          stopId: "stop-b",
          sequence: 2,
          deviceId: "bus-1",
          source: "GNSS_TRACE",
          externalRouteId: "route-1",
        }),
      ]),
    });
    expect(outcome.meta).toEqual(
      expect.objectContaining({
        segmentProfileCount: 2,
        observedStopPassageCount: 15,
        rawObservationCount: 15,
        traceCount: 5,
        projectedTraceCount: 5,
        osrmSkippedLowFrequencyTraceCount: 5,
      }),
    );
  });

  it("does not create profiles from reverse or impossible-jump traces", async () => {
    const observations = [
      makeObservation("2026-05-11", 0, 0.006),
      makeObservation("2026-05-11", 5, 0.003),
      makeObservation("2026-05-11", 10, 0),
      makeObservation("2026-05-12", 0, 0),
      {
        ...makeObservation("2026-05-12", 0, 0.006),
        observedAt: new Date("2026-05-12T08:00:10.000Z"),
      },
    ];
    const { runtime, segmentCreateMany, observedCreateMany } = makeRuntime({ observations });

    const outcome = await runSegmentProfilesJob(runtime);

    expect(segmentCreateMany).not.toHaveBeenCalled();
    expect(observedCreateMany).not.toHaveBeenCalled();
    expect(outcome.meta).toEqual(
      expect.objectContaining({
        segmentProfileCount: 0,
        nonMonotonicObservationCount: expect.any(Number),
        speedRejectedObservationCount: expect.any(Number),
      }),
    );
  });
});
