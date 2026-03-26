import { loadStructuredSource } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  extractArray,
  normalizeText,
  toNumber,
} from "@/worker/jobs/helpers";
import {
  fetchBusJejuRealtimePositions,
  type BusJejuRealtimePosition,
} from "@/worker/jobs/bus-jeju-live";
import type { JobOutcome } from "@/worker/jobs/types";

type VehicleMapRecord = Record<string, unknown>;
type RoutePatternWithRoute = {
  id: string;
  externalRouteId: string | null;
  route: {
    shortName: string;
  };
};

type NormalizedVehicleMapRow = {
  routePatternId: string | null;
  routeShortName: string | null;
  deviceId: string;
  externalRouteId: string | null;
  confidence: number;
};

const BUS_JEJU_REALTIME_FETCH_CONCURRENCY = 12;
const VEHICLE_MAP_STALE_DAYS = 7;

function normalizeVehicleMapRecord(record: VehicleMapRecord): NormalizedVehicleMapRow | null {
  const routePatternId = normalizeText(record.routePatternId);
  const routeShortName = normalizeText(
    record.routeShortName ?? record.routeNo ?? record.routeId,
  );
  const deviceId = normalizeText(record.deviceId ?? record.device_id);

  if (!deviceId || (!routePatternId && !routeShortName)) {
    return null;
  }

  return {
    routePatternId,
    routeShortName: routeShortName || null,
    deviceId,
    externalRouteId: normalizeText(record.externalRouteId ?? record.routeExternalId) || null,
    confidence: toNumber(record.confidence) ?? 1,
  };
}

function normalizeRealtimeVehicleRow(
  pattern: RoutePatternWithRoute,
  record: BusJejuRealtimePosition,
): NormalizedVehicleMapRow | null {
  const deviceId = normalizeText(record.vhId);
  if (!deviceId) {
    return null;
  }

  return {
    routePatternId: pattern.id,
    routeShortName: pattern.route.shortName,
    deviceId,
    externalRouteId: pattern.externalRouteId,
    confidence: 0.98,
  };
}

async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
) {
  const results: R[] = [];
  for (let index = 0; index < items.length; index += limit) {
    const chunk = items.slice(index, index + limit);
    const resolved = await Promise.all(chunk.map((item) => mapper(item)));
    results.push(...resolved);
  }
  return results;
}

async function loadOfficialRealtimeVehicleMapRows(
  runtime: WorkerRuntime,
  patterns: RoutePatternWithRoute[],
) {
  let inspectedPatternCount = 0;
  const failures: Array<{ routePatternId: string; error: string }> = [];
  const rows = await mapWithConcurrency(
    patterns.filter((pattern) => Boolean(pattern.externalRouteId)),
    BUS_JEJU_REALTIME_FETCH_CONCURRENCY,
    async (pattern) => {
      if (!pattern.externalRouteId) {
        return [] as NormalizedVehicleMapRow[];
      }

      inspectedPatternCount += 1;
      try {
        const realtimeRows = await fetchBusJejuRealtimePositions(runtime, pattern.externalRouteId);
        return realtimeRows
          .map((row) => normalizeRealtimeVehicleRow(pattern, row))
          .filter((item): item is NormalizedVehicleMapRow => item !== null);
      } catch (error) {
        failures.push({
          routePatternId: pattern.id,
          error: error instanceof Error ? error.message : "Unknown realtime mapping error",
        });
        return [] as NormalizedVehicleMapRow[];
      }
    },
  );

  return {
    rows: rows.flat(),
    inspectedPatternCount,
    failures,
  };
}

export async function runVehicleDeviceMapJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  const patterns = await runtime.prisma.routePattern.findMany({
    where: {
      isActive: true,
      trips: {
        some: {},
      },
    },
    include: {
      route: true,
    },
  });
  const patternByShortName = new Map(
    patterns.map((pattern) => [pattern.route.shortName, pattern]),
  );

  let source = runtime.env.vehicleMapSourceUrl;
  let rows: NormalizedVehicleMapRow[] = [];
  let fallbackInspectedPatternCount = 0;
  let fallbackFailureCount = 0;

  if (runtime.env.vehicleMapSourceUrl) {
    const value = await loadStructuredSource(runtime.env.vehicleMapSourceUrl);
    rows = extractArray<VehicleMapRecord>(value)
      .map(normalizeVehicleMapRecord)
      .filter((item): item is NonNullable<typeof item> => item !== null);
  } else {
    const fallback = await loadOfficialRealtimeVehicleMapRows(runtime, patterns);
    rows = fallback.rows;
    source = `${runtime.env.busJejuBaseUrl}/data/search/getRealTimeBusPositionByLineId`;
    fallbackInspectedPatternCount = fallback.inspectedPatternCount;
    fallbackFailureCount = fallback.failures.length;
  }

  const now = new Date();
  const seenKeys = new Set<string>();
  const normalizedRows = rows.filter((row) => {
    const key = [
      row.routePatternId ?? row.routeShortName ?? "unresolved",
      row.deviceId,
      row.externalRouteId ?? "",
    ].join(":");
    if (seenKeys.has(key)) {
      return false;
    }

    seenKeys.add(key);
    return true;
  });

  let successCount = 0;
  let failureCount = 0;

  for (const row of normalizedRows) {
    const pattern =
      patterns.find((item) => item.id === row.routePatternId) ??
      (row.routeShortName ? patternByShortName.get(row.routeShortName) : undefined);

    if (!pattern) {
      failureCount += 1;
      continue;
    }

    await runtime.prisma.vehicleDeviceMap.upsert({
      where: {
        routePatternId_deviceId: {
          routePatternId: pattern.id,
          deviceId: row.deviceId,
        },
      },
      update: {
        externalRouteId: row.externalRouteId,
        confidence: row.confidence,
        refreshedAt: now,
      },
      create: {
        routePatternId: pattern.id,
        deviceId: row.deviceId,
        externalRouteId: row.externalRouteId,
        confidence: row.confidence,
        refreshedAt: now,
      },
    });
    successCount += 1;
  }

  await runtime.prisma.vehicleDeviceMap.deleteMany({
    where: {
      refreshedAt: {
        lt: new Date(now.getTime() - VEHICLE_MAP_STALE_DAYS * 24 * 60 * 60 * 1000),
      },
    },
  });

  return {
    processedCount: normalizedRows.length,
    successCount,
    failureCount,
    meta: {
      source,
      refreshedAt: now.toISOString(),
      fallbackInspectedPatternCount,
      fallbackFailureCount,
    },
  };
}
