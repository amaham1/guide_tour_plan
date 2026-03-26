import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  fetchBusJejuLineCandidates,
  fetchBusJejuLineInfo,
  type BusJejuLineCandidate,
} from "@/worker/jobs/bus-jeju-live";
import { normalizeText } from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

const DEBUG_STATIONS = ["406000816", "406000817", "406000684"] as const;

function buildCandidateKeys(candidate: BusJejuLineCandidate) {
  const combined = [candidate.routeNum, candidate.routeSubNm].filter(Boolean).join("-");
  return new Set(
    [candidate.routeNm, candidate.routeNum, combined]
      .map((value) => normalizeText(value))
      .filter(Boolean),
  );
}

function matchesRouteShortName(candidate: BusJejuLineCandidate, routeShortName: string) {
  const target = normalizeText(routeShortName);
  const targetBase = normalizeText(routeShortName.split("-")[0]);
  const keys = buildCandidateKeys(candidate);
  return keys.has(target) || keys.has(targetBase);
}

export async function runTransitAuditJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const [
    routes,
    activePatternStops,
    activePatterns,
    activeScheduleSources,
    tripCount,
    stopCount,
    routeGeometries,
    stopProjections,
  ] =
    await Promise.all([
      runtime.prisma.route.findMany({
        where: {
          isActive: true,
        },
      }),
      runtime.prisma.routePatternStop.findMany({
        where: {
          routePattern: {
            isActive: true,
          },
        },
        include: {
          routePattern: {
            select: {
              externalRouteId: true,
            },
          },
        },
      }),
      runtime.prisma.routePattern.count({
        where: {
          isActive: true,
        },
      }),
      runtime.prisma.routePatternScheduleSource.count({
        where: {
          isActive: true,
        },
      }),
      runtime.prisma.trip.count(),
      runtime.prisma.stop.count(),
      runtime.prisma.routePatternGeometry.findMany({
        select: {
          routePatternId: true,
          confidence: true,
          sourceKind: true,
        },
      }),
      runtime.prisma.routePatternStopProjection.findMany({
        select: {
          routePatternId: true,
          sequence: true,
          offsetMeters: true,
          snapDistanceMeters: true,
        },
      }),
    ]);

  const liveRoutesByStation = new Map<string, Set<string>>();
  const routeDebug = new Map<string, number>();
  let livePatternCount = 0;

  for (const route of routes) {
    const searchTerms = [...new Set([route.shortName, route.shortName.split("-")[0]])].filter(
      Boolean,
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

    for (const candidate of candidates.values()) {
      try {
        const lineInfo = await fetchBusJejuLineInfo(runtime, candidate.routeId);
        const externalRouteId = normalizeText(lineInfo.routeId);
        if (!externalRouteId) {
          continue;
        }

        livePatternCount += 1;
        routeDebug.set(externalRouteId, lineInfo.stationInfoList.length);
        for (const stop of lineInfo.stationInfoList) {
          const stationId = normalizeText(stop.stationId);
          if (!stationId) {
            continue;
          }

          const next = liveRoutesByStation.get(stationId) ?? new Set<string>();
          next.add(externalRouteId);
          liveRoutesByStation.set(stationId, next);
        }
      } catch {
        continue;
      }
    }
  }

  const dbRoutesByStation = new Map<string, Set<string>>();
  for (const stop of activePatternStops) {
    const externalRouteId = normalizeText(stop.routePattern.externalRouteId);
    if (!externalRouteId) {
      continue;
    }

    const next = dbRoutesByStation.get(stop.stopId) ?? new Set<string>();
    next.add(externalRouteId);
    dbRoutesByStation.set(stop.stopId, next);
  }

  const coverageGaps = [...liveRoutesByStation.entries()]
    .map(([stationId, routeIds]) => {
      const dbRouteIds = dbRoutesByStation.get(stationId) ?? new Set<string>();
      return {
        stationId,
        liveRouteCount: routeIds.size,
        dbRouteCount: dbRouteIds.size,
        missingRouteIds: [...routeIds].filter((routeId) => !dbRouteIds.has(routeId)),
      };
    })
    .filter((row) => row.missingRouteIds.length > 0)
    .sort((left, right) => right.missingRouteIds.length - left.missingRouteIds.length)
    .slice(0, 20);

  const debugStations = DEBUG_STATIONS.map((stationId) => ({
    stationId,
    liveRouteIds: [...(liveRoutesByStation.get(stationId) ?? new Set<string>())],
    dbRouteIds: [...(dbRoutesByStation.get(stationId) ?? new Set<string>())],
    routeDebug: [...(liveRoutesByStation.get(stationId) ?? new Set<string>())]
      .slice(0, 3)
      .map((routeId) => ({
        routeId,
        stopCount: routeDebug.get(routeId) ?? 0,
      })),
  }));

  const geometryPatternIds = new Set(routeGeometries.map((geometry) => geometry.routePatternId));
  const geometrySourceBreakdown = routeGeometries.reduce<Record<string, number>>((acc, geometry) => {
    acc[geometry.sourceKind] = (acc[geometry.sourceKind] ?? 0) + 1;
    return acc;
  }, {});
  const patternStopMap = new Map<string, typeof activePatternStops>();
  for (const stop of activePatternStops) {
    const next = patternStopMap.get(stop.routePatternId) ?? [];
    next.push(stop);
    patternStopMap.set(stop.routePatternId, next);
  }

  const projectionMap = new Map<string, typeof stopProjections>();
  for (const projection of stopProjections) {
    const next = projectionMap.get(projection.routePatternId) ?? [];
    next.push(projection);
    projectionMap.set(projection.routePatternId, next);
  }

  const placeholderDistancePatternCount = [...patternStopMap.values()].filter((stops) => {
    const sorted = [...stops].sort((left, right) => left.sequence - right.sequence);
    return (
      sorted.length > 1 &&
      sorted.every((stop, index) => stop.distanceFromStart === index * 1000)
    );
  }).length;

  const projectionMonotonicFailureCount = [...projectionMap.values()].filter((items) => {
    const sorted = [...items].sort((left, right) => left.sequence - right.sequence);
    return sorted.some((item, index) => index > 0 && item.offsetMeters < sorted[index - 1]!.offsetMeters);
  }).length;

  const projectionCoverageCount = [...projectionMap.values()].filter((items) => items.length > 0).length;
  const meanSnapDistance =
    stopProjections.length === 0
      ? null
      : Math.round(
          stopProjections.reduce((sum, projection) => sum + projection.snapDistanceMeters, 0) /
            stopProjections.length,
        );
  const lowConfidenceGeometryCount = routeGeometries.filter((geometry) => geometry.confidence < 0.7).length;

  return {
    processedCount: routes.length,
    successCount: activePatterns,
    failureCount:
      coverageGaps.length +
      lowConfidenceGeometryCount +
      placeholderDistancePatternCount +
      projectionMonotonicFailureCount,
    meta: {
      stopCount,
      livePatternCount,
      activePatternCount: activePatterns,
      activeScheduleSourceCount: activeScheduleSources,
      tripCount,
      geometryCoverage:
        activePatterns === 0 ? 0 : Math.round((geometryPatternIds.size / activePatterns) * 100),
      geometrySourceBreakdown,
      gtfsConfigured: Boolean(runtime.env.gtfsFeedUrl || runtime.env.gtfsShapesPath),
      stopProjectionCoverage:
        activePatterns === 0 ? 0 : Math.round((projectionCoverageCount / activePatterns) * 100),
      meanSnapDistance,
      lowConfidenceGeometryCount,
      placeholderDistancePatternCount,
      projectionMonotonicFailureCount,
      coverageGaps,
      debugStations,
      source: {
        routeSearch: `${runtime.env.busJejuBaseUrl}/data/search/searchSimpleLineListByLineNumAndType`,
        routeInfo: `${runtime.env.busJejuBaseUrl}/data/search/getLineInfoByLineId`,
      },
    },
  };
}
