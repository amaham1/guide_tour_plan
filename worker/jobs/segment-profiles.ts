import { ServiceDayClass } from "@prisma/client";
import { percentile, type GeoPoint } from "@/lib/geometry";
import {
  buildProjectedTraces,
  createDiagnostics,
  isHighFrequencyTrace,
  LOW_FREQUENCY_TRACE_GAP_MS,
  MAX_SEGMENT_SPEED_KPH,
  splitObservations,
} from "@/worker/jobs/segment-profile-traces";
import { matchTraceGeometry } from "@/lib/osrm";
import { median } from "@/worker/jobs/helpers";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const SEGMENT_WINDOW_DAYS = 28;
const STOP_PASSAGE_RETENTION_DAYS = 45;
const MIN_MATCH_CONFIDENCE = 0.8;
const MIN_SEGMENT_SAMPLE_COUNT = 5;
const TURN_PENALTY_SHARE = 0.35;
const MAX_TURN_PENALTY_SEC = 45;


function toServiceDayClass(date: Date) {
  const day = date.getDay();
  if (day === 6) {
    return ServiceDayClass.SATURDAY;
  }

  if (day === 0) {
    return ServiceDayClass.SUNDAY_HOLIDAY;
  }

  return ServiceDayClass.WEEKDAY;
}

function toBucketStartMinute(date: Date) {
  const totalMinutes = date.getHours() * 60 + date.getMinutes();
  return Math.floor(totalMinutes / 15) * 15;
}

export function collectTurnTriples(nodes: number[]) {
  const normalized = nodes.filter((node, index) => index === 0 || node !== nodes[index - 1]);
  const triples: Array<{
    fromOsmNodeId: string;
    viaOsmNodeId: string;
    toOsmNodeId: string;
  }> = [];
  const seen = new Set<string>();

  for (let index = 1; index < normalized.length - 1; index += 1) {
    const fromNodeId = normalized[index - 1];
    const viaOsmNodeId = normalized[index];
    const toOsmNodeId = normalized[index + 1];
    if (
      !Number.isFinite(fromNodeId) ||
      !Number.isFinite(viaOsmNodeId) ||
      !Number.isFinite(toOsmNodeId) ||
      fromNodeId === viaOsmNodeId ||
      viaOsmNodeId === toOsmNodeId
    ) {
      continue;
    }

    const key = `${fromNodeId}:${viaOsmNodeId}:${toOsmNodeId}`;
    if (seen.has(key)) {
      continue;
    }

    triples.push({
      fromOsmNodeId: String(fromNodeId),
      viaOsmNodeId: String(viaOsmNodeId),
      toOsmNodeId: String(toOsmNodeId),
    });
    seen.add(key);
  }

  return triples;
}

function interpolateTimestamp(
  start: { observedAt: Date; offsetMeters: number },
  end: { observedAt: Date; offsetMeters: number },
  targetOffsetMeters: number,
) {
  const span = end.offsetMeters - start.offsetMeters;
  if (span <= 0) {
    return null;
  }

  const ratio = Math.max(0, Math.min(1, (targetOffsetMeters - start.offsetMeters) / span));
  return new Date(
    start.observedAt.getTime() +
      Math.round((end.observedAt.getTime() - start.observedAt.getTime()) * ratio),
  );
}

function parseGeometryCoordinates(value: unknown): GeoPoint[] {
  if (
    value &&
    typeof value === "object" &&
    Array.isArray((value as { coordinates?: unknown }).coordinates)
  ) {
    return ((value as { coordinates: unknown[] }).coordinates ?? [])
      .filter(
        (item): item is GeoPoint =>
          Array.isArray(item) &&
          item.length >= 2 &&
          typeof item[0] === "number" &&
          typeof item[1] === "number",
      )
      .map((item) => [item[0], item[1]]);
  }

  return [];
}

export async function runSegmentProfilesJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const since = new Date(Date.now() - SEGMENT_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const mappings = await runtime.prisma.vehicleDeviceMap.findMany({
    include: {
      routePattern: {
        include: {
          geometry: true,
          stopProjections: {
            orderBy: {
              sequence: "asc",
            },
          },
        },
      },
    },
  });

  const aggregates = new Map<
    string,
    {
      routePatternId: string;
      fromSequence: number;
      toSequence: number;
      serviceDayClass: ServiceDayClass;
      bucketStartMinute: number;
      segmentDistanceMeters: number;
      durationsSec: number[];
    }
  >();
  const turnAggregates = new Map<
    string,
    {
      fromOsmNodeId: string;
      viaOsmNodeId: string;
      toOsmNodeId: string;
      serviceDayClass: ServiceDayClass;
      bucketStartMinute: number;
      penaltiesSec: number[];
    }
  >();
  const observedStopPassages = new Map<
    string,
    {
      routePatternId: string;
      stopId: string;
      sequence: number;
      deviceId: string;
      observedAt: Date;
      serviceDayClass: ServiceDayClass;
      bucketStartMinute: number;
      source: string;
      externalRouteId: string | null;
      offsetMeters: number;
      snapDistanceMeters: number;
      confidence: number;
    }
  >();
  const routePatternIds = new Set<string>();
  const diagnostics = createDiagnostics();

  for (const mapping of mappings) {
    const geometry = parseGeometryCoordinates(mapping.routePattern.geometry?.geometry ?? null);
    if (geometry.length < 2 || mapping.routePattern.stopProjections.length < 2) {
      continue;
    }

    routePatternIds.add(mapping.routePatternId);
    const routeContextFilters: Array<{
      routePatternId?: string | null;
      externalRouteId?: string | null;
    }> = [
      {
        routePatternId: mapping.routePatternId,
      },
    ];
    if (mapping.externalRouteId) {
      routeContextFilters.push({
        routePatternId: null,
        externalRouteId: mapping.externalRouteId,
      });
    }

    const observations = await runtime.prisma.gnssObservation.findMany({
      where: {
        deviceId: mapping.deviceId,
        OR: routeContextFilters,
        observedAt: {
          gte: since,
        },
      },
      orderBy: {
        observedAt: "asc",
      },
    });

    if (observations.length < 2) {
      continue;
    }

    diagnostics.rawObservationCount += observations.length;
    const traces = splitObservations(
      observations.map((row) => ({
        observedAt: row.observedAt,
        latitude: row.latitude,
        longitude: row.longitude,
      })),
      diagnostics,
    );

    for (const trace of traces) {
      if (isHighFrequencyTrace(trace)) {
        const matches = await matchTraceGeometry(
          runtime.env.osrmBusEtaBaseUrl,
          "driving",
          trace.map((row) => ({
            latitude: row.latitude,
            longitude: row.longitude,
          })),
          {
            timestamps: trace.map((row) => Math.floor(row.observedAt.getTime() / 1000)),
            radiuses: trace.map(() => 50),
          },
        ).catch(() => {
          diagnostics.osrmMatchFailureCount += 1;
          return [];
        });

        const bestMatch = matches.sort((left, right) => right.confidence - left.confidence)[0];
        if (bestMatch && bestMatch.confidence >= MIN_MATCH_CONFIDENCE) {
          diagnostics.osrmMatchedTraceCount += 1;
          const traceObservedDurationSec = Math.round(
            (trace[trace.length - 1]!.observedAt.getTime() - trace[0]!.observedAt.getTime()) /
              1000,
          );
          const turnPenaltyBudgetSec = Math.round(
            Math.max(0, traceObservedDurationSec - bestMatch.durationSeconds) * TURN_PENALTY_SHARE,
          );
          const turnTriples = collectTurnTriples(bestMatch.nodes);
          if (turnPenaltyBudgetSec > 0 && turnTriples.length > 0) {
            const serviceDayClass = toServiceDayClass(trace[0]!.observedAt);
            const bucketStartMinute = toBucketStartMinute(trace[0]!.observedAt);
            const perTurnPenaltySec = Math.min(
              MAX_TURN_PENALTY_SEC,
              Math.max(1, Math.round(turnPenaltyBudgetSec / turnTriples.length)),
            );

            for (const turn of turnTriples) {
              const key = [
                turn.fromOsmNodeId,
                turn.viaOsmNodeId,
                turn.toOsmNodeId,
                serviceDayClass,
                bucketStartMinute,
              ].join(":");
              const aggregate = turnAggregates.get(key) ?? {
                fromOsmNodeId: turn.fromOsmNodeId,
                viaOsmNodeId: turn.viaOsmNodeId,
                toOsmNodeId: turn.toOsmNodeId,
                serviceDayClass,
                bucketStartMinute,
                penaltiesSec: [],
              };
              aggregate.penaltiesSec.push(perTurnPenaltySec);
              turnAggregates.set(key, aggregate);
            }
          }
        } else {
          diagnostics.osrmLowConfidenceCount += 1;
        }
      } else {
        diagnostics.osrmSkippedLowFrequencyTraceCount += 1;
      }

      const projectedTraces = buildProjectedTraces(trace, geometry, diagnostics);

      for (const projectedTrace of projectedTraces) {
        const stopPassTimes = new Map<number, Date>();
        for (let index = 1; index < projectedTrace.length; index += 1) {
          const start = projectedTrace[index - 1];
          const end = projectedTrace[index];
          if (end.offsetMeters <= start.offsetMeters) {
            continue;
          }

          for (const stopProjection of mapping.routePattern.stopProjections) {
            if (stopPassTimes.has(stopProjection.sequence)) {
              continue;
            }

            if (
              stopProjection.offsetMeters < start.offsetMeters ||
              stopProjection.offsetMeters > end.offsetMeters
            ) {
              continue;
            }

            const timestamp = interpolateTimestamp(start, end, stopProjection.offsetMeters);
            if (timestamp) {
              stopPassTimes.set(stopProjection.sequence, timestamp);
            }
          }
        }

        diagnostics.stopPassageCandidateCount += stopPassTimes.size;

        for (const stopProjection of mapping.routePattern.stopProjections) {
          const observedAt = stopPassTimes.get(stopProjection.sequence);
          if (!observedAt) {
            continue;
          }

          const key = [
            mapping.routePatternId,
            stopProjection.sequence,
            mapping.deviceId,
            observedAt.toISOString(),
          ].join(":");
          observedStopPassages.set(key, {
            routePatternId: mapping.routePatternId,
            stopId: stopProjection.stopId,
            sequence: stopProjection.sequence,
            deviceId: mapping.deviceId,
            observedAt,
            serviceDayClass: toServiceDayClass(observedAt),
            bucketStartMinute: toBucketStartMinute(observedAt),
            source: "GNSS_TRACE",
            externalRouteId: mapping.externalRouteId,
            offsetMeters: stopProjection.offsetMeters,
            snapDistanceMeters: stopProjection.snapDistanceMeters,
            confidence: stopProjection.confidence,
          });
        }

        for (let index = 1; index < mapping.routePattern.stopProjections.length; index += 1) {
          const from = mapping.routePattern.stopProjections[index - 1];
          const to = mapping.routePattern.stopProjections[index];
          const fromTime = stopPassTimes.get(from.sequence);
          const toTime = stopPassTimes.get(to.sequence);
          if (!fromTime || !toTime || toTime <= fromTime) {
            continue;
          }

          const durationSec = Math.round((toTime.getTime() - fromTime.getTime()) / 1000);
          const segmentDistanceMeters = Math.max(1, to.offsetMeters - from.offsetMeters);
          const speedKph = (segmentDistanceMeters / durationSec) * 3.6;
          if (!Number.isFinite(speedKph) || speedKph > MAX_SEGMENT_SPEED_KPH) {
            diagnostics.speedRejectedObservationCount += 1;
            continue;
          }

          const serviceDayClass = toServiceDayClass(fromTime);
          const bucketStartMinute = toBucketStartMinute(fromTime);
          const key = [
            mapping.routePatternId,
            from.sequence,
            to.sequence,
            serviceDayClass,
            bucketStartMinute,
          ].join(":");

          const aggregate = aggregates.get(key) ?? {
            routePatternId: mapping.routePatternId,
            fromSequence: from.sequence,
            toSequence: to.sequence,
            serviceDayClass,
            bucketStartMinute,
            segmentDistanceMeters,
            durationsSec: [],
          };
          aggregate.durationsSec.push(durationSec);
          diagnostics.segmentSampleCount += 1;
          aggregates.set(key, aggregate);
        }
      }
    }
  }

  if (routePatternIds.size > 0) {
    await runtime.prisma.segmentTravelProfile.deleteMany({
      where: {
        routePatternId: {
          in: [...routePatternIds],
        },
      },
    });
  }
  await runtime.prisma.turnDelayProfile.deleteMany();

  const segmentRows = [...aggregates.values()]
    .map((aggregate) => {
      const medianDurationSec = median(aggregate.durationsSec);
      const p90DurationSec = percentile(aggregate.durationsSec, 90);
      if (medianDurationSec === null || p90DurationSec === null) {
        return null;
      }

      if (aggregate.durationsSec.length < MIN_SEGMENT_SAMPLE_COUNT) {
        diagnostics.segmentBucketBelowSampleCount += 1;
        return null;
      }

      return {
        routePatternId: aggregate.routePatternId,
        fromSequence: aggregate.fromSequence,
        toSequence: aggregate.toSequence,
        serviceDayClass: aggregate.serviceDayClass,
        bucketStartMinute: aggregate.bucketStartMinute,
        medianDurationSec,
        p90DurationSec,
        medianSpeedKph:
          Number(((aggregate.segmentDistanceMeters / medianDurationSec) * 3.6).toFixed(3)) || 0,
        sampleCount: aggregate.durationsSec.length,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  const turnRows = [...turnAggregates.values()]
    .map((aggregate) => {
      const penaltySec = median(aggregate.penaltiesSec);
      if (penaltySec === null) {
        return null;
      }

      return {
        fromOsmNodeId: aggregate.fromOsmNodeId,
        viaOsmNodeId: aggregate.viaOsmNodeId,
        toOsmNodeId: aggregate.toOsmNodeId,
        serviceDayClass: aggregate.serviceDayClass,
        bucketStartMinute: aggregate.bucketStartMinute,
        penaltySec: Math.min(MAX_TURN_PENALTY_SEC, penaltySec),
        sampleCount: aggregate.penaltiesSec.length,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (segmentRows.length > 0) {
    await runtime.prisma.segmentTravelProfile.createMany({
      data: segmentRows,
    });
  }

  const stopPassageRetentionCutoff = new Date(
    Date.now() - STOP_PASSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  await runtime.prisma.observedStopPassage.deleteMany({
    where: {
      observedAt: {
        lt: stopPassageRetentionCutoff,
      },
    },
  });

  let observedStopPassageInsertCount = 0;
  const stopPassageRows = [...observedStopPassages.values()];
  if (stopPassageRows.length > 0 && routePatternIds.size > 0) {
    const earliestStopPassage = stopPassageRows.reduce(
      (value, row) => (row.observedAt < value ? row.observedAt : value),
      stopPassageRows[0].observedAt,
    );
    const latestStopPassage = stopPassageRows.reduce(
      (value, row) => (row.observedAt > value ? row.observedAt : value),
      stopPassageRows[0].observedAt,
    );
    const existingStopPassages = await runtime.prisma.observedStopPassage.findMany({
      where: {
        routePatternId: {
          in: [...routePatternIds],
        },
        observedAt: {
          gte: earliestStopPassage,
          lte: latestStopPassage,
        },
      },
      select: {
        routePatternId: true,
        sequence: true,
        deviceId: true,
        observedAt: true,
      },
    });
    const existingStopPassageKeys = new Set(
      existingStopPassages.map((row) =>
        [row.routePatternId, row.sequence, row.deviceId, row.observedAt.toISOString()].join(":"),
      ),
    );
    const insertStopPassages = stopPassageRows.filter((row) => {
      const key = [
        row.routePatternId,
        row.sequence,
        row.deviceId,
        row.observedAt.toISOString(),
      ].join(":");
      return !existingStopPassageKeys.has(key);
    });

    if (insertStopPassages.length > 0) {
      await runtime.prisma.observedStopPassage.createMany({
        data: insertStopPassages,
      });
      observedStopPassageInsertCount = insertStopPassages.length;
    }
  }

  if (turnRows.length > 0) {
    await runtime.prisma.turnDelayProfile.createMany({
      data: turnRows,
    });
  }

  return {
    processedCount: mappings.length,
    successCount: segmentRows.length + turnRows.length + observedStopPassageInsertCount,
    failureCount: 0,
    meta: {
      lookbackDays: SEGMENT_WINDOW_DAYS,
      routePatternCount: routePatternIds.size,
      segmentProfileCount: segmentRows.length,
      turnProfileCount: turnRows.length,
      observedStopPassageCount: observedStopPassageInsertCount,
      minSegmentSampleCount: MIN_SEGMENT_SAMPLE_COUNT,
      lowFrequencyTraceGapMinutes: LOW_FREQUENCY_TRACE_GAP_MS / 60_000,
      ...diagnostics,
    },
  };
}
