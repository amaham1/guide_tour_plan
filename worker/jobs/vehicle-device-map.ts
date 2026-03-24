import { loadStructuredSource } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  extractArray,
  normalizeText,
  toNumber,
} from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type VehicleMapRecord = Record<string, unknown>;

function normalizeVehicleMapRecord(record: VehicleMapRecord) {
  const routePatternId = normalizeText(record.routePatternId);
  const routeShortName = normalizeText(record.routeShortName ?? record.routeNo ?? record.routeId);
  const deviceId = normalizeText(record.deviceId ?? record.device_id);

  if (!deviceId || (!routePatternId && !routeShortName)) {
    return null;
  }

  return {
    routePatternId,
    routeShortName,
    deviceId,
    externalRouteId: normalizeText(record.externalRouteId ?? record.routeExternalId) || null,
    confidence: toNumber(record.confidence) ?? 1,
  };
}

export async function runVehicleDeviceMapJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  if (!runtime.env.vehicleMapSourceUrl) {
    throw new Error(
      "VEHICLE_MAP_SOURCE_URL is required. Configure an official vehicle mapping source.",
    );
  }

  const source = runtime.env.vehicleMapSourceUrl;
  const value = await loadStructuredSource(source);
  const rows = extractArray<VehicleMapRecord>(value)
    .map(normalizeVehicleMapRecord)
    .filter((item): item is NonNullable<typeof item> => item !== null);

  const patterns = await runtime.prisma.routePattern.findMany({
    include: {
      route: true,
    },
  });
  const patternByShortName = new Map(patterns.map((pattern) => [pattern.route.shortName, pattern]));

  let successCount = 0;
  let failureCount = 0;

  for (const row of rows) {
    const pattern =
      patterns.find((item) => item.id === row.routePatternId) ??
      patternByShortName.get(row.routeShortName);

    if (!pattern) {
      failureCount += 1;
      continue;
    }

    await runtime.prisma.vehicleDeviceMap.upsert({
      where: {
        routePatternId: pattern.id,
      },
      update: {
        deviceId: row.deviceId,
        externalRouteId: row.externalRouteId,
        confidence: row.confidence,
        refreshedAt: new Date(),
      },
      create: {
        routePatternId: pattern.id,
        deviceId: row.deviceId,
        externalRouteId: row.externalRouteId,
        confidence: row.confidence,
        refreshedAt: new Date(),
      },
    });
    successCount += 1;
  }

  return {
    processedCount: rows.length,
    successCount,
    failureCount,
    meta: {
      source,
      refreshedAt: new Date().toISOString(),
    },
  };
}
