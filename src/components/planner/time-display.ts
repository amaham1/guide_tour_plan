import { formatClock } from "@/lib/utils";
import type { CandidateLeg } from "@/features/planner/types";

export function timeReliabilityModeLabel(mode: string) {
  switch (mode) {
    case "OFFICIAL_ONLY":
      return "공식만";
    case "INCLUDE_ESTIMATED":
      return "추정 포함";
    case "ALLOW_ROUGH":
      return "대략까지 허용";
    default:
      return mode;
  }
}

export function timeReliabilityLabel(reliability: string) {
  switch (reliability) {
    case "OFFICIAL":
      return "공식";
    case "ESTIMATED":
      return "추정";
    case "ROUGH":
      return "대략";
    default:
      return reliability;
  }
}

export function timeReliabilityNote(reliability: string) {
  switch (reliability) {
    case "ESTIMATED":
      return "Interpolated between official anchor stops.";
    case "ROUGH":
      return "Range only. Realtime adjustment is not applied.";
    default:
      return null;
  }
}

export function formatTimeRange(startAt: string | null | undefined, endAt: string | null | undefined) {
  if (!startAt || !endAt) {
    return null;
  }

  return `${formatClock(startAt)} - ${formatClock(endAt)}`;
}

export function formatLegTime(leg: CandidateLeg) {
  if (leg.timeReliability === "ROUGH" && leg.startWindowAt && leg.endWindowAt) {
    return `${formatClock(leg.startWindowAt)} - ${formatClock(leg.endWindowAt)}`;
  }

  return `${formatClock(leg.startAt)} - ${formatClock(leg.endAt)}`;
}

export function formatLegStart(leg: CandidateLeg) {
  if (leg.timeReliability === "ROUGH" && leg.startWindowAt && leg.endWindowAt) {
    return `${formatClock(leg.startWindowAt)} - ${formatClock(leg.endWindowAt)}`;
  }

  return formatClock(leg.startAt);
}

export function legReliabilityNote(leg: CandidateLeg) {
  if (leg.timeReliability === "ESTIMATED") {
    return "공식 anchor 사이를 보간한 시각입니다.";
  }

  if (leg.timeReliability === "ROUGH") {
    return "대략 범위만 제공하며 실시간 보정은 적용하지 않습니다.";
  }

  return null;
}
