import { ServiceDayClass } from "@prisma/client";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const OBSERVED_PROFILE_SERVICE_DAY_CLASS = ServiceDayClass.WEEKDAY;
const MIN_SEGMENT_SAMPLE_COUNT = 5;
const MAX_PROFILE_SPREAD_MINUTES = 12;
const MIN_WINDOW_HALF_MINUTES = 2;
const MAX_WINDOW_HALF_MINUTES = 12;

export type ObservedTimetablePatternStop = {
  stopId: string;
  sequence: number;
};

export type ObservedTimetableOfficialStopTime = {
  stopId: string;
  sequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
};

export type ObservedTimetableSegmentProfile = {
  fromSequence: number;
  toSequence: number;
  serviceDayClass: ServiceDayClass;
  bucketStartMinute: number;
  medianDurationSec: number;
  p90DurationSec: number;
  sampleCount: number;
};

export type ObservedDerivedStopTime = {
  stopId: string;
  sequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
  windowStartMinutes: number;
  windowEndMinutes: number;
  confidence: number;
  anchorStartSequence: number;
  anchorEndSequence: number;
  sourceSampleCount: number;
  sourceBucketStartMinute: number;
  sourceServiceDayClass: ServiceDayClass;
};

function toBucketStartMinute(minutes: number) {
  const serviceMinutes = ((minutes % 1440) + 1440) % 1440;
  return Math.floor(serviceMinutes / 15) * 15;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function profileKey(fromSequence: number, toSequence: number, bucketStartMinute: number) {
  return `${fromSequence}:${toSequence}:${bucketStartMinute}`;
}

function isStableProfile(profile: ObservedTimetableSegmentProfile) {
  if (profile.serviceDayClass !== OBSERVED_PROFILE_SERVICE_DAY_CLASS) {
    return false;
  }

  if (
    profile.sampleCount < MIN_SEGMENT_SAMPLE_COUNT ||
    profile.medianDurationSec <= 0 ||
    profile.p90DurationSec < profile.medianDurationSec
  ) {
    return false;
  }

  return profile.p90DurationSec - profile.medianDurationSec <= MAX_PROFILE_SPREAD_MINUTES * 60;
}

function confidenceFromSampleCount(sampleCount: number) {
  return Number(Math.min(0.95, 0.65 + Math.min(sampleCount, 30) / 100).toFixed(3));
}

export function buildObservedDerivedStopTimes(
  patternStops: ObservedTimetablePatternStop[],
  officialStopTimes: ObservedTimetableOfficialStopTime[],
  segmentProfiles: ObservedTimetableSegmentProfile[],
) {
  const patternStopBySequence = new Map(
    patternStops.map((stop) => [stop.sequence, stop] as const),
  );
  const officialStopTimeBySequence = new Map(
    officialStopTimes.map((stopTime) => [stopTime.sequence, stopTime] as const),
  );
  const stableProfileByKey = new Map(
    segmentProfiles
      .filter(isStableProfile)
      .map((profile) => [
        profileKey(profile.fromSequence, profile.toSequence, profile.bucketStartMinute),
        profile,
      ] as const),
  );
  const officialAnchors = officialStopTimes
    .filter((stopTime) => patternStopBySequence.get(stopTime.sequence)?.stopId === stopTime.stopId)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);

  const rows: ObservedDerivedStopTime[] = [];
  let skippedGapCount = 0;

  if (officialAnchors.length < 2) {
    return {
      rows,
      skippedGapCount,
      anchorGapCount: 0,
    };
  }

  for (let anchorIndex = 1; anchorIndex < officialAnchors.length; anchorIndex += 1) {
    const leftAnchor = officialAnchors[anchorIndex - 1];
    const rightAnchor = officialAnchors[anchorIndex];
    const sequenceGap = rightAnchor.sequence - leftAnchor.sequence;
    const anchorSpanMinutes = rightAnchor.arrivalMinutes - leftAnchor.departureMinutes;

    if (sequenceGap <= 1 || anchorSpanMinutes <= 0) {
      continue;
    }

    const segments: Array<{
      profile: ObservedTimetableSegmentProfile;
      bucketStartMinute: number;
    }> = [];
    let cursorMinutes = leftAnchor.departureMinutes;
    let gapComplete = true;

    for (let sequence = leftAnchor.sequence; sequence < rightAnchor.sequence; sequence += 1) {
      const bucketStartMinute = toBucketStartMinute(cursorMinutes);
      const profile = stableProfileByKey.get(
        profileKey(sequence, sequence + 1, bucketStartMinute),
      );

      if (!profile) {
        gapComplete = false;
        break;
      }

      segments.push({ profile, bucketStartMinute });
      cursorMinutes += Math.max(1, Math.round(profile.medianDurationSec / 60));
    }

    if (!gapComplete || segments.length !== sequenceGap) {
      skippedGapCount += 1;
      continue;
    }

    const totalMedianDurationSec = segments.reduce(
      (sum, segment) => sum + segment.profile.medianDurationSec,
      0,
    );
    if (totalMedianDurationSec <= 0) {
      skippedGapCount += 1;
      continue;
    }

    const maxSpreadSec = Math.max(
      ...segments.map((segment) => segment.profile.p90DurationSec - segment.profile.medianDurationSec),
    );
    const windowHalfMinutes = clamp(
      Math.ceil(maxSpreadSec / 60),
      MIN_WINDOW_HALF_MINUTES,
      MAX_WINDOW_HALF_MINUTES,
    );
    const minSampleCount = Math.min(...segments.map((segment) => segment.profile.sampleCount));
    const confidence = confidenceFromSampleCount(minSampleCount);

    let cumulativeDurationSec = 0;
    for (const segment of segments) {
      cumulativeDurationSec += segment.profile.medianDurationSec;
      const sequence = segment.profile.toSequence;

      if (sequence >= rightAnchor.sequence || officialStopTimeBySequence.has(sequence)) {
        continue;
      }

      const patternStop = patternStopBySequence.get(sequence);
      if (!patternStop) {
        continue;
      }

      const ratio = cumulativeDurationSec / totalMedianDurationSec;
      const minutes = leftAnchor.departureMinutes + Math.round(anchorSpanMinutes * ratio);
      rows.push({
        stopId: patternStop.stopId,
        sequence,
        arrivalMinutes: minutes,
        departureMinutes: minutes,
        windowStartMinutes: Math.max(0, minutes - windowHalfMinutes),
        windowEndMinutes: minutes + windowHalfMinutes,
        confidence,
        anchorStartSequence: leftAnchor.sequence,
        anchorEndSequence: rightAnchor.sequence,
        sourceSampleCount: minSampleCount,
        sourceBucketStartMinute: segment.bucketStartMinute,
        sourceServiceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
      });
    }
  }

  return {
    rows,
    skippedGapCount,
    anchorGapCount: Math.max(0, officialAnchors.length - 1),
  };
}

export async function runObservedTimetablesJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const trips = await runtime.prisma.trip.findMany({
    where: {
      scheduleSource: {
        is: {
          isActive: true,
        },
      },
      routePattern: {
        isActive: true,
        route: {
          isActive: true,
        },
      },
      stopTimes: {
        some: {},
      },
    },
    include: {
      stopTimes: {
        orderBy: {
          sequence: "asc",
        },
      },
      routePattern: {
        include: {
          stops: {
            orderBy: {
              sequence: "asc",
            },
          },
          segmentProfiles: {
            where: {
              serviceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
              sampleCount: {
                gte: MIN_SEGMENT_SAMPLE_COUNT,
              },
            },
          },
        },
      },
    },
  });

  const tripIds = trips.map((trip) => trip.id);
  const deletedExisting =
    tripIds.length === 0
      ? { count: 0 }
      : await runtime.prisma.derivedStopTime.deleteMany({
          where: {
            tripId: {
              in: tripIds,
            },
            timeSource: "SEGMENT_PROFILE",
          },
        });
  const observedRows = [];
  let tripsWithObservedRows = 0;
  let skippedNoAnchorCount = 0;
  let skippedGapCount = 0;
  let anchorGapCount = 0;

  for (const trip of trips) {
    if (trip.stopTimes.length < 2) {
      skippedNoAnchorCount += 1;
      continue;
    }

    const result = buildObservedDerivedStopTimes(
      trip.routePattern.stops.map((stop) => ({
        stopId: stop.stopId,
        sequence: stop.sequence,
      })),
      trip.stopTimes.map((stopTime) => ({
        stopId: stopTime.stopId,
        sequence: stopTime.sequence,
        arrivalMinutes: stopTime.arrivalMinutes,
        departureMinutes: stopTime.departureMinutes,
      })),
      trip.routePattern.segmentProfiles,
    );

    skippedGapCount += result.skippedGapCount;
    anchorGapCount += result.anchorGapCount;

    if (result.rows.length === 0) {
      continue;
    }

    tripsWithObservedRows += 1;
    observedRows.push(
      ...result.rows.map((row) => ({
        tripId: trip.id,
        stopId: row.stopId,
        sequence: row.sequence,
        arrivalMinutes: row.arrivalMinutes,
        departureMinutes: row.departureMinutes,
        windowStartMinutes: row.windowStartMinutes,
        windowEndMinutes: row.windowEndMinutes,
        timeSource: "SEGMENT_PROFILE" as const,
        confidence: row.confidence,
        anchorStartSequence: row.anchorStartSequence,
        anchorEndSequence: row.anchorEndSequence,
        sourceSampleCount: row.sourceSampleCount,
        sourceBucketStartMinute: row.sourceBucketStartMinute,
        sourceServiceDayClass: row.sourceServiceDayClass,
      })),
    );
  }

  if (observedRows.length > 0) {
    await runtime.prisma.derivedStopTime.createMany({
      data: observedRows,
    });
  }

  const observedMappedPatternWithoutTrips = await runtime.prisma.routePattern.count({
    where: {
      isActive: true,
      route: {
        isActive: true,
      },
      vehicleDeviceMaps: {
        some: {},
      },
      trips: {
        none: {
          scheduleSource: {
            is: {
              isActive: true,
            },
          },
        },
      },
    },
  });

  return {
    processedCount: trips.length,
    successCount: observedRows.length,
    failureCount: 0,
    meta: {
      trips: trips.length,
      tripsWithObservedRows,
      derivedStopTimes: observedRows.length,
      deletedExistingSegmentProfileRows: deletedExisting.count,
      skippedNoAnchorCount,
      skippedGapCount,
      anchorGapCount,
      observedMappedPatternWithoutTrips,
      serviceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
      minSegmentSampleCount: MIN_SEGMENT_SAMPLE_COUNT,
      maxProfileSpreadMinutes: MAX_PROFILE_SPREAD_MINUTES,
    },
  };
}
