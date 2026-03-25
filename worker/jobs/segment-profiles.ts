import { ServiceDayClass } from "@prisma/client";
import { percentile, projectPointOntoPolyline, type GeoPoint } from "@/lib/geometry";
import { matchTraceGeometry } from "@/lib/osrm";
import { median } from "@/worker/jobs/helpers";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const TRACE_GAP_MS = 90_000;
const MAX_OBSERVATION_SNAP_DISTANCE_METERS = 250;
const MAX_SEGMENT_SPEED_KPH = 90;
const SEGMENT_WINDOW_DAYS = 28;
const MIN_MATCH_CONFIDENCE = 0.8;
const TURN_PENALTY_SHARE = 0.35;
const MAX_TURN_PENALTY_SEC = 45;

type TraceObservation = {
  observedAt: Date;
  latitude: number;
  longitude: number;
};

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

function splitObservations(rows: TraceObservation[]) {
  const traces: TraceObservation[][] = [];
  let current: TraceObservation[] = [];

  for (const row of rows) {
    const previous = current[current.length - 1];
    if (previous && row.observedAt.getTime() - previous.observedAt.getTime() > TRACE_GAP_MS) {
      if (current.length >= 2) {
        traces.push(current);
      }
      current = [];
    }

    current.push(row);
  }

  if (current.length >= 2) {
    traces.push(current);
  }

  return traces;
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
  const routePatternIds = new Set<string>();

  for (const mapping of mappings) {
    const geometry = parseGeometryCoordinates(mapping.routePattern.geometry?.geometry ?? null);
    if (geometry.length < 2 || mapping.routePattern.stopProjections.length < 2) {
      continue;
    }

    routePatternIds.add(mapping.routePatternId);
    const observations = await runtime.prisma.gnssObservation.findMany({
      where: {
        deviceId: mapping.deviceId,
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

    const traces = splitObservations(
      observations.map((row) => ({
        observedAt: row.observedAt,
        latitude: row.latitude,
        longitude: row.longitude,
      })),
    );

    for (const trace of traces) {
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
      ).catch(() => []);

      const bestMatch = matches.sort((left, right) => right.confidence - left.confidence)[0];
      if (!bestMatch || bestMatch.confidence < MIN_MATCH_CONFIDENCE) {
        continue;
      }

      const traceObservedDurationSec = Math.round(
        (trace[trace.length - 1]!.observedAt.getTime() - trace[0]!.observedAt.getTime()) / 1000,
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

      const projectedTrace = trace
        .map((row) => {
          const projection = projectPointOntoPolyline(
            {
              latitude: row.latitude,
              longitude: row.longitude,
            },
            geometry,
          );

          if (!projection || projection.distanceMeters > MAX_OBSERVATION_SNAP_DISTANCE_METERS) {
            return null;
          }

          return {
            observedAt: row.observedAt,
            offsetMeters: projection.offsetMeters,
          };
        })
        .filter(
          (
            row,
          ): row is {
            observedAt: Date;
            offsetMeters: number;
          } => row !== null,
        );

      if (projectedTrace.length < 2) {
        continue;
      }

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
        aggregates.set(key, aggregate);
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

  if (turnRows.length > 0) {
    await runtime.prisma.turnDelayProfile.createMany({
      data: turnRows,
    });
  }

  return {
    processedCount: mappings.length,
    successCount: segmentRows.length + turnRows.length,
    failureCount: 0,
    meta: {
      lookbackDays: SEGMENT_WINDOW_DAYS,
      routePatternCount: routePatternIds.size,
      segmentProfileCount: segmentRows.length,
      turnProfileCount: turnRows.length,
    },
  };
}
