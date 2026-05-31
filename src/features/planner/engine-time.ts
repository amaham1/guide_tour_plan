import type { CandidateTimeReliability } from "@/features/planner/types";
import type { TripStopContext } from "@/features/planner/engine-types";
import { ESTIMATED_BUFFER, ROUGH_BUFFER, SERVICE_UTC_OFFSET_MINUTES } from "@/features/planner/engine-constants";

const serviceDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const serviceTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});
export function toServiceMinutes(date: Date) {
  const parts = serviceTimeFormatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

export function fromServiceMinutes(baseDate: Date, minutes: number) {
  const parts = serviceDateFormatter.formatToParts(baseDate);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  const result = new Date(
    Date.UTC(year, month - 1, day, 0, minutes) - SERVICE_UTC_OFFSET_MINUTES * 60_000,
  );
  return result.toISOString();
}

function createLegId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}

export function getTimeReliabilityRank(reliability: CandidateTimeReliability) {
  switch (reliability) {
    case "OFFICIAL":
      return 0;
    case "ESTIMATED":
      return 1;
    case "ROUGH":
      return 2;
  }
}

export function getTimeReliabilityBuffer(reliability: CandidateTimeReliability) {
  switch (reliability) {
    case "OFFICIAL":
      return 0;
    case "ESTIMATED":
      return ESTIMATED_BUFFER;
    case "ROUGH":
      return ROUGH_BUFFER;
  }
}

export function maxTimeReliability(
  ...values: CandidateTimeReliability[]
): CandidateTimeReliability {
  return values.reduce((current, candidate) =>
    getTimeReliabilityRank(candidate) > getTimeReliabilityRank(current) ? candidate : current,
  );
}

export function getWindowMinutes(startMinutes: number | null, endMinutes: number | null) {
  if (startMinutes === null || endMinutes === null) {
    return 0;
  }

  return Math.max(0, endMinutes - startMinutes);
}

export function shiftWindow(
  startMinutes: number | null,
  endMinutes: number | null,
  deltaMinutes: number,
) {
  if (startMinutes === null || endMinutes === null) {
    return {
      startMinutes: null,
      endMinutes: null,
    };
  }

  return {
    startMinutes: startMinutes + deltaMinutes,
    endMinutes: endMinutes + deltaMinutes,
  };
}

export function mergeWindows(
  ...windows: Array<{
    startMinutes: number | null;
    endMinutes: number | null;
  }>
) {
  const validWindows = windows.filter(
    (window) => window.startMinutes !== null && window.endMinutes !== null,
  ) as Array<{
    startMinutes: number;
    endMinutes: number;
  }>;

  if (validWindows.length === 0) {
    return {
      startMinutes: null,
      endMinutes: null,
    };
  }

  return {
    startMinutes: Math.min(...validWindows.map((window) => window.startMinutes)),
    endMinutes: Math.max(...validWindows.map((window) => window.endMinutes)),
  };
}

export function resolveStopTimeReliability(stopTime: TripStopContext): CandidateTimeReliability {
  if (stopTime.timeReliability) {
    return stopTime.timeReliability;
  }

  return stopTime.isEstimated ? "ESTIMATED" : "OFFICIAL";
}

export function getStopTimeWindow(stopTime: TripStopContext) {
  return {
    startMinutes: stopTime.windowStartMinutes ?? null,
    endMinutes: stopTime.windowEndMinutes ?? null,
  };
}

export function getStopTimeWindowMinutes(stopTime: TripStopContext) {
  return getWindowMinutes(
    stopTime.windowStartMinutes ?? null,
    stopTime.windowEndMinutes ?? null,
  );
}
