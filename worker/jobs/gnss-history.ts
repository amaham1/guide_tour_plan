import type { Prisma } from "@prisma/client";
import { fetchGnssRecords, toTimestamp } from "@/features/planner/realtime-source";
import { mapWithConcurrency } from "@/worker/core/concurrency";
import { fetchBusJejuRealtimePositions } from "@/worker/jobs/bus-jeju-live";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { normalizeText, toNumber } from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

const BUS_JEJU_GNSS_FALLBACK_CONCURRENCY = 12;
const GNSS_OBSERVATION_RETENTION_DAYS = 45;

type GnssSnapshotRow = {
  deviceId: string;
  routePatternId?: string | null;
  externalRouteId?: string | null;
  source?: string | null;
  latitude: number;
  longitude: number;
  time: string;
  raw?: Record<string, unknown>;
};

type NormalizedObservation = {
  deviceId: string;
  routePatternId: string | null;
  externalRouteId: string | null;
  source: string | null;
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

async function fetchBusJejuGnssFallback(runtime: WorkerRuntime) {
  const mappedPatterns = await runtime.prisma.vehicleDeviceMap.findMany({
    where: {
      externalRouteId: {
        not: null,
      },
    },
    select: {
      routePatternId: true,
      deviceId: true,
      externalRouteId: true,
    },
  });
  const mappingsByExternalRouteId = new Map<
    string,
    Array<{
      routePatternId: string;
      deviceId: string;
      externalRouteId: string;
    }>
  >();

  for (const item of mappedPatterns) {
    const externalRouteId = normalizeText(item.externalRouteId);
    if (!externalRouteId) {
      continue;
    }

    const next = mappingsByExternalRouteId.get(externalRouteId) ?? [];
    next.push({
      routePatternId: item.routePatternId,
      deviceId: item.deviceId,
      externalRouteId,
    });
    mappingsByExternalRouteId.set(externalRouteId, next);
  }

  const externalRouteIds = [...mappingsByExternalRouteId.keys()];
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

          const candidateMappings = mappingsByExternalRouteId.get(externalRouteId) ?? [];
          const matchedMapping =
            candidateMappings.find((item) => item.deviceId === deviceId) ??
            (candidateMappings.length === 1 ? candidateMappings[0] : null);

          normalized.push({
            deviceId,
            routePatternId: matchedMapping?.routePatternId ?? null,
            externalRouteId,
            source: "BUS_JEJU_REALTIME",
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
    routePatternId: normalizeText(row.routePatternId) || null,
    externalRouteId: normalizeText(row.externalRouteId) || null,
    source: normalizeText(row.source) || null,
    observedAt,
    latitude: row.latitude,
    longitude: row.longitude,
    raw: toRawPayload(row),
  };
}

function chooseBestDeviceMapping(
  rows: Array<{
    routePatternId: string;
    externalRouteId: string | null;
    confidence: number;
    refreshedAt: Date;
  }>,
) {
  return rows
    .slice()
    .sort((left, right) => {
      if (right.confidence !== left.confidence) {
        return right.confidence - left.confidence;
      }

      return right.refreshedAt.getTime() - left.refreshedAt.getTime();
    })[0];
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

  const retentionCutoff = new Date(
    Date.now() - GNSS_OBSERVATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  );
  const deletedOldObservations = await runtime.prisma.gnssObservation.deleteMany({
    where: {
      observedAt: {
        lt: retentionCutoff,
      },
    },
  });

  if (normalized.length === 0) {
    return {
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      meta: {
        inserted: 0,
        deletedOldObservations: deletedOldObservations.count,
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
  const deviceMappings = await runtime.prisma.vehicleDeviceMap.findMany({
    where: {
      deviceId: {
        in: deviceIds,
      },
    },
    select: {
      deviceId: true,
      routePatternId: true,
      externalRouteId: true,
      confidence: true,
      refreshedAt: true,
    },
  });
  const deviceMappingByDeviceId = new Map<
    string,
    ReturnType<typeof chooseBestDeviceMapping>
  >();
  for (const deviceId of deviceIds) {
    const mapping = chooseBestDeviceMapping(
      deviceMappings.filter((item) => item.deviceId === deviceId),
    );
    if (mapping) {
      deviceMappingByDeviceId.set(deviceId, mapping);
    }
  }
  const enriched = normalized.map((row) => {
    const mapping = deviceMappingByDeviceId.get(row.deviceId);
    return {
      ...row,
      routePatternId: row.routePatternId ?? mapping?.routePatternId ?? null,
      externalRouteId: row.externalRouteId ?? mapping?.externalRouteId ?? null,
      source: row.source ?? source,
    };
  });
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

  for (const row of enriched) {
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
        routePatternId: row.routePatternId,
        externalRouteId: row.externalRouteId,
        source: row.source,
        observedAt: row.observedAt,
        latitude: row.latitude,
        longitude: row.longitude,
        raw: row.raw as Prisma.InputJsonValue,
      })),
    });
  }

  return {
    processedCount: enriched.length,
    successCount: insertRows.length,
    failureCount: enriched.length - insertRows.length,
    meta: {
      inserted: insertRows.length,
      skippedDuplicates: enriched.length - insertRows.length,
      deletedOldObservations: deletedOldObservations.count,
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
