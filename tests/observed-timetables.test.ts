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

  it("materializes SEGMENT_PROFILE rows without overwriting official anchors", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const createMany = vi.fn();
    const runtime = {
      prisma: {
        trip: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "trip-1",
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
                stops: [
                  { stopId: "stop-a", sequence: 1 },
                  { stopId: "stop-b", sequence: 2 },
                  { stopId: "stop-c", sequence: 3 },
                ],
                segmentProfiles: [
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
              },
            },
          ]),
        },
        derivedStopTime: {
          deleteMany,
          createMany,
        },
        routePattern: {
          count: vi.fn().mockResolvedValue(0),
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
