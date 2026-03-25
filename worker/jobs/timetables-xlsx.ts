import type {
  Route,
  RoutePattern,
  RoutePatternScheduleSource,
  Stop,
  StopTranslation,
} from "@prisma/client";
import {
  buildTerminalHint,
  extractViaStops,
  parseScheduleTableRows,
  type ParsedScheduleTrip,
} from "@/worker/jobs/bus-jeju-parser";
import {
  ensureDailyServiceCalendar,
  minutesToClock,
  parseClockToMinutes,
} from "@/worker/jobs/helpers";
import {
  chooseBestPatternMatch,
  type PatternStopMatch,
  type MatchableRoutePattern,
} from "@/worker/jobs/schedule-pattern-matching";
import { fetchScheduleTable } from "@/worker/jobs/schedule-table";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

type ScheduleSourceContext = RoutePatternScheduleSource & {
  routePattern: RoutePattern & {
    route: Route;
    stops: Array<{
      sequence: number;
      distanceFromStart: number;
      stop: Stop & {
        translations: StopTranslation[];
      };
    }>;
  };
};

function buildMatchablePattern(source: ScheduleSourceContext): MatchableRoutePattern {
  return {
    id: source.routePattern.id,
    shortName: source.routePattern.route.shortName,
    displayName: source.routePattern.displayName,
    directionLabel: source.routePattern.directionLabel,
    stops: source.routePattern.stops.map((item) => ({
      stopId: item.stop.id,
      sequence: item.sequence,
      displayName: item.stop.displayName,
      translations: item.stop.translations.map((translation) => translation.displayName),
    })),
  };
}

function buildPatternStopIndex(source: ScheduleSourceContext) {
  return new Map(
    source.routePattern.stops.map((item, index) => [`${item.stop.id}:${item.sequence}`, index]),
  );
}

export function fillPatternTimes(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
) {
  const stopIndex = buildPatternStopIndex(source);
  const distanceByIndex = source.routePattern.stops.map((item) => item.distanceFromStart);
  const values = Array<number | null>(source.routePattern.stops.length).fill(null);
  const estimated = new Set<number>();

  matchedStops.forEach((matchedStop, headerIndex) => {
    const patternIndex = stopIndex.get(`${matchedStop.stopId}:${matchedStop.sequence}`);
    if (patternIndex === undefined) {
      return;
    }

    const minutes = parseClockToMinutes(row.times[headerIndex]);
    if (minutes === null) {
      return;
    }

    values[patternIndex] = minutes;
    if (row.estimatedColumns.includes(headerIndex)) {
      estimated.add(patternIndex);
    }
  });

  const knownIndexes = values
    .map((value, index) => ({
      value,
      index,
      distanceFromStart: distanceByIndex[index] ?? index * 1_000,
    }))
    .filter((item): item is { value: number; index: number; distanceFromStart: number } => item.value !== null);

  if (knownIndexes.length < 2) {
    return null;
  }

  for (let cursor = 0; cursor < knownIndexes.length - 1; cursor += 1) {
    const start = knownIndexes[cursor];
    const end = knownIndexes[cursor + 1];
    const spanDistance = end.distanceFromStart - start.distanceFromStart;
    if (spanDistance <= 0 || end.index - start.index <= 1) {
      continue;
    }

    for (let index = start.index + 1; index < end.index; index += 1) {
      const pointDistance = distanceByIndex[index] ?? start.distanceFromStart;
      const ratio = Math.max(
        0,
        Math.min(1, (pointDistance - start.distanceFromStart) / spanDistance),
      );
      values[index] = Math.round(start.value + (end.value - start.value) * ratio);
      estimated.add(index);
    }
  }

  const leadingSlopeDistance = Math.max(
    1,
    knownIndexes[1].distanceFromStart - knownIndexes[0].distanceFromStart,
  );
  const leadingSlope = (knownIndexes[1].value - knownIndexes[0].value) / leadingSlopeDistance;
  for (let index = knownIndexes[0].index - 1; index >= 0; index -= 1) {
    const nextDistance = distanceByIndex[index + 1] ?? knownIndexes[0].distanceFromStart;
    const currentDistance = distanceByIndex[index] ?? Math.max(0, nextDistance - 500);
    values[index] = Math.round(
      (values[index + 1] ?? knownIndexes[0].value) -
        leadingSlope * Math.max(1, nextDistance - currentDistance),
    );
    estimated.add(index);
  }

  const trailingDistance = Math.max(
    1,
    knownIndexes[knownIndexes.length - 1].distanceFromStart -
      knownIndexes[knownIndexes.length - 2].distanceFromStart,
  );
  const trailingSlope =
    (knownIndexes[knownIndexes.length - 1].value - knownIndexes[knownIndexes.length - 2].value) /
    trailingDistance;
  for (let index = knownIndexes[knownIndexes.length - 1].index + 1; index < values.length; index += 1) {
    const prevDistance =
      distanceByIndex[index - 1] ?? knownIndexes[knownIndexes.length - 1].distanceFromStart;
    const currentDistance = distanceByIndex[index] ?? prevDistance + 500;
    values[index] = Math.round(
      (values[index - 1] ?? knownIndexes[knownIndexes.length - 1].value) +
        trailingSlope * Math.max(1, currentDistance - prevDistance),
    );
    estimated.add(index);
  }

  if (values.some((value) => value === null)) {
    return null;
  }

  return {
    times: values.map((value) => minutesToClock(value ?? 0)),
    estimatedColumns: [...estimated.values()],
  };
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

  let tripCount = 0;
  let failureCount = 0;
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

      const match = chooseBestPatternMatch(
        {
          variantKey: source.variantKey,
          stopNames: table.stopNames,
          terminalHint: buildTerminalHint(source.routePattern.waypointText),
          viaStops: extractViaStops(source.routePattern.viaText),
        },
        [buildMatchablePattern(source)],
      );

      if (!match || match.patternId !== source.routePatternId) {
        failureCount += 1;
        unmatchedSources.push({
          scheduleId: source.scheduleId,
          variantKey: source.variantKey,
          routePatternId: source.routePatternId,
          reason: "AUTHORITATIVE_PATTERN_MISMATCH",
        });
        continue;
      }

      await runtime.prisma.trip.deleteMany({
        where: {
          scheduleSourceId: source.id,
        },
      });

      for (const row of variant.trips) {
        const expanded = fillPatternTimes(source, match.matchedStops, row);
        if (!expanded) {
          failureCount += 1;
          unmatchedSources.push({
            scheduleId: source.scheduleId,
            variantKey: source.variantKey,
            routePatternId: source.routePatternId,
            reason: `INSUFFICIENT_TIME_COVERAGE:${row.rowSequence}`,
          });
          continue;
        }

        const startTime = expanded.times[0] ?? "00:00";
        const trip = await runtime.prisma.trip.create({
          data: {
            id: `${source.routePatternId}:schedule:${source.scheduleId}:variant:${source.variantKey}:row:${row.rowSequence}`,
            routePatternId: source.routePatternId,
            serviceCalendarId: "svc-daily",
            scheduleSourceId: source.id,
            headsign: source.routePattern.directionLabel,
            startTime,
            rowLabel: row.rawVariantLabel,
          },
        });

        await runtime.prisma.stopTime.createMany({
          data: expanded.times.map((time, index) => {
            const minutes = parseClockToMinutes(time) ?? 0;
            return {
              tripId: trip.id,
              stopId: source.routePattern.stops[index].stop.id,
              sequence: index + 1,
              arrivalMinutes: minutes,
              departureMinutes: minutes,
              isEstimated: expanded.estimatedColumns.includes(index),
              timeSource: expanded.estimatedColumns.includes(index)
                ? "DISTANCE_INTERPOLATED"
                : "OFFICIAL",
              confidence: expanded.estimatedColumns.includes(index) ? 0.6 : 1,
            };
          }),
        });
        tripCount += 1;
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
    successCount: tripCount,
    failureCount,
    meta: {
      scheduleSources: scheduleSources.length,
      trips: tripCount,
      unmatchedSources,
    },
  };
}
