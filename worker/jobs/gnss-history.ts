import { fetchGnssRecords, toTimestamp } from "@/features/planner/realtime-source";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

function buildObservationKey(item: {
  deviceId: string;
  observedAt: Date;
  latitude: number;
  longitude: number;
}) {
  return `${item.deviceId}:${item.observedAt.toISOString()}:${item.latitude.toFixed(6)}:${item.longitude.toFixed(6)}`;
}

export async function runGnssHistoryJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  if (!runtime.env.dataGoKrServiceKey) {
    throw new Error("DATA_GO_KR_SERVICE_KEY is required for gnss-history.");
  }

  const rows = await fetchGnssRecords(runtime.env.dataGoKrServiceKey);
  const normalized = rows
    .map((row) => ({
      deviceId: row.deviceId,
      observedAt: toTimestamp(row.time),
      latitude: row.latitude,
      longitude: row.longitude,
      raw: row,
    }))
    .filter(
      (
        row,
      ): row is {
        deviceId: string;
        observedAt: Date;
        latitude: number;
        longitude: number;
        raw: typeof rows[number];
      } =>
        row.observedAt !== null &&
        row.latitude !== 0 &&
        row.longitude !== 0,
    );

  if (normalized.length === 0) {
    return {
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      meta: {
        inserted: 0,
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
  const deduped = new Map<string, (typeof normalized)[number]>();

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
        raw: row.raw,
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
      observedAtRange: {
        from: earliest.toISOString(),
        to: latest.toISOString(),
      },
    },
  };
}
