import { PlanPreference } from "@prisma/client";
import type {
  CandidateLeg,
  CandidateMetrics,
  CandidateSummary,
  CandidateTimeReliability,
  CandidateWarning,
} from "@/features/planner/types";
import type { DraftLeg, PlaceContext, StopContext, TripContext, TripStopContext } from "@/features/planner/engine-types";
import {
  fromServiceMinutes,
  getStopTimeWindow,
  getStopTimeWindowMinutes,
  getWindowMinutes,
  maxTimeReliability,
  resolveStopTimeReliability,
  shiftWindow,
} from "@/features/planner/engine-time";

function createLegId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}

export function buildWarnings(metrics: CandidateMetrics): CandidateWarning[] {
  const warnings: CandidateWarning[] = [];

  if (metrics.worstTimeReliability === "ROUGH") {
    warnings.push({
      code: "ROUGH_STOP_TIMES",
      message:
        "일부 정류장 시각은 대략 추정 범위입니다. 실제 교통상황과 분기 운행에 따라 달라질 수 있어 여유 있게 이동해 주세요.",
    });
  } else if (metrics.worstTimeReliability === "ESTIMATED") {
    warnings.push({
      code: "ESTIMATED_STOP_TIMES",
      message: "일부 정류장 시각은 공식 시간표가 없어 서비스가 생성한 시각입니다. 여유 시간을 두고 이동해 주세요.",
    });
  }

  if (!metrics.realtimeEligible) {
    warnings.push({
      code: "REALTIME_UNAVAILABLE",
      message: "실시간 매핑이 없는 구간이 포함되어 있어 시간표 기준으로 안내합니다.",
    });
  }

  if (metrics.transfers > 0) {
    warnings.push({
      code: "TRANSFER_REQUIRED",
      message: `환승 ${metrics.transfers}회가 포함되어 있어 다음 탑승 구간을 다시 확인해야 합니다.`,
    });
  }

  return warnings;
}

function getCandidateCopy(kind: PlanPreference) {
  switch (kind) {
    case "FASTEST":
      return {
        title: "가장 빠른 동선",
        narrative: "최종 도착 시각이 가장 앞서는 조합입니다.",
      };
    case "LEAST_WALK":
      return {
        title: "도보 최소 동선",
        narrative: "걷는 시간을 줄이는 대신 대기 구간이 조금 더 있을 수 있습니다.",
      };
    case "LEAST_TRANSFER":
      return {
        title: "환승 최소 동선",
        narrative: "탑승 흐름을 단순하게 유지하는 데 초점을 둔 조합입니다.",
      };
  }
}

export function materializeLegs(baseDate: Date, legs: DraftLeg[], prefix: string): CandidateLeg[] {
  return legs.map((leg, index) => ({
    id: createLegId(prefix, index),
    kind: leg.kind,
    title: leg.title,
    subtitle: leg.subtitle,
    startAt: fromServiceMinutes(baseDate, leg.startMinutes),
    endAt: fromServiceMinutes(baseDate, leg.endMinutes),
    durationMinutes: leg.endMinutes - leg.startMinutes,
    fromLabel: leg.fromLabel,
    toLabel: leg.toLabel,
    routeShortName: leg.routeShortName,
    routePatternId: leg.routePatternId,
    tripId: leg.tripId,
    placeId: leg.placeId,
    fromStopId: leg.fromStopId,
    toStopId: leg.toStopId,
    timeReliability: leg.timeReliability,
    startWindowAt:
      leg.startWindowAt !== undefined && leg.startWindowAt !== null
        ? fromServiceMinutes(baseDate, leg.startWindowAt)
        : null,
    endWindowAt:
      leg.endWindowAt !== undefined && leg.endWindowAt !== null
        ? fromServiceMinutes(baseDate, leg.endWindowAt)
        : null,
  }));
}

export function buildSummary(
  planId: string,
  baseDate: Date,
  kind: PlanPreference,
  metrics: CandidateMetrics,
): CandidateSummary {
  const copy = getCandidateCopy(kind);
  return {
    planId,
    title: copy.title,
    narrative: copy.narrative,
    totalDurationMinutes: metrics.totalDurationMinutes,
    totalWalkMinutes: metrics.totalWalkMinutes,
    transfers: metrics.transfers,
    finalArrivalAt: fromServiceMinutes(baseDate, metrics.finalArrivalMinutes),
    realtimeEligible: metrics.realtimeEligible,
    worstTimeReliability: metrics.worstTimeReliability,
    finalArrivalWindowStartAt:
      typeof metrics.finalArrivalWindowStartMinutes === "number"
        ? fromServiceMinutes(baseDate, metrics.finalArrivalWindowStartMinutes)
        : null,
    finalArrivalWindowEndAt:
      typeof metrics.finalArrivalWindowEndMinutes === "number"
        ? fromServiceMinutes(baseDate, metrics.finalArrivalWindowEndMinutes)
        : null,
    safetyBufferCost: metrics.safetyBufferCost,
  };
}

export function createVisitLeg(
  placeId: string,
  placeName: string,
  startMinutes: number,
  dwellMinutes: number,
): DraftLeg {
  return {
    kind: "visit",
    title: `${placeName} 체류`,
    subtitle: `${dwellMinutes}분 머무르기`,
    startMinutes,
    endMinutes: startMinutes + dwellMinutes,
    fromLabel: placeName,
    toLabel: placeName,
    placeId,
    timeReliability: "OFFICIAL",
  };
}

export function getRideLegTimeReliability(
  boardStopTime: TripStopContext,
  alightStopTime: TripStopContext,
) {
  return maxTimeReliability(
    resolveStopTimeReliability(boardStopTime),
    resolveStopTimeReliability(alightStopTime),
  );
}

export function createAccessWalkLeg(
  fromPlace: PlaceContext,
  toStop: StopContext | undefined,
  toStopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const stopName = toStop?.displayName ?? toStopId;
  return {
    kind: "walk",
    title: `${fromPlace.displayName}에서 ${stopName}까지 도보`,
    startMinutes,
    endMinutes,
    fromLabel: fromPlace.displayName,
    toLabel: stopName,
    toStopId,
    timeReliability: "OFFICIAL",
  };
}

export function createTransferWalkLeg(
  fromStop: StopContext | undefined,
  toStop: StopContext | undefined,
  fromStopId: string,
  toStopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const fromStopName = fromStop?.displayName ?? fromStopId;
  const toStopName = toStop?.displayName ?? toStopId;
  return {
    kind: "walk",
    title: `${fromStopName}에서 ${toStopName}까지 환승 도보`,
    startMinutes,
    endMinutes,
    fromLabel: fromStopName,
    toLabel: toStopName,
    fromStopId,
    toStopId,
    timeReliability: "OFFICIAL",
  };
}

export function createEgressWalkLeg(
  fromStop: StopContext | undefined,
  fromStopId: string,
  toPlace: PlaceContext,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const stopName = fromStop?.displayName ?? fromStopId;
  return {
    kind: "walk",
    title: `${stopName}에서 ${toPlace.displayName}까지 도보`,
    startMinutes,
    endMinutes,
    fromLabel: stopName,
    toLabel: toPlace.displayName,
    fromStopId,
    timeReliability: "OFFICIAL",
  };
}

export function createWaitLeg(
  stopName: string,
  stopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  return {
    kind: "wait",
    title: `${stopName}에서 버스 대기`,
    startMinutes,
    endMinutes,
    fromLabel: stopName,
    toLabel: stopName,
    fromStopId: stopId,
    toStopId: stopId,
    timeReliability: "OFFICIAL",
  };
}

export function createRideLeg(
  trip: TripContext,
  boardStopTime: TripStopContext,
  alightStopTime: TripStopContext,
  timeReliability: CandidateTimeReliability,
): DraftLeg {
  const boardWindow = getStopTimeWindow(boardStopTime);
  const shiftedBoardWindow = shiftWindow(
    boardWindow.startMinutes,
    boardWindow.endMinutes,
    alightStopTime.arrivalMinutes - boardStopTime.departureMinutes,
  );
  const alightWindow = getStopTimeWindow(alightStopTime);
  const legEndWindowCandidates = [
    shiftedBoardWindow.endMinutes,
    alightWindow.endMinutes,
  ].filter((value): value is number => value !== null);

  return {
    kind: "ride",
    title: `${trip.routeShortName}번 탑승`,
    subtitle: `${boardStopTime.stopName} → ${alightStopTime.stopName}`,
    startMinutes: boardStopTime.departureMinutes,
    endMinutes: alightStopTime.arrivalMinutes,
    fromLabel: boardStopTime.stopName,
    toLabel: alightStopTime.stopName,
    routeShortName: trip.routeShortName,
    routePatternId: trip.routePatternId,
    tripId: trip.id,
    fromStopId: boardStopTime.stopId,
    toStopId: alightStopTime.stopId,
    timeReliability,
    startWindowAt:
      timeReliability === "ROUGH"
        ? boardWindow.startMinutes ?? boardStopTime.departureMinutes
        : null,
    endWindowAt:
      timeReliability === "ROUGH" && legEndWindowCandidates.length > 0
        ? Math.max(...legEndWindowCandidates)
        : null,
  };
}
