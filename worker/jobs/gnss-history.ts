import type { Prisma } from "@prisma/client";
import { fetchGnssRecords, toTimestamp } from "@/features/planner/realtime-source";
import { fetchBusJejuRealtimePositions } from "@/worker/jobs/bus-jeju-live";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { normalizeText, toNumber } from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

const BUS_JEJU_GNSS_FALLBACK_CONCURRENCY = 12;

type GnssSnapshotRow = {
  deviceId: string;
  latitude: number;
  longitude: number;
  time: string;
  raw?: Record<string, unknown>;
};

type NormalizedObservation = {
  deviceId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
  raw: Record<string, unknown>;
};

function buildObservationKey(item: {
  deviceId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
}) {
  return `${item.deviceId}:${item.observedAt.toISOString()}:${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}`;
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

async function fetchBusJejuGnssFallback(runtime: WorkerRuntime) {
  const mappedPatterns = await runtime.prisma.vehicleDeviceMap.findMany({
    where: {
      externalRouteId: {
        not: null,
      },
    },
    select: {
      externalRouteId: true,
    },
    distinct: ["externalRouteId"],
  });
  const externalRouteIds = mappedPatterns
    .map((item) => normalizeText(item.externalRouteId))
    .filter(Boolean);
  const observedAt = new Date();

  if (externalRouteIds.length === 0) {
    return {
      source: "BUS_JEJU_REALTIME",
      rows: [] as GnssSnapshotRow[],
      externalRouteCount: 0,
    };
  }

  const groups = await mapWithConcurrency(
    externalRouteIds,
    BUS_JEJU_GNSS_FALLBACK_CONCURRENCY,
    async (externalRouteId) => {
      try {
        const rows = await fetchBusJejuRealtimePositions(runtime, externalRouteId);
        const normalized: GnssSnapshotRow[] = [];

        for (const row of rows) {
          const deviceId = normalizeText(row.vhId);
          const latitude = toNumber(row.localY);
          const longitude = toNumber(row.localX);

          if (!deviceId || latitude === null || longitude === null) {
            continue;
          }

          normalized.push({
            deviceId,
            latitude,
            longitude,
            time: observedAt.toISOString(),
            raw: {
              ...row,
              source: "BUS_JEJU_REALTIME",
              externalRouteId,
            },
          });
        }

        return normalized;
      } catch {
        return [] as GnssSnapshotRow[];
      }
    },
  );

  return {
    source: "BUS_JEJU_REALTIME",
    rows: groups.flat(),
    externalRouteCount: externalRouteIds.length,
  };
}

function toRawPayload(row: GnssSnapshotRow) {
  return (
    row.raw ?? {
      deviceId: row.deviceId,
      latitude: row.latitude,
      longitude: row.longitude,
      time: row.time,
    }
  );
}

function normalizeObservation(row: GnssSnapshotRow): NormalizedObservation | null {
  const observedAt = toTimestamp(row.time);
  if (!observedAt || row.latitude === 0 || row.longitude === 0) {
    return null;
  }

  return {
    deviceId: row.deviceId,
    observedAt,
    latitude: row.latitude,
    longitude: row.longitude,
    raw: toRawPayload(row),
  };
}

export async function runGnssHistoryJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  let rows: GnssSnapshotRow[] = [];
  let source = "DATA_GO_KR_GNSS";
  let fallbackReason: string | null = null;
  let fallbackExternalRouteCount = 0;

  if (runtime.env.dataGoKrServiceKey) {
    try {
      rows = await fetchGnssRecords(runtime.env.dataGoKrServiceKey);
    } catch (error) {
      fallbackReason = error instanceof Error ? error.message : "GNSS_REQUEST_FAILED";
    }
  } else {
    fallbackReason = "DATA_GO_KR_SERVICE_KEY_MISSING";
  }

  if (rows.length === 0) {
    const fallback = await fetchBusJejuGnssFallback(runtime);
    rows = fallback.rows;
    source = fallback.source;
    fallbackExternalRouteCount = fallback.externalRouteCount;
  }

  const normalized = rows
    .map((row) => normalizeObservation(row))
    .filter((row): row is NormalizedObservation => row !== null);

  if (normalized.length === 0) {
    return {
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      meta: {
        inserted: 0,
        source,
        fallbackReason,
        fallbackExternalRouteCount,
      },
    };
  }

  const earliest = normalized.reduce(
    (value, row) => (row.observedAt < value ? row.observedAt : value),
    normalized[0].observedAt,
  );
  const latest = normalized.reduce(
    (value, row) => (row.observedAt > value ? row.observedAt : value),
    normalized[0].observedAt,
  );
  const deviceIds = [...new Set(normalized.map((row) => row.deviceId))];
  const existing = await runtime.prisma.gnssObservation.findMany({
    where: {
      deviceId: {
        in: deviceIds,
      },
      observedAt: {
        gte: earliest,
        lte: latest,
      },
    },
    select: {
      deviceId: true,
      observedAt: true,
      latitude: true,
      longitude: true,
    },
  });
  const existingKeys = new Set(existing.map(buildObservationKey));
  const deduped = new Map<string, NormalizedObservation>();

  for (const row of normalized) {
    const key = buildObservationKey(row);
    if (existingKeys.has(key)) {
      continue;
    }

    deduped.set(key, row);
  }

  const insertRows = [...deduped.values()];
  if (insertRows.length > 0) {
    await runtime.prisma.gnssObservation.createMany({
      data: insertRows.map((row) => ({
        deviceId: row.deviceId,
        observedAt: row.observedAt,
        latitude: row.latitude,
        longitude: row.longitude,
        raw: row.raw as Prisma.InputJsonValue,
      })),
    });
  }

  return {
    processedCount: normalized.length,
    successCount: insertRows.length,
    failureCount: normalized.length - insertRows.length,
    meta: {
      inserted: insertRows.length,
      skippedDuplicates: normalized.length - insertRows.length,
      source,
      fallbackReason,
      fallbackExternalRouteCount,
      observedAtRange: {
        from: earliest.toISOString(),
        to: latest.toISOString(),
      },
    },
  };
}
