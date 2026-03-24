import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  fetchBusJejuLineCandidates,
  fetchBusJejuLineInfo,
  type BusJejuLineCandidate,
  type BusJejuLineInfo,
} from "@/worker/jobs/bus-jeju-live";
import { normalizeText, toNumber } from "@/worker/jobs/helpers";
import {
  buildRouteLookupKeys,
  buildRouteMatchKeys,
  extractRouteShortNameTokens,
} from "@/worker/jobs/route-labels";
import type { JobOutcome } from "@/worker/jobs/types";

type PatternStopSeed = {
  stopId: string;
  sequence: number;
  distanceFromStart: number;
};

type PatternSeed = {
  id: string;
  routeId: string;
  externalRouteId: string;
  directionCode: string;
  waypointOrder: number;
  directionLabel: string;
  displayName: string;
  busType: number | null;
  isActive: boolean;
  stops: PatternStopSeed[];
};

function buildPatternId(externalRouteId: string, directionCode: string, waypointOrder: number) {
  return `pattern-openapi-${externalRouteId}-${directionCode || "0"}-${waypointOrder}`;
}

function buildCandidateKeys(candidate: BusJejuLineCandidate) {
  const keys = new Set<string>();
  const addKey = (value: unknown) => {
    const normalized = normalizeText(value);
    if (normalized) {
      keys.add(normalized);
    }
  };

  addKey(candidate.routeNum);
  addKey(candidate.routeNm);
  addKey([candidate.routeNum, candidate.routeSubNm].filter(Boolean).join("-"));

  for (const token of extractRouteShortNameTokens(String(candidate.routeNum ?? ""))) {
    keys.add(token);
  }

  for (const token of extractRouteShortNameTokens(String(candidate.routeNm ?? ""))) {
    keys.add(token);
  }

  const frontRouteNum = normalizeText(candidate.frontRouteNum);
  const rearRouteNum = normalizeText(candidate.rearRouteNum);
  if (frontRouteNum) {
    keys.add(frontRouteNum);
    if (rearRouteNum && rearRouteNum !== "0") {
      keys.add(`${frontRouteNum}-${rearRouteNum}`);
    }
  }

  return keys;
}

function matchesRouteShortName(candidate: BusJejuLineCandidate, routeShortName: string) {
  const targets = new Set(buildRouteMatchKeys(routeShortName));
  const keys = buildCandidateKeys(candidate);
  return [...keys].some((key) => targets.has(key));
}

function buildPatternSeed(
  routeId: string,
  routeShortName: string,
  lineInfo: BusJejuLineInfo,
  validStopIds: Set<string>,
) {
  const externalRouteId = normalizeText(lineInfo.routeId);
  const directionCode = normalizeText(lineInfo.upDnDir) || "0";
  const waypointOrder = 0;
  const orderedStops = [...lineInfo.stationInfoList]
    .map((stop) => ({
      stopId: normalizeText(stop.stationId),
      sequence: toNumber(stop.linkOrd),
    }))
    .filter(
      (stop): stop is { stopId: string; sequence: number } =>
        Boolean(stop.stopId) && stop.sequence !== null && validStopIds.has(stop.stopId),
    )
    .sort((left, right) => left.sequence - right.sequence);
  const dedupedStops = new Map<number, { stopId: string; sequence: number }>();

  for (const stop of orderedStops) {
    if (!dedupedStops.has(stop.sequence)) {
      dedupedStops.set(stop.sequence, stop);
    }
  }
  const normalizedStops = [...dedupedStops.values()];

  if (!externalRouteId || normalizedStops.length <= 1) {
    return null;
  }

  return {
    id: buildPatternId(externalRouteId, directionCode, waypointOrder),
    routeId,
    externalRouteId,
    directionCode,
    waypointOrder,
    directionLabel:
      [normalizeText(lineInfo.orgtNm), normalizeText(lineInfo.dstNm ?? lineInfo.routeSubNm)]
        .filter(Boolean)
        .join(" → ") || normalizeText(lineInfo.dstNm ?? lineInfo.upDnDir) || directionCode,
    displayName:
      [routeShortName, normalizeText(lineInfo.orgtNm), normalizeText(lineInfo.dstNm ?? lineInfo.routeSubNm)]
        .filter(Boolean)
        .join(" "),
    busType: toNumber(lineInfo.busTypeStr),
    isActive: true,
    stops: normalizedStops.map((stop, index) => ({
      stopId: stop.stopId,
      sequence: stop.sequence,
      distanceFromStart: index * 1_000,
    })),
  } satisfies PatternSeed;
}

function buildPatternSignature(pattern: PatternSeed) {
  return pattern.stops.map((stop) => `${stop.stopId}:${stop.sequence}`).join(">");
}

function dedupePatternSeeds(patternSeeds: PatternSeed[]) {
  const deduped = new Map<string, PatternSeed>();

  for (const pattern of [...patternSeeds].sort((left, right) => {
    const leftId = Number(left.externalRouteId);
    const rightId = Number(right.externalRouteId);
    if (Number.isFinite(leftId) && Number.isFinite(rightId) && leftId !== rightId) {
      return leftId - rightId;
    }

    return left.externalRouteId.localeCompare(right.externalRouteId);
  })) {
    const key = `${pattern.routeId}::${buildPatternSignature(pattern)}`;
    if (!deduped.has(key)) {
      deduped.set(key, pattern);
    }
  }

  return [...deduped.values()];
}

export async function runRoutePatternsOpenApiJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  const [routes, stops] = await Promise.all([
    runtime.prisma.route.findMany({
      where: {
        isActive: true,
      },
    }),
    runtime.prisma.stop.findMany({
      select: {
        id: true,
      },
    }),
  ]);

  const validStopIds = new Set(stops.map((stop) => stop.id));
  const rawPatternSeeds: PatternSeed[] = [];
  let failureCount = 0;
  const unmatchedRoutes: string[] = [];

  for (const route of routes) {
    const searchTerms = buildRouteLookupKeys(route.shortName).filter((term) =>
      /^\d{2,4}(?:-\d+)?$/.test(term),
    );
    const candidates = new Map<string, BusJejuLineCandidate>();

    for (const term of searchTerms) {
      try {
        const rows = await fetchBusJejuLineCandidates(runtime, term);
        for (const row of rows) {
          if (matchesRouteShortName(row, route.shortName)) {
            candidates.set(String(row.routeId), row);
          }
        }
      } catch {
        continue;
      }
    }

    if (candidates.size === 0) {
      unmatchedRoutes.push(route.shortName);
      failureCount += 1;
      continue;
    }

    for (const candidate of candidates.values()) {
      try {
        const lineInfo = await fetchBusJejuLineInfo(runtime, candidate.routeId);
        const pattern = buildPatternSeed(route.id, route.shortName, lineInfo, validStopIds);
        if (!pattern) {
          failureCount += 1;
          continue;
        }

        rawPatternSeeds.push(pattern);
      } catch {
        failureCount += 1;
      }
    }
  }

  const patternSeeds = dedupePatternSeeds(rawPatternSeeds);

  if (patternSeeds.length === 0) {
    throw new Error("No active route patterns could be built from live bus route data.");
  }

  for (const pattern of patternSeeds) {
    await runtime.prisma.routePattern.upsert({
      where: {
        id: pattern.id,
      },
      update: {
        routeId: pattern.routeId,
        scheduleId: null,
        externalRouteId: pattern.externalRouteId,
        directionCode: pattern.directionCode,
        waypointOrder: pattern.waypointOrder,
        isActive: pattern.isActive,
        busType: pattern.busType,
        directionLabel: pattern.directionLabel,
        displayName: pattern.displayName,
      },
      create: {
        id: pattern.id,
        routeId: pattern.routeId,
        scheduleId: null,
        externalRouteId: pattern.externalRouteId,
        directionCode: pattern.directionCode,
        waypointOrder: pattern.waypointOrder,
        isActive: pattern.isActive,
        busType: pattern.busType,
        directionLabel: pattern.directionLabel,
        displayName: pattern.displayName,
      },
    });

    await runtime.prisma.routePatternStop.deleteMany({
      where: {
        routePatternId: pattern.id,
      },
    });

    await runtime.prisma.routePatternStop.createMany({
      data: pattern.stops.map((stop) => ({
        routePatternId: pattern.id,
        stopId: stop.stopId,
        sequence: stop.sequence,
        distanceFromStart: stop.distanceFromStart,
      })),
    });
  }

  await runtime.prisma.routePattern.deleteMany({
    where: {
      id: {
        notIn: patternSeeds.map((pattern) => pattern.id),
      },
    },
  });

  return {
    processedCount: routes.length,
    successCount: patternSeeds.length,
    failureCount,
    meta: {
      source: `${runtime.env.busJejuBaseUrl}/data/search/getLineInfoByLineId`,
      unmatchedRoutes,
      rawPatternCount: rawPatternSeeds.length,
      patternCount: patternSeeds.length,
    },
  };
}
