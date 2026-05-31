import type { TimeReliabilityMode } from "@/features/planner/types";

export function plannerFallbackMessageForStatus(options?: {
  timeReliabilityMode?: TimeReliabilityMode;
  nextSuggestedTimeReliabilityMode?: TimeReliabilityMode;
}) {
  if (options?.nextSuggestedTimeReliabilityMode === "INCLUDE_ESTIMATED") {
    return "공식 시간표만으로는 연결 가능한 경로를 찾지 못했습니다. `추정 포함`으로 다시 계산하면 더 많은 경로를 볼 수 있습니다.";
  }

  if (options?.nextSuggestedTimeReliabilityMode === "ALLOW_ROUGH") {
    return options.timeReliabilityMode === "OFFICIAL_ONLY"
      ? "공식과 추정 시각만으로는 연결 가능한 경로를 찾지 못했습니다. `대략까지 허용`으로 다시 계산하면 대략 범위 기반 경로를 볼 수 있습니다."
      : "`대략까지 허용`으로 다시 계산하면 대략 범위 기반 경로를 볼 수 있습니다. 대략 시각은 fallback-only이며 실제 교통상황과 분기 운행에 따라 달라질 수 있습니다.";
  }

  return "선택한 순서로 오늘 연결 가능한 버스를 찾지 못했습니다. 시작 시각이나 장소 순서를 바꿔 다시 시도해 주세요.";
}

export function nextHigherTimeReliabilityMode(mode: TimeReliabilityMode) {
  switch (mode) {
    case "OFFICIAL_ONLY":
      return "INCLUDE_ESTIMATED" as const;
    case "INCLUDE_ESTIMATED":
      return "ALLOW_ROUGH" as const;
    case "ALLOW_ROUGH":
      return null;
  }
}

export function statusFromNextSuggestedMode(nextSuggestedMode: TimeReliabilityMode | null) {
  switch (nextSuggestedMode) {
    case "INCLUDE_ESTIMATED":
      return "NO_ROUTE_ESTIMATED_AVAILABLE";
    case "ALLOW_ROUGH":
      return "NO_ROUTE_ROUGH_AVAILABLE";
    default:
      return "NO_ROUTE";
  }
}

export function nextSuggestedModeFromStatus(status: string): TimeReliabilityMode | undefined {
  if (status === "NO_ROUTE_GENERATED_AVAILABLE" || status === "NO_ROUTE_ESTIMATED_AVAILABLE") {
    return "INCLUDE_ESTIMATED";
  }

  if (status === "NO_ROUTE_ROUGH_AVAILABLE") {
    return "ALLOW_ROUGH";
  }

  return undefined;
}

export function getAllowedDerivedTimeSources(mode: TimeReliabilityMode) {
  switch (mode) {
    case "OFFICIAL_ONLY":
      return new Set<string>();
    case "INCLUDE_ESTIMATED":
      return new Set(["SEGMENT_PROFILE", "OFFICIAL_ANCHOR_INTERPOLATED"]);
    case "ALLOW_ROUGH":
      return new Set([
        "SEGMENT_PROFILE",
        "OFFICIAL_ANCHOR_INTERPOLATED",
        "DISTANCE_INTERPOLATED",
      ]);
  }
}

function derivedStopTimeSourceRank(source: string) {
  switch (source) {
    case "SEGMENT_PROFILE":
      return 3;
    case "OFFICIAL_ANCHOR_INTERPOLATED":
      return 2;
    case "DISTANCE_INTERPOLATED":
      return 1;
    default:
      return 0;
  }
}

export function choosePreferredDerivedStopTimes<
  T extends {
    sequence: number;
    timeSource: string;
    confidence: number;
  },
>(stopTimes: T[]) {
  const bySequence = new Map<number, T>();

  for (const stopTime of stopTimes) {
    const current = bySequence.get(stopTime.sequence);
    if (
      !current ||
      derivedStopTimeSourceRank(stopTime.timeSource) >
        derivedStopTimeSourceRank(current.timeSource) ||
      (derivedStopTimeSourceRank(stopTime.timeSource) ===
        derivedStopTimeSourceRank(current.timeSource) &&
        stopTime.confidence > current.confidence)
    ) {
      bySequence.set(stopTime.sequence, stopTime);
    }
  }

  return [...bySequence.values()].sort((left, right) => left.sequence - right.sequence);
}
