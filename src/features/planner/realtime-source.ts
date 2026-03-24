import type { CandidateLeg } from "@/features/planner/types";
import { haversineMeters } from "@/lib/osrm";

const DATA_GO_KR_GNSS_URL =
  "https://apis.data.go.kr/6500000/jejuBusGnssPosition/viewGnssPosList";

type GnssRecord = {
  deviceId: string;
  latitude: number;
  longitude: number;
  time: string;
};

type StopCoordinate = {
  latitude: number;
  longitude: number;
};

function formatDateKey(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function extractArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "item", "data", "body", "response"]) {
      if (record[key]) {
        const nested = extractArray<T>(record[key]);
        if (nested.length > 0) {
          return nested;
        }
      }
    }
  }

  return [];
}

function toNumber(value: unknown) {
  const parsed = Number(String(value ?? "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function toTimestamp(value: unknown) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    return null;
  }

  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function normalizeGnssRecord(raw: Record<string, unknown>): GnssRecord | null {
  const deviceId = String(raw.deviceId ?? raw.device_id ?? "").trim();
  const latitude = toNumber(raw.latitude);
  const longitude = toNumber(raw.logitude ?? raw.longitude);
  const time = String(raw.time ?? raw.regDate ?? "").trim();

  if (!deviceId || latitude === null || longitude === null || !time) {
    return null;
  }

  return {
    deviceId,
    latitude,
    longitude,
    time,
  };
}

export async function fetchLatestGnssPosition(
  serviceKey: string,
  deviceId: string,
  now = new Date(),
) {
  const fromDate = formatDateKey(now);
  const url = new URL(DATA_GO_KR_GNSS_URL);
  url.searchParams.set("serviceKey", serviceKey);
  url.searchParams.set("page", "1");
  url.searchParams.set("countPerPage", "2000");
  url.searchParams.set("fromDate", fromDate);
  url.searchParams.set("toDate", fromDate);
  url.searchParams.set("type", "json");

  const response = await fetch(url.toString(), {
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`GNSS API request failed: ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const rows = extractArray<Record<string, unknown>>(payload)
    .map(normalizeGnssRecord)
    .filter((item): item is GnssRecord => item !== null)
    .filter((item) => item.deviceId === deviceId)
    .sort((left, right) => {
      const leftTime = toTimestamp(left.time)?.getTime() ?? 0;
      const rightTime = toTimestamp(right.time)?.getTime() ?? 0;
      return rightTime - leftTime;
    });

  return rows[0] ?? null;
}

export function estimateDelayMinutesFromGnss(
  leg: CandidateLeg,
  startStop: StopCoordinate,
  endStop: StopCoordinate,
  position: GnssRecord,
  now = new Date(),
) {
  const legStart = new Date(leg.startAt);
  const legEnd = new Date(leg.endAt);
  const legDurationMinutes = Math.max(1, leg.durationMinutes);
  const totalDistance = haversineMeters(startStop, endStop);

  if (totalDistance <= 0) {
    return 0;
  }

  const actualRemaining = haversineMeters(position, endStop);
  const actualProgress = Math.max(0, Math.min(1, 1 - actualRemaining / totalDistance));
  const scheduledProgress = Math.max(
    0,
    Math.min(1, (now.getTime() - legStart.getTime()) / (legEnd.getTime() - legStart.getTime())),
  );

  return Math.max(
    0,
    Math.round((scheduledProgress - actualProgress) * legDurationMinutes),
  );
}
