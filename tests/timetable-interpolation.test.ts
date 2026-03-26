import { describe, expect, it } from "vitest";
import {
  derivePatternTimes,
  deriveRoughPatternTimes,
  fillPatternTimes,
} from "@/worker/jobs/timetables-xlsx";

describe("authoritative timetable expansion", () => {
  it("keeps sparse official stop times even when intermediate stops are missing", () => {
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
          stopProjections: [],
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

    expect(expanded).toMatchObject({
      startTime: "08:00",
      times: [
        {
          stopId: "stop-a",
          sequence: 1,
          time: "08:00",
        },
        {
          stopId: "stop-c",
          sequence: 3,
          time: "08:10",
        },
      ],
    });
  });

  it("derives intermediate stop times only between official anchors with reliable projections", () => {
    const derived = derivePatternTimes(
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
          directionLabel: "A-B-C",
          displayName: "111 A-B-C",
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
          stopProjections: [
            {
              sequence: 1,
              offsetMeters: 0,
              snapDistanceMeters: 15,
              confidence: 0.9,
            },
            {
              sequence: 2,
              offsetMeters: 800,
              snapDistanceMeters: 22,
              confidence: 0.88,
            },
            {
              sequence: 3,
              offsetMeters: 2000,
              snapDistanceMeters: 18,
              confidence: 0.91,
            },
          ],
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
                regionName: "?쒖＜",
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
                regionName: "?쒖＜",
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
                regionName: "?쒖＜",
                translations: [],
              },
            },
          ],
          trips: [],
          derivedTrips: [],
          scheduleSources: [],
          segmentProfiles: [],
          vehicleDeviceMaps: [],
        },
        trips: [],
        derivedTrips: [],
      } as never,
      [
        { stopId: "stop-a", sequence: 1, score: 100 },
        { stopId: "stop-c", sequence: 3, score: 100 },
      ],
      {
        rowSequence: 1,
        rawVariantLabel: "default",
        times: ["10:00", "10:25"],
        estimatedColumns: [],
      } as never,
    );

    expect(derived).toMatchObject({
      derivedStopCount: 1,
      anchorPairCount: 1,
      times: [
        {
          stopId: "stop-b",
          sequence: 2,
          time: "10:10",
          timeSource: "OFFICIAL_ANCHOR_INTERPOLATED",
          anchorStartSequence: 1,
          anchorEndSequence: 3,
        },
      ],
    });
  });

  it("derives rough distance-based windows when authoritative anchors exist but strict interpolation is too sparse", () => {
    const rough = deriveRoughPatternTimes(
      {
        id: "source-rough-1",
        routePatternId: "pattern-rough-1",
        scheduleId: "sch-rough-1",
        variantKey: "default",
        sourceLabel: null,
        effectiveDate: null,
        isActive: true,
        routePattern: {
          id: "pattern-rough-1",
          routeId: "route-rough-1",
          scheduleId: null,
          externalRouteId: "external-rough-1",
          directionCode: "0",
          waypointOrder: 0,
          isActive: true,
          busType: 1,
          directionLabel: "A-L",
          displayName: "111 A-L",
          viaText: null,
          waypointText: null,
          serviceNote: null,
          effectiveDate: null,
          route: {
            id: "route-rough-1",
            shortName: "111",
            displayName: "111",
            isActive: true,
            createdAt: new Date(),
          },
          stopProjections: [],
          stops: Array.from({ length: 12 }, (_, index) => ({
            sequence: index + 1,
            distanceFromStart: index * 1000,
            stop: {
              id: `stop-${index + 1}`,
              createdAt: new Date(),
              updatedAt: new Date(),
              latitude: 33.5 + index * 0.001,
              longitude: 126.5 + index * 0.001,
              displayName: `Stop ${index + 1}`,
              regionName: "제주",
              translations: [],
            },
          })),
          trips: [],
          derivedTrips: [],
          scheduleSources: [],
          segmentProfiles: [],
          vehicleDeviceMaps: [],
        },
        trips: [],
        derivedTrips: [],
      } as never,
      [
        { stopId: "stop-1", sequence: 1, score: 100 },
        { stopId: "stop-12", sequence: 12, score: 100 },
      ],
      {
        rowSequence: 1,
        rawVariantLabel: "default",
        times: ["10:00", "10:40"],
        estimatedColumns: [],
      } as never,
    );

    expect(rough).toMatchObject({
      derivedStopCount: 10,
      anchorPairCount: 1,
    });
    expect(rough?.times[0]).toMatchObject({
      stopId: "stop-2",
      sequence: 2,
      time: "10:04",
      timeSource: "DISTANCE_INTERPOLATED",
      windowStartMinutes: 595,
      windowEndMinutes: 613,
      anchorStartSequence: 1,
      anchorEndSequence: 12,
    });
    expect(rough?.times[4]).toMatchObject({
      stopId: "stop-6",
      sequence: 6,
      time: "10:18",
      timeSource: "DISTANCE_INTERPOLATED",
    });
  });

  it("skips rough interpolation when segment progress is not strictly increasing", () => {
    const rough = deriveRoughPatternTimes(
      {
        id: "source-rough-2",
        routePatternId: "pattern-rough-2",
        scheduleId: "sch-rough-2",
        variantKey: "default",
        sourceLabel: null,
        effectiveDate: null,
        isActive: true,
        routePattern: {
          id: "pattern-rough-2",
          routeId: "route-rough-2",
          scheduleId: null,
          externalRouteId: "external-rough-2",
          directionCode: "0",
          waypointOrder: 0,
          isActive: true,
          busType: 1,
          directionLabel: "A-C",
          displayName: "111 A-C",
          viaText: null,
          waypointText: null,
          serviceNote: null,
          effectiveDate: null,
          route: {
            id: "route-rough-2",
            shortName: "111",
            displayName: "111",
            isActive: true,
            createdAt: new Date(),
          },
          stopProjections: [],
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
              distanceFromStart: 1200,
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
              distanceFromStart: 1200,
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
          derivedTrips: [],
          scheduleSources: [],
          segmentProfiles: [],
          vehicleDeviceMaps: [],
        },
        trips: [],
        derivedTrips: [],
      } as never,
      [
        { stopId: "stop-a", sequence: 1, score: 100 },
        { stopId: "stop-c", sequence: 3, score: 100 },
      ],
      {
        rowSequence: 1,
        rawVariantLabel: "default",
        times: ["10:00", "10:12"],
        estimatedColumns: [],
      } as never,
    );

    expect(rough).toBeNull();
  });

  it("accepts strong canonical stop matches that are not exact string-equals", () => {
    const expanded = fillPatternTimes(
      {
        id: "source-2",
        routePatternId: "pattern-2",
        scheduleId: "sch-2",
        variantKey: "default",
        sourceLabel: null,
        effectiveDate: null,
        isActive: true,
        routePattern: {
          id: "pattern-2",
          routeId: "route-2",
          scheduleId: null,
          externalRouteId: "external-2",
          directionCode: "0",
          waypointOrder: 0,
          isActive: true,
          busType: 1,
          directionLabel: "고산-제주터미널",
          displayName: "102 고산-제주터미널",
          viaText: null,
          waypointText: null,
          serviceNote: null,
          effectiveDate: null,
          stopProjections: [],
          route: {
            id: "route-2",
            shortName: "102",
            displayName: "102",
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
                displayName: "고산환승정류장(고산1리 고산성당 앞)[동]",
                regionName: "제주",
                translations: [],
              },
            },
            {
              sequence: 2,
              distanceFromStart: 1000,
              stop: {
                id: "stop-b",
                createdAt: new Date(),
                updatedAt: new Date(),
                latitude: 33.51,
                longitude: 126.51,
                displayName: "제주국제공항(하차전용)",
                regionName: "제주",
                translations: [],
              },
            },
            {
              sequence: 3,
              distanceFromStart: 2000,
              stop: {
                id: "stop-c",
                createdAt: new Date(),
                updatedAt: new Date(),
                latitude: 33.52,
                longitude: 126.52,
                displayName: "제주버스터미널(종점)",
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
        { stopId: "stop-a", sequence: 1, score: 70 },
        { stopId: "stop-b", sequence: 2, score: 70 },
        { stopId: "stop-c", sequence: 3, score: 95 },
      ],
      {
        rowSequence: 1,
        rawVariantLabel: "102번",
        times: ["06:00", "07:10", "07:30"],
        estimatedColumns: [],
      } as never,
    );

    expect(expanded).toMatchObject({
      startTime: "06:00",
      times: [
        {
          stopId: "stop-a",
          sequence: 1,
          time: "06:00",
        },
        {
          stopId: "stop-b",
          sequence: 2,
          time: "07:10",
        },
        {
          stopId: "stop-c",
          sequence: 3,
          time: "07:30",
        },
      ],
    });
  });
});
