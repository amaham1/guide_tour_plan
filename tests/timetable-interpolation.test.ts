import { describe, expect, it } from "vitest";
import { fillPatternTimes } from "@/worker/jobs/timetables-xlsx";

describe("distance-based timetable interpolation", () => {
  it("interpolates using distanceFromStart instead of stop index", () => {
    const expanded = fillPatternTimes(
      {
        id: "source-1",
        routePatternId: "pattern-1",
        scheduleId: "sch-1",
        variantKey: "default",
        sourceLabel: null,
        effectiveDate: null,
        isActive: true,
        routePattern: {
          id: "pattern-1",
          routeId: "route-1",
          scheduleId: null,
          externalRouteId: "external-1",
          directionCode: "0",
          waypointOrder: 0,
          isActive: true,
          busType: 1,
          directionLabel: "A-B",
          displayName: "111 A-B",
          viaText: null,
          waypointText: null,
          serviceNote: null,
          effectiveDate: null,
          route: {
            id: "route-1",
            shortName: "111",
            displayName: "111",
            isActive: true,
            createdAt: new Date(),
          },
          stops: [
            {
              sequence: 1,
              distanceFromStart: 0,
              stop: {
                id: "stop-a",
                createdAt: new Date(),
                updatedAt: new Date(),
                latitude: 33.5,
                longitude: 126.5,
                displayName: "A",
                regionName: "제주",
                translations: [],
              },
            },
            {
              sequence: 2,
              distanceFromStart: 400,
              stop: {
                id: "stop-b",
                createdAt: new Date(),
                updatedAt: new Date(),
                latitude: 33.51,
                longitude: 126.51,
                displayName: "B",
                regionName: "제주",
                translations: [],
              },
            },
            {
              sequence: 3,
              distanceFromStart: 1000,
              stop: {
                id: "stop-c",
                createdAt: new Date(),
                updatedAt: new Date(),
                latitude: 33.52,
                longitude: 126.52,
                displayName: "C",
                regionName: "제주",
                translations: [],
              },
            },
          ],
          trips: [],
          scheduleSources: [],
        },
        trips: [],
      } as never,
      [
        { stopId: "stop-a", sequence: 1, score: 100 },
        { stopId: "stop-c", sequence: 3, score: 100 },
      ],
      {
        rowSequence: 1,
        rawVariantLabel: "default",
        times: ["08:00", "08:10"],
        estimatedColumns: [],
      } as never,
    );

    expect(expanded?.times).toEqual(["08:00", "08:04", "08:10"]);
    expect(expanded?.estimatedColumns).toContain(1);
  });
});
