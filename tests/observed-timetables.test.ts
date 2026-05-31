import { ServiceDayClass } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";
import {
  buildObservedDerivedStopTimes,
  runObservedTimetablesJob,
} from "@/worker/jobs/observed-timetables";

describe("observed timetable derivation", () => {
  it("fills only missing stops between official anchors with stable segment profiles", () => {
    const result = buildObservedDerivedStopTimes(
      [
        { stopId: "stop-a", sequence: 1 },
        { stopId: "stop-b", sequence: 2 },
        { stopId: "stop-c", sequence: 3 },
      ],
      [
        {
          stopId: "stop-a",
          sequence: 1,
          arrivalMinutes: 480,
          departureMinutes: 480,
        },
        {
          stopId: "stop-c",
          sequence: 3,
          arrivalMinutes: 510,
          departureMinutes: 510,
        },
      ],
      [
        {
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 480,
          medianDurationSec: 600,
          p90DurationSec: 720,
          sampleCount: 8,
        },
        {
          fromSequence: 2,
          toSequence: 3,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 480,
          medianDurationSec: 1200,
          p90DurationSec: 1320,
          sampleCount: 9,
        },
      ],
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        stopId: "stop-b",
        sequence: 2,
        arrivalMinutes: 490,
        departureMinutes: 490,
        sourceSampleCount: 8,
        sourceBucketStartMinute: 480,
        sourceServiceDayClass: ServiceDayClass.WEEKDAY,
      }),
    ]);
  });

  it("skips gaps when samples are too sparse or p90 spread is unstable", () => {
    const result = buildObservedDerivedStopTimes(
      [
        { stopId: "stop-a", sequence: 1 },
        { stopId: "stop-b", sequence: 2 },
        { stopId: "stop-c", sequence: 3 },
      ],
      [
        {
          stopId: "stop-a",
          sequence: 1,
          arrivalMinutes: 480,
          departureMinutes: 480,
        },
        {
          stopId: "stop-c",
          sequence: 3,
          arrivalMinutes: 510,
          departureMinutes: 510,
        },
      ],
      [
        {
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 480,
          medianDurationSec: 600,
          p90DurationSec: 1500,
          sampleCount: 8,
        },
        {
          fromSequence: 2,
          toSequence: 3,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 480,
          medianDurationSec: 1200,
          p90DurationSec: 1320,
          sampleCount: 4,
        },
      ],
    );

    expect(result.rows).toEqual([]);
    expect(result.skippedGapCount).toBe(1);
  });

  it("partially fills reachable missing stops when the full anchor gap is not profiled yet", () => {
    const result = buildObservedDerivedStopTimes(
      [
        { stopId: "stop-a", sequence: 1 },
        { stopId: "stop-b", sequence: 2 },
        { stopId: "stop-c", sequence: 3 },
        { stopId: "stop-d", sequence: 4 },
      ],
      [
        {
          stopId: "stop-a",
          sequence: 1,
          arrivalMinutes: 480,
          departureMinutes: 480,
        },
        {
          stopId: "stop-d",
          sequence: 4,
          arrivalMinutes: 540,
          departureMinutes: 540,
        },
      ],
      [
        {
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 480,
          medianDurationSec: 600,
          p90DurationSec: 720,
          sampleCount: 8,
        },
      ],
    );

    expect(result.rows).toEqual([
      expect.objectContaining({
        stopId: "stop-b",
        sequence: 2,
        arrivalMinutes: 490,
        departureMinutes: 490,
        sourceSampleCount: 8,
        sourceBucketStartMinute: 480,
      }),
    ]);
    expect(result.partiallyFilledGapCount).toBe(1);
    expect(result.skippedGapCount).toBe(0);
  });

  it("uses nearby time buckets but ignores profiles that are too far from the trip time", () => {
    const patternStops = [
      { stopId: "stop-a", sequence: 1 },
      { stopId: "stop-b", sequence: 2 },
      { stopId: "stop-c", sequence: 3 },
    ];
    const officialStopTimes = [
      {
        stopId: "stop-a",
        sequence: 1,
        arrivalMinutes: 480,
        departureMinutes: 480,
      },
      {
        stopId: "stop-c",
        sequence: 3,
        arrivalMinutes: 540,
        departureMinutes: 540,
      },
    ];

    expect(
      buildObservedDerivedStopTimes(patternStops, officialStopTimes, [
        {
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 540,
          medianDurationSec: 600,
          p90DurationSec: 720,
          sampleCount: 8,
        },
      ]).rows,
    ).toEqual([
      expect.objectContaining({
        stopId: "stop-b",
        sequence: 2,
        arrivalMinutes: 490,
        sourceBucketStartMinute: 540,
      }),
    ]);

    expect(
      buildObservedDerivedStopTimes(patternStops, officialStopTimes, [
        {
          fromSequence: 1,
          toSequence: 2,
          serviceDayClass: ServiceDayClass.WEEKDAY,
          bucketStartMinute: 615,
          medianDurationSec: 600,
          p90DurationSec: 720,
          sampleCount: 8,
        },
      ]).rows,
    ).toEqual([]);
  });

  it("materializes SEGMENT_PROFILE rows without overwriting official anchors", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn();
    const runtime = {
      prisma: {
        trip: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "trip-1",
              routePatternId: "pattern-1",
              stopTimes: [
                {
                  stopId: "stop-a",
                  sequence: 1,
                  arrivalMinutes: 480,
                  departureMinutes: 480,
                },
                {
                  stopId: "stop-c",
                  sequence: 3,
                  arrivalMinutes: 510,
                  departureMinutes: 510,
                },
              ],
              routePattern: {
                id: "pattern-1",
              },
            },
          ]),
        },
        derivedStopTime: {
          deleteMany,
          createMany,
        },
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-1",
              stops: [
                { stopId: "stop-a", sequence: 1 },
                { stopId: "stop-b", sequence: 2 },
                { stopId: "stop-c", sequence: 3 },
              ],
            },
          ]),
          count: vi.fn().mockResolvedValue(0),
        },
        segmentTravelProfile: {
          findMany: vi.fn().mockResolvedValue([
            {
              routePatternId: "pattern-1",
              fromSequence: 1,
              toSequence: 2,
              serviceDayClass: ServiceDayClass.WEEKDAY,
              bucketStartMinute: 480,
              medianDurationSec: 600,
              p90DurationSec: 720,
              sampleCount: 8,
            },
            {
              routePatternId: "pattern-1",
              fromSequence: 2,
              toSequence: 3,
              serviceDayClass: ServiceDayClass.WEEKDAY,
              bucketStartMinute: 480,
              medianDurationSec: 1200,
              p90DurationSec: 1320,
              sampleCount: 9,
            },
          ]),
        },
      },
    } as never;

    const outcome = await runObservedTimetablesJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(deleteMany).toHaveBeenCalledWith({
      where: {
        tripId: {
          in: ["trip-1"],
        },
        timeSource: "SEGMENT_PROFILE",
      },
    });
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          tripId: "trip-1",
          stopId: "stop-b",
          sequence: 2,
          arrivalMinutes: 490,
          timeSource: "SEGMENT_PROFILE",
          sourceSampleCount: 8,
        }),
      ],
    });
  });
});
