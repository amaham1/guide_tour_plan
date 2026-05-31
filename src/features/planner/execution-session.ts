import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { appEnv } from "@/lib/env";
import { ResourceNotFoundError } from "@/lib/errors";
import { buildExecutionStatus } from "@/features/planner/realtime";
import {
  estimateDelayMinutesFromGnss,
  fetchLatestGnssPosition,
} from "@/features/planner/realtime-source";
import {
  createSessionSchema,
  type ExecutionStatusDto,
} from "@/features/planner/types";
import {
  normalizeCandidateLeg,
  normalizeCandidateSummary,
  parseJson,
} from "@/features/planner/serialization";

export async function createExecutionSession(rawInput: unknown) {
  const input = createSessionSchema.parse(rawInput);

  const candidate = await db.planCandidate.findUnique({
    where: {
      id: input.planCandidateId,
    },
  });

  if (!candidate) {
    throw new ResourceNotFoundError("실행할 후보 일정을 찾지 못했습니다.");
  }

  const snapshot = {
    summary: normalizeCandidateSummary(parseJson<Record<string, unknown>>(candidate.summary)),
    legs: parseJson<Record<string, unknown>[]>(candidate.legs).map(normalizeCandidateLeg),
  };

  const session = await db.executionSession.create({
    data: {
      planCandidateId: candidate.id,
      status: "ACTIVE",
      snapshot: snapshot as Prisma.InputJsonValue,
    },
  });

  return {
    sessionId: session.id,
    executeUrl: `/planner/execute/${session.id}`,
  };
}

async function resolveRealtimeSignal(
  provisional: ExecutionStatusDto,
  vehicleDeviceMap: Map<
    string,
    { deviceId: string; routePatternId: string; externalRouteId: string | null }
  >,
  prisma: PrismaClient,
  now = new Date(),
) {
  function buildRealtimeFallback(
    reason: string,
    notice = "현재는 시간표 기준 안내입니다.",
  ) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice,
      reason,
    };
  }

  function findTrackedRideLeg(status: ExecutionStatusDto) {
    const rideLeg =
      status.currentLeg?.kind === "ride"
        ? status.currentLeg
        : status.nextLeg?.kind === "ride"
          ? status.nextLeg
          : null;

    if (!rideLeg) {
      return null;
    }

    const legIndex = status.legs.findIndex((leg) => leg.id === rideLeg.id);
    return legIndex >= 0 ? { leg: rideLeg, legIndex } : null;
  }

  function shouldSuggestReplacement(
    status: ExecutionStatusDto,
    rideLegIndex: number,
    delayMinutes: number,
  ) {
    if (delayMinutes <= 0) {
      return false;
    }

    const rideLeg = status.legs[rideLegIndex];
    if (!rideLeg || rideLeg.kind !== "ride") {
      return false;
    }

    const nextRideLeg = status.legs.find(
      (leg, index) => index > rideLegIndex && leg.kind === "ride",
    );
    if (!nextRideLeg) {
      return false;
    }

    const scheduledSlackMinutes = Math.round(
      (new Date(nextRideLeg.startAt).getTime() - new Date(rideLeg.endAt).getTime()) / 60_000,
    );

    return scheduledSlackMinutes < delayMinutes + 2;
  }

  const trackedRideLeg = findTrackedRideLeg(provisional);

  if (!trackedRideLeg?.leg.routePatternId) {
    return buildRealtimeFallback("NO_ACTIVE_RIDE");
  }

  if (trackedRideLeg.leg.timeReliability === "ROUGH") {
    return buildRealtimeFallback(
      "ROUGH_STOP_TIMES",
      "대략 시각 구간은 실시간 보정을 적용하지 않고 시간표 범위 기준으로 안내합니다.",
    );
  }

  const mapping = vehicleDeviceMap.get(trackedRideLeg.leg.routePatternId);
  if (!mapping) {
    return buildRealtimeFallback(
      "VEHICLE_MAP_MISSING",
      "차량 매핑이 없어 지금은 시간표 기준으로 안내합니다.",
    );
  }

  if (!appEnv.dataGoKrServiceKey) {
    return buildRealtimeFallback(
      "DATA_GO_KR_SERVICE_KEY_MISSING",
      "실시간 인증키가 없어 지금은 시간표 기준으로 안내합니다.",
    );
  }

  if (!trackedRideLeg.leg.fromStopId || !trackedRideLeg.leg.toStopId) {
    return buildRealtimeFallback(
      "STOP_REFERENCE_MISSING",
      "정류장 기준점을 찾지 못해 지금은 시간표 기준으로 안내합니다.",
    );
  }

  const [startStop, endStop] = await Promise.all([
    prisma.stop.findUnique({ where: { id: trackedRideLeg.leg.fromStopId } }),
    prisma.stop.findUnique({ where: { id: trackedRideLeg.leg.toStopId } }),
  ]);

  if (!startStop || !endStop) {
    return buildRealtimeFallback(
      "STOP_LOOKUP_FAILED",
      "정류장 정보를 찾지 못해 지금은 시간표 기준으로 안내합니다.",
    );
  }

  try {
    const position = await fetchLatestGnssPosition(
      appEnv.dataGoKrServiceKey,
      mapping.deviceId,
      now,
    );

    if (!position) {
      return buildRealtimeFallback(
        "GNSS_EMPTY",
        "실시간 위치 수신이 없어 지금은 시간표 기준으로 안내합니다.",
      );
    }

    const delayMinutes = estimateDelayMinutesFromGnss(
      trackedRideLeg.leg,
      startStop,
      endStop,
      position,
      now,
    );
    const replacementSuggested = shouldSuggestReplacement(
      provisional,
      trackedRideLeg.legIndex,
      delayMinutes,
    );

    return {
      applied: true,
      delayMinutes,
      replacementSuggested,
      notice:
        delayMinutes > 0
          ? `실시간 GNSS 기준 약 ${delayMinutes}분 지연입니다.`
          : "실시간 GNSS 기준 정상 운행 중입니다.",
      reason: "GNSS",
    };
  } catch (error) {
    return buildRealtimeFallback(
      "GNSS_REQUEST_FAILED",
      error instanceof Error && /timeout|timed out/i.test(error.message)
        ? "실시간 위치 요청이 지연되어 지금은 시간표 기준으로 안내합니다."
        : "실시간 위치 요청이 실패해 지금은 시간표 기준으로 안내합니다.",
    );
  }
}

export async function getExecutionSessionStatus(
  sessionId: string,
): Promise<ExecutionStatusDto> {
  const session = await db.executionSession.findUnique({
    where: {
      id: sessionId,
    },
  });

  if (!session) {
    throw new ResourceNotFoundError("실행 세션을 찾지 못했습니다.");
  }

  const rawSnapshot = parseJson<{
    summary: Record<string, unknown>;
    legs: Record<string, unknown>[];
  }>(session.snapshot);
  const snapshot = {
    summary: normalizeCandidateSummary(rawSnapshot.summary),
    legs: rawSnapshot.legs.map(normalizeCandidateLeg),
  };

  const now = new Date();
  const provisional = buildExecutionStatus(session.id, snapshot, {}, now);
  const routePatternIds = [...new Set(
    snapshot.legs
      .filter((leg) => leg.kind === "ride" && leg.routePatternId)
      .map((leg) => leg.routePatternId as string),
  )];
  const vehicleDeviceMappings =
    routePatternIds.length === 0
      ? []
      : await db.vehicleDeviceMap.findMany({
          where: {
            routePatternId: {
              in: routePatternIds,
            },
          },
          orderBy: {
            refreshedAt: "desc",
          },
        });
  const vehicleDeviceMap = new Map<
    string,
    { deviceId: string; routePatternId: string; externalRouteId: string | null }
  >();

  for (const mapping of vehicleDeviceMappings) {
    if (vehicleDeviceMap.has(mapping.routePatternId)) {
      continue;
    }

    vehicleDeviceMap.set(mapping.routePatternId, {
      deviceId: mapping.deviceId,
      routePatternId: mapping.routePatternId,
      externalRouteId: mapping.externalRouteId,
    });
  }

  const realtime = await resolveRealtimeSignal(provisional, vehicleDeviceMap, db, now);
  const status = buildExecutionStatus(session.id, snapshot, { realtime }, now);

  await db.executionSession.update({
    where: { id: session.id },
    data: {
      currentLegIndex: status.currentLegIndex,
      lastRealtimeApplied: status.realtimeApplied,
      status: status.status,
    },
  });

  return status;
}
