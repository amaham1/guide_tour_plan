import { loadStructuredSource } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { fetchJejuStation2, type JejuOpenApiStation2Record } from "@/worker/jobs/jeju-openapi";
import { extractArray, normalizeText, toNumber } from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type RawStopRecord = Record<string, unknown>;

type NormalizedStop = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
  translations: Array<{
    language: string;
    displayName: string;
  }>;
};

function inferRegionName(id: string) {
  if (id.startsWith("406")) {
    return "서귀포시";
  }

  if (id.startsWith("405")) {
    return "제주시";
  }

  return "제주광역권";
}

function normalizeStation2Record(record: JejuOpenApiStation2Record): NormalizedStop | null {
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
    translations: [
      { language: "ko", displayName },
      { language: "en", displayName: normalizeText(record.stationNmEn) },
      { language: "zh", displayName: normalizeText(record.stationNmCh) },
      { language: "ja", displayName: normalizeText(record.stationNmJp) },
    ].filter((translation) => Boolean(translation.displayName)),
  };
}

function normalizeOverrideRecord(record: RawStopRecord): NormalizedStop | null {
  const id = normalizeText(
    record.stopId ??
      record.stationId ??
      record.station_id ??
      record.id ??
      record.nodeId,
  );
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
    translations: [
      { language: "ko", displayName },
      { language: "en", displayName: normalizeText(record.stationNmEn ?? record.nameEn) },
      { language: "zh", displayName: normalizeText(record.stationNmCh ?? record.nameZh) },
      { language: "ja", displayName: normalizeText(record.stationNmJp ?? record.nameJa) },
    ].filter((translation) => Boolean(translation.displayName)),
  };
}

async function fetchStopsSource(runtime: WorkerRuntime) {
  if (runtime.env.busStopsSourceUrl) {
    return {
      source: runtime.env.busStopsSourceUrl,
      value: await loadStructuredSource(runtime.env.busStopsSourceUrl),
    };
  }

  return {
    source: `${runtime.env.busJejuBaseUrl}/data/search/stationListByBounds`,
    value: await fetchJejuStation2(runtime),
  };
}

export async function runStopsJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const { value, source } = await fetchStopsSource(runtime);
  const normalized = Array.isArray(value)
    ? (value as JejuOpenApiStation2Record[])
        .map(normalizeStation2Record)
        .filter((item): item is NormalizedStop => item !== null)
    : extractArray<RawStopRecord>(value)
        .map(normalizeOverrideRecord)
        .filter((item): item is NormalizedStop => item !== null);

  if (normalized.length === 0) {
    throw new Error("No stop rows could be normalized from the configured source.");
  }

  let translationCount = 0;
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
        id: stop.id,
        displayName: stop.displayName,
        regionName: stop.regionName,
        latitude: stop.latitude,
        longitude: stop.longitude,
      },
    });

    for (const translation of stop.translations) {
      await runtime.prisma.stopTranslation.upsert({
        where: {
          stopId_language: {
            stopId: stop.id,
            language: translation.language,
          },
        },
        update: {
          displayName: translation.displayName,
        },
        create: {
          stopId: stop.id,
          language: translation.language,
          displayName: translation.displayName,
        },
      });
      translationCount += 1;
    }
  }

  return {
    processedCount: normalized.length,
    successCount: normalized.length,
    failureCount: 0,
    meta: {
      source,
      translations: translationCount,
    },
  };
}
