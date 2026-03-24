import type {
  CandidateLeg,
  CandidateSummary,
  ExecutionStatusDto,
} from "@/features/planner/types";

type Snapshot = {
  summary: CandidateSummary;
  legs: CandidateLeg[];
};

type RealtimeSignal = {
  applied: boolean;
  delayMinutes: number;
  replacementSuggested: boolean;
  notice: string;
  reason?: string | null;
};

type RealtimeOptions = {
  realtime?: RealtimeSignal;
};

function addMinutes(base: string, minutes: number) {
  return new Date(new Date(base).getTime() + minutes * 60_000).toISOString();
}

function getActiveLegIndex(legs: CandidateLeg[], now: Date) {
  const nowMs = now.getTime();

  for (let index = 0; index < legs.length; index += 1) {
    const leg = legs[index];
    const startMs = new Date(leg.startAt).getTime();
    const endMs = new Date(leg.endAt).getTime();

    if (nowMs >= startMs && nowMs < endMs) {
      return index;
    }
  }

  return -1;
}

function getUpcomingLegIndex(legs: CandidateLeg[], now: Date) {
  const nowMs = now.getTime();
  return legs.findIndex((leg) => new Date(leg.startAt).getTime() > nowMs);
}

export function buildExecutionStatus(
  sessionId: string,
  snapshot: Snapshot,
  options: RealtimeOptions = {},
  now = new Date(),
): ExecutionStatusDto {
  const activeLegIndex = getActiveLegIndex(snapshot.legs, now);
  const nextLegIndex = getUpcomingLegIndex(snapshot.legs, now);
  const lastLeg = snapshot.legs[snapshot.legs.length - 1] ?? null;

  if (!lastLeg) {
    return {
      sessionId,
      status: "FAILED",
      realtimeApplied: false,
      delayMinutes: 0,
      nextActionAt: null,
      replacementSuggested: false,
      notice: "세션에 안내할 leg 데이터가 없습니다.",
      realtimeReason: "EMPTY_SNAPSHOT",
      currentLegIndex: 0,
      currentLeg: null,
      nextLeg: null,
      summary: snapshot.summary,
      legs: snapshot.legs,
    };
  }

  if (now.getTime() >= new Date(lastLeg.endAt).getTime()) {
    return {
      sessionId,
      status: "COMPLETED",
      realtimeApplied: false,
      delayMinutes: 0,
      nextActionAt: null,
      replacementSuggested: false,
      notice: "모든 일정이 종료되었습니다.",
      realtimeReason: null,
      currentLegIndex: snapshot.legs.length - 1,
      currentLeg: lastLeg,
      nextLeg: null,
      summary: snapshot.summary,
      legs: snapshot.legs,
    };
  }

  const currentLeg =
    activeLegIndex >= 0 ? snapshot.legs[activeLegIndex] : null;
  const nextLeg =
    activeLegIndex >= 0
      ? snapshot.legs[activeLegIndex + 1] ?? null
      : nextLegIndex >= 0
        ? snapshot.legs[nextLegIndex]
        : null;

  const currentLegIndex =
    activeLegIndex >= 0 ? activeLegIndex : Math.max(nextLegIndex, 0);

  if (currentLeg && currentLeg.kind === "ride" && options.realtime?.applied) {
    return {
      sessionId,
      status: "ACTIVE",
      realtimeApplied: true,
      delayMinutes: options.realtime.delayMinutes,
      nextActionAt: addMinutes(currentLeg.endAt, options.realtime.delayMinutes),
      replacementSuggested: options.realtime.replacementSuggested,
      notice: options.realtime.notice,
      realtimeReason: options.realtime.reason ?? null,
      currentLegIndex,
      currentLeg,
      nextLeg,
      summary: snapshot.summary,
      legs: snapshot.legs,
    };
  }

  return {
    sessionId,
    status: "ACTIVE",
    realtimeApplied: false,
    delayMinutes: 0,
    nextActionAt: currentLeg ? currentLeg.endAt : nextLeg?.startAt ?? null,
    replacementSuggested: false,
    notice: "현재는 시간표 기준 안내입니다.",
    realtimeReason: options.realtime?.reason ?? null,
    currentLegIndex,
    currentLeg,
    nextLeg,
    summary: snapshot.summary,
    legs: snapshot.legs,
  };
}
