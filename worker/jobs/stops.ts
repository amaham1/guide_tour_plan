import { loadStructuredSource } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  fetchBusJejuStations,
  type BusJejuStationRecord,
} from "@/worker/jobs/bus-jeju-live";
import {
  extractArray,
  normalizeText,
  toNumber,
} from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type RawStopRecord = Record<string, unknown>;

export type NormalizedStop = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
};

function inferRegionName(id: string) {
  if (id.startsWith("406")) {
    return "서귀포시";
  }

  if (id.startsWith("405")) {
    return "제주시";
  }

  return "제주특별자치도";
}

function normalizeStopRecord(record: RawStopRecord): NormalizedStop | null {
  const id =
    normalizeText(
      record.stopId ??
        record.stationId ??
        record.station_id ??
        record.id ??
        record.nodeId,
    ) || normalizeText(record.stopName ?? record.name);
  const displayName = normalizeText(record.stopName ?? record.stationName ?? record.name);
  const latitude = toNumber(
    record.latitude ?? record.lat ?? record.gpsY ?? record.y ?? record.wgs84Lat,
  );
  const longitude = toNumber(
    record.longitude ?? record.lon ?? record.lng ?? record.gpsX ?? record.x ?? record.wgs84Lon,
  );

  if (!id || !displayName || latitude === null || longitude === null) {
    return null;
  }

  return {
    id,
    displayName,
    regionName:
      normalizeText(record.regionName ?? record.region ?? record.city ?? record.gu) ||
      inferRegionName(id),
    latitude,
    longitude,
  };
}

function normalizeBusJejuStopRecord(record: BusJejuStationRecord): NormalizedStop | null {
  const id = normalizeText(record.stationId);
  const displayName = normalizeText(record.stationNm);
  const latitude = toNumber(record.localY);
  const longitude = toNumber(record.localX);

  if (!id || !displayName || latitude === null || longitude === null) {
    return null;
  }

  return {
    id,
    displayName,
    regionName: inferRegionName(id),
    latitude,
    longitude,
  };
}

export async function fetchStopsSource(runtime: WorkerRuntime) {
  if (runtime.env.busStopsSourceUrl) {
    return {
      source: runtime.env.busStopsSourceUrl,
      value: await loadStructuredSource(runtime.env.busStopsSourceUrl),
    };
  }

  return {
    source: `${runtime.env.busJejuBaseUrl}/data/search/stationListByBounds`,
    value: await fetchBusJejuStations(runtime),
  };
}

export async function runStopsJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const { value, source } = await fetchStopsSource(runtime);
  const normalized = Array.isArray(value)
    ? (value as BusJejuStationRecord[])
        .map(normalizeBusJejuStopRecord)
        .filter((item): item is NormalizedStop => item !== null)
    : extractArray<RawStopRecord>(value)
        .map(normalizeStopRecord)
        .filter((item): item is NormalizedStop => item !== null);

  if (normalized.length === 0) {
    throw new Error("No stop rows could be normalized from the configured source.");
  }

  for (const stop of normalized) {
    await runtime.prisma.stop.upsert({
      where: { id: stop.id },
      update: {
        displayName: stop.displayName,
        regionName: stop.regionName,
        latitude: stop.latitude,
        longitude: stop.longitude,
      },
      create: {
        ...stop,
        translations: {
          create: {
            language: "ko",
            displayName: stop.displayName,
          },
        },
      },
    });
  }

  return {
    processedCount: normalized.length,
    successCount: normalized.length,
    failureCount: 0,
    meta: {
      source,
    },
  };
}
