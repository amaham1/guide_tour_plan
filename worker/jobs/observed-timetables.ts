import { ServiceDayClass } from "@prisma/client";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const OBSERVED_PROFILE_SERVICE_DAY_CLASS = ServiceDayClass.WEEKDAY;
const MIN_SEGMENT_SAMPLE_COUNT = 5;
const MAX_PROFILE_SPREAD_MINUTES = 12;
const MIN_WINDOW_HALF_MINUTES = 2;
const MAX_WINDOW_HALF_MINUTES = 12;
const MAX_PROFILE_BUCKET_DRIFT_MINUTES = 60;

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

type SelectedSegmentProfile = {
  profile: ObservedTimetableSegmentProfile;
  bucketDistanceMinutes: number;
  estimatedArrivalMinutes: number;
};

function toBucketStartMinute(minutes: number) {
  const serviceMinutes = ((minutes % 1440) + 1440) % 1440;
  return Math.floor(serviceMinutes / 15) * 15;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function segmentKey(fromSequence: number, toSequence: number) {
  return `${fromSequence}:${toSequence}`;
}

function minuteDistance(left: number, right: number) {
  const distance = Math.abs(left - right);
  return Math.min(distance, 1440 - distance);
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

function findNearestStableProfile(
  profilesBySegment: Map<string, ObservedTimetableSegmentProfile[]>,
  fromSequence: number,
  toSequence: number,
  targetStartMinutes: number,
) {
  const targetBucketStartMinute = toBucketStartMinute(targetStartMinutes);
  const candidates = profilesBySegment.get(segmentKey(fromSequence, toSequence)) ?? [];
  let best:
    | {
        profile: ObservedTimetableSegmentProfile;
        bucketDistanceMinutes: number;
      }
    | null = null;

  for (const profile of candidates) {
    const bucketDistanceMinutes = minuteDistance(
      profile.bucketStartMinute,
      targetBucketStartMinute,
    );
    if (bucketDistanceMinutes > MAX_PROFILE_BUCKET_DRIFT_MINUTES) {
      continue;
    }

    if (
      !best ||
      bucketDistanceMinutes < best.bucketDistanceMinutes ||
      (bucketDistanceMinutes === best.bucketDistanceMinutes &&
        profile.sampleCount > best.profile.sampleCount) ||
      (bucketDistanceMinutes === best.bucketDistanceMinutes &&
        profile.sampleCount === best.profile.sampleCount &&
        profile.p90DurationSec - profile.medianDurationSec <
          best.profile.p90DurationSec - best.profile.medianDurationSec)
    ) {
      best = {
        profile,
        bucketDistanceMinutes,
      };
    }
  }

  return best;
}

function windowHalfMinutesForSegments(segments: SelectedSegmentProfile[]) {
  const maxSpreadSec = Math.max(
    ...segments.map(
      (segment) => segment.profile.p90DurationSec - segment.profile.medianDurationSec,
    ),
  );
  return clamp(
    Math.ceil(maxSpreadSec / 60),
    MIN_WINDOW_HALF_MINUTES,
    MAX_WINDOW_HALF_MINUTES,
  );
}

function minSampleCountForSegments(segments: SelectedSegmentProfile[]) {
  return Math.min(...segments.map((segment) => segment.profile.sampleCount));
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
  const profilesBySegment = new Map<string, ObservedTimetableSegmentProfile[]>();
  for (const profile of segmentProfiles.filter(isStableProfile)) {
    const key = segmentKey(profile.fromSequence, profile.toSequence);
    const profiles = profilesBySegment.get(key) ?? [];
    profiles.push(profile);
    profilesBySegment.set(key, profiles);
  }
  const officialAnchors = officialStopTimes
    .filter((stopTime) => patternStopBySequence.get(stopTime.sequence)?.stopId === stopTime.stopId)
    .slice()
    .sort((left, right) => left.sequence - right.sequence);

  const rows: ObservedDerivedStopTime[] = [];
  let skippedGapCount = 0;
  let completedGapCount = 0;
  let partiallyFilledGapCount = 0;

  if (officialAnchors.length < 2) {
    return {
      rows,
      skippedGapCount,
      anchorGapCount: 0,
      completedGapCount,
      partiallyFilledGapCount,
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

    const segments: SelectedSegmentProfile[] = [];
    let cursorMinutes = leftAnchor.departureMinutes;

    for (let sequence = leftAnchor.sequence; sequence < rightAnchor.sequence; sequence += 1) {
      const selectedProfile = findNearestStableProfile(
        profilesBySegment,
        sequence,
        sequence + 1,
        cursorMinutes,
      );

      if (!selectedProfile) {
        break;
      }

      cursorMinutes += Math.max(1, Math.round(selectedProfile.profile.medianDurationSec / 60));
      segments.push({
        profile: selectedProfile.profile,
        bucketDistanceMinutes: selectedProfile.bucketDistanceMinutes,
        estimatedArrivalMinutes: cursorMinutes,
      });
    }

    if (segments.length === 0) {
      skippedGapCount += 1;
      continue;
    }

    if (segments.length === sequenceGap) {
      const totalMedianDurationSec = segments.reduce(
        (sum, segment) => sum + segment.profile.medianDurationSec,
        0,
      );
      if (totalMedianDurationSec <= 0) {
        skippedGapCount += 1;
        continue;
      }

      const windowHalfMinutes = windowHalfMinutesForSegments(segments);
      const minSampleCount = minSampleCountForSegments(segments);
      const confidence = confidenceFromSampleCount(minSampleCount);

      let cumulativeDurationSec = 0;
      let gapRows = 0;
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
          sourceBucketStartMinute: segment.profile.bucketStartMinute,
          sourceServiceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
        });
        gapRows += 1;
      }

      if (gapRows > 0) {
        completedGapCount += 1;
      } else {
        skippedGapCount += 1;
      }
      continue;
    }

    let gapRows = 0;
    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index];
      const sequence = segment.profile.toSequence;

      if (sequence >= rightAnchor.sequence || officialStopTimeBySequence.has(sequence)) {
        continue;
      }

      const patternStop = patternStopBySequence.get(sequence);
      if (!patternStop) {
        continue;
      }

      const minutes = segment.estimatedArrivalMinutes;
      if (minutes <= leftAnchor.departureMinutes || minutes >= rightAnchor.arrivalMinutes) {
        continue;
      }

      const cumulativeSegments = segments.slice(0, index + 1);
      const windowHalfMinutes = windowHalfMinutesForSegments(cumulativeSegments);
      const minSampleCount = minSampleCountForSegments(cumulativeSegments);
      rows.push({
        stopId: patternStop.stopId,
        sequence,
        arrivalMinutes: minutes,
        departureMinutes: minutes,
        windowStartMinutes: Math.max(leftAnchor.departureMinutes, minutes - windowHalfMinutes),
        windowEndMinutes: Math.min(rightAnchor.arrivalMinutes, minutes + windowHalfMinutes),
        confidence: confidenceFromSampleCount(minSampleCount),
        anchorStartSequence: leftAnchor.sequence,
        anchorEndSequence: rightAnchor.sequence,
        sourceSampleCount: minSampleCount,
        sourceBucketStartMinute: segment.profile.bucketStartMinute,
        sourceServiceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
      });
      gapRows += 1;
    }

    if (gapRows > 0) {
      partiallyFilledGapCount += 1;
    } else {
      skippedGapCount += 1;
    }
  }

  return {
    rows,
    skippedGapCount,
    anchorGapCount: Math.max(0, officialAnchors.length - 1),
    completedGapCount,
    partiallyFilledGapCount,
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
    select: {
      id: true,
      routePatternId: true,
      stopTimes: {
        orderBy: {
          sequence: "asc",
        },
        select: {
          stopId: true,
          sequence: true,
          arrivalMinutes: true,
          departureMinutes: true,
        },
      },
      routePattern: {
        select: {
          id: true,
        },
      },
    },
  });
  const routePatternIds = [...new Set(trips.map((trip) => trip.routePatternId))];
  const [routePatterns, segmentProfiles] =
    routePatternIds.length === 0
      ? [[], []]
      : await Promise.all([
          runtime.prisma.routePattern.findMany({
            where: {
              id: {
                in: routePatternIds,
              },
            },
            select: {
              id: true,
              stops: {
                orderBy: {
                  sequence: "asc",
                },
                select: {
                  stopId: true,
                  sequence: true,
                },
              },
            },
          }),
          runtime.prisma.segmentTravelProfile.findMany({
            where: {
              routePatternId: {
                in: routePatternIds,
              },
              serviceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
              sampleCount: {
                gte: MIN_SEGMENT_SAMPLE_COUNT,
              },
            },
            select: {
              routePatternId: true,
              fromSequence: true,
              toSequence: true,
              serviceDayClass: true,
              bucketStartMinute: true,
              medianDurationSec: true,
              p90DurationSec: true,
              sampleCount: true,
            },
          }),
        ]);
  const patternStopsByRoutePatternId = new Map(
    routePatterns.map((routePattern) => [routePattern.id, routePattern.stops] as const),
  );
  const segmentProfilesByRoutePatternId = new Map<
    string,
    ObservedTimetableSegmentProfile[]
  >();
  for (const profile of segmentProfiles) {
    const profiles = segmentProfilesByRoutePatternId.get(profile.routePatternId) ?? [];
    profiles.push({
      fromSequence: profile.fromSequence,
      toSequence: profile.toSequence,
      serviceDayClass: profile.serviceDayClass,
      bucketStartMinute: profile.bucketStartMinute,
      medianDurationSec: profile.medianDurationSec,
      p90DurationSec: profile.p90DurationSec,
      sampleCount: profile.sampleCount,
    });
    segmentProfilesByRoutePatternId.set(profile.routePatternId, profiles);
  }

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
  let completedGapCount = 0;
  let partiallyFilledGapCount = 0;

  for (const trip of trips) {
    if (trip.stopTimes.length < 2) {
      skippedNoAnchorCount += 1;
      continue;
    }

    const patternStops = patternStopsByRoutePatternId.get(trip.routePatternId) ?? [];
    const segmentProfilesForPattern =
      segmentProfilesByRoutePatternId.get(trip.routePatternId) ?? [];
    const result = buildObservedDerivedStopTimes(
      patternStops.map((stop) => ({
        stopId: stop.stopId,
        sequence: stop.sequence,
      })),
      trip.stopTimes.map((stopTime) => ({
        stopId: stopTime.stopId,
        sequence: stopTime.sequence,
        arrivalMinutes: stopTime.arrivalMinutes,
        departureMinutes: stopTime.departureMinutes,
      })),
      segmentProfilesForPattern,
    );

    skippedGapCount += result.skippedGapCount;
    anchorGapCount += result.anchorGapCount;
    completedGapCount += result.completedGapCount;
    partiallyFilledGapCount += result.partiallyFilledGapCount;

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
      completedGapCount,
      partiallyFilledGapCount,
      routePatternCount: routePatternIds.length,
      loadedSegmentProfileCount: segmentProfiles.length,
      observedMappedPatternWithoutTrips,
      serviceDayClass: OBSERVED_PROFILE_SERVICE_DAY_CLASS,
      minSegmentSampleCount: MIN_SEGMENT_SAMPLE_COUNT,
      maxProfileSpreadMinutes: MAX_PROFILE_SPREAD_MINUTES,
      maxProfileBucketDriftMinutes: MAX_PROFILE_BUCKET_DRIFT_MINUTES,
    },
  };
}
