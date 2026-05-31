import {
  buildTerminalHint,
  extractViaStops,
  parseScheduleTableRows,
  type ParsedScheduleTrip,
} from "@/worker/jobs/bus-jeju-parser";
import { ensureDailyServiceCalendar, parseClockToMinutes } from "@/worker/jobs/helpers";
import {
  AUTHORITATIVE_MATCH_MINIMUM_COVERAGE,
  AUTHORITATIVE_MINIMUM_STOP_SCORE,
  isAuthoritativeScheduleMatch,
} from "@/worker/jobs/schedule-authoritativeness";
import { chooseBestPatternMatch } from "@/worker/jobs/schedule-pattern-matching";
import { fetchScheduleTable } from "@/worker/jobs/schedule-table";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";
import {
  buildMatchablePattern,
  createDerivationDiagnostics,
  derivePatternTimesInternal,
  deriveRoughPatternTimesInternal,
  fillPatternTimes,
  mergeReasonBreakdown,
  type ScheduleSourceContext,
} from "@/worker/jobs/timetable-derivation";

export {
  derivePatternTimes,
  deriveRoughPatternTimes,
  fillPatternTimes,
} from "@/worker/jobs/timetable-derivation";

type TripStopProfile = {
  columnIndexes: number[];
  stopNames: string[];
};

function isAcceptedPatternMatch(
  source: ScheduleSourceContext,
  stopNames: string[],
  match: NonNullable<ReturnType<typeof chooseBestPatternMatch>>,
) {
  return (
    match.patternId === source.routePatternId &&
    isAuthoritativeScheduleMatch(stopNames, source.routePattern.stops.length, match)
  );
}

function buildTripStopProfile(stopNames: string[], row: ParsedScheduleTrip) {
  const columnIndexes = row.times
    .map((value, index) => (value ? index : -1))
    .filter((index) => index >= 0);

  if (columnIndexes.length < 2) {
    return null;
  }

  return {
    columnIndexes,
    stopNames: columnIndexes.map((index) => stopNames[index]),
  } satisfies TripStopProfile;
}

export async function runTimetablesXlsxJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  await ensureDailyServiceCalendar(runtime.prisma);

  const scheduleSources = await runtime.prisma.routePatternScheduleSource.findMany({
    where: {
      isActive: true,
    },
    include: {
      routePattern: {
        include: {
          route: true,
          stopProjections: {
            orderBy: {
              sequence: "asc",
            },
          },
          stops: {
            orderBy: {
              sequence: "asc",
            },
            include: {
              stop: {
                include: {
                  translations: true,
                },
              },
            },
          },
        },
      },
    },
  });

  let officialTripCount = 0;
  let derivedStopTimeCount = 0;
  let strictDerivedStopTimeCount = 0;
  let roughDerivedStopTimeCount = 0;
  let eligibleButUnfilledTripCount = 0;
  let failureCount = 0;
  const skipReasonBreakdown = new Map<string, number>();
  const unmatchedSources: Array<{
    scheduleId: string;
    variantKey: string;
    routePatternId: string;
    reason: string;
  }> = [];

  for (const source of scheduleSources) {
    try {
      const { rows } = await fetchScheduleTable(runtime, source.scheduleId);
      const table = parseScheduleTableRows(rows);

      // Clear the previous materialization for this source before deciding whether
      // the latest table still exposes a usable variant.
      await runtime.prisma.trip.deleteMany({
        where: {
          scheduleSourceId: source.id,
        },
      });

      const variant =
        table.variants.find((item) => item.variantKey === source.variantKey) ??
        (source.variantKey === "default" && table.variants.length === 1 ? table.variants[0] : null);

      if (!variant) {
        failureCount += 1;
        unmatchedSources.push({
          scheduleId: source.scheduleId,
          variantKey: source.variantKey,
          routePatternId: source.routePatternId,
          reason: "MISSING_VARIANT_ROWS",
        });
        continue;
      }

      let sourceTripCount = 0;

      for (const row of variant.trips) {
        const tripStopProfile = buildTripStopProfile(table.stopNames, row);
        if (!tripStopProfile) {
          continue;
        }

        const match = chooseBestPatternMatch(
          {
            variantKey: source.variantKey,
            stopNames: tripStopProfile.stopNames,
            terminalHint: buildTerminalHint(source.routePattern.waypointText),
            viaStops: extractViaStops(source.routePattern.viaText),
            minimumCoverage: AUTHORITATIVE_MATCH_MINIMUM_COVERAGE,
            minimumStopScore: AUTHORITATIVE_MINIMUM_STOP_SCORE,
          },
          [buildMatchablePattern(source)],
        );

        if (!match || !isAcceptedPatternMatch(source, tripStopProfile.stopNames, match)) {
          continue;
        }

        const official = fillPatternTimes(
          source,
          match.matchedStops,
          row,
          tripStopProfile.columnIndexes,
        );
        if (!official) {
          continue;
        }

        const trip = await runtime.prisma.trip.create({
          data: {
            id: `${source.routePatternId}:schedule:${source.scheduleId}:variant:${source.variantKey}:row:${row.rowSequence}`,
            routePatternId: source.routePatternId,
            serviceCalendarId: "svc-daily",
            scheduleSourceId: source.id,
            headsign: source.routePattern.directionLabel,
            startTime: official.startTime,
            rowLabel: row.rawVariantLabel,
          },
        });
        sourceTripCount += 1;

        await runtime.prisma.stopTime.createMany({
          data: official.times.map((timePoint) => {
            const minutes = parseClockToMinutes(timePoint.time) ?? 0;
            return {
              tripId: trip.id,
              stopId: timePoint.stopId,
              sequence: timePoint.sequence,
              arrivalMinutes: minutes,
              departureMinutes: minutes,
              isEstimated: false,
              timeSource: "OFFICIAL",
              confidence: 1,
            };
          }),
        });
        officialTripCount += 1;

        const strictDiagnostics = createDerivationDiagnostics();
        const roughDiagnostics = createDerivationDiagnostics();
        const strictResult = derivePatternTimesInternal(
          source,
          match.matchedStops,
          row,
          tripStopProfile.columnIndexes,
          strictDiagnostics,
        );
        const roughDerived = deriveRoughPatternTimesInternal(
          source,
          match.matchedStops,
          row,
          tripStopProfile.columnIndexes,
          roughDiagnostics,
        );
        mergeReasonBreakdown(skipReasonBreakdown, strictDiagnostics.skipReasonCounts);
        mergeReasonBreakdown(skipReasonBreakdown, roughDiagnostics.skipReasonCounts);

        strictDerivedStopTimeCount += strictResult?.derivedStopCount ?? 0;

        const strictSequences = new Set(
          strictResult?.times.map((timePoint) => timePoint.sequence) ?? [],
        );
        const persistedRoughTimes =
          roughDerived?.times.filter((timePoint) => !strictSequences.has(timePoint.sequence)) ?? [];
        roughDerivedStopTimeCount += persistedRoughTimes.length;
        const combinedDerivedTimes = [
          ...(strictResult?.times ?? []),
          ...persistedRoughTimes,
        ];

        if (combinedDerivedTimes.length === 0) {
          if (
            strictDiagnostics.eligibleAnchorPairs > 0 ||
            roughDiagnostics.eligibleAnchorPairs > 0
          ) {
            eligibleButUnfilledTripCount += 1;
          }
          continue;
        }

        await runtime.prisma.derivedStopTime.createMany({
          data: combinedDerivedTimes.map((timePoint) => {
            const minutes = parseClockToMinutes(timePoint.time) ?? 0;
            return {
              tripId: trip.id,
              stopId: timePoint.stopId,
              sequence: timePoint.sequence,
              arrivalMinutes: minutes,
              departureMinutes: minutes,
              windowStartMinutes: timePoint.windowStartMinutes,
              windowEndMinutes: timePoint.windowEndMinutes,
              timeSource: timePoint.timeSource,
              confidence: timePoint.confidence,
              anchorStartSequence: timePoint.anchorStartSequence,
              anchorEndSequence: timePoint.anchorEndSequence,
            };
          }),
        });
        derivedStopTimeCount += combinedDerivedTimes.length;
      }

      if (sourceTripCount === 0) {
        failureCount += 1;
        unmatchedSources.push({
          scheduleId: source.scheduleId,
          variantKey: source.variantKey,
          routePatternId: source.routePatternId,
          reason: "NO_MATCHING_ROWS_FOR_PATTERN",
        });
      }
    } catch (error) {
      failureCount += 1;
      unmatchedSources.push({
        scheduleId: source.scheduleId,
        variantKey: source.variantKey,
        routePatternId: source.routePatternId,
        reason: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      });
    }
  }

  return {
    processedCount: scheduleSources.length,
    successCount: officialTripCount,
    failureCount,
    meta: {
      scheduleSources: scheduleSources.length,
      trips: officialTripCount,
      derivedStopTimes: derivedStopTimeCount,
      strictDerivedStopTimes: strictDerivedStopTimeCount,
      roughDerivedStopTimes: roughDerivedStopTimeCount,
      eligibleButUnfilledTrips: eligibleButUnfilledTripCount,
      skipReasonBreakdown: [...skipReasonBreakdown.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
      unmatchedSources,
    },
  };
}
