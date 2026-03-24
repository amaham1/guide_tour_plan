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
  const [routes, activePatternStops, activePatterns, activeScheduleSources, tripCount, stopCount] =
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

  return {
    processedCount: routes.length,
    successCount: activePatterns,
    failureCount: coverageGaps.length,
    meta: {
      stopCount,
      livePatternCount,
      activePatternCount: activePatterns,
      activeScheduleSourceCount: activeScheduleSources,
      tripCount,
      coverageGaps,
      debugStations,
      source: {
        routeSearch: `${runtime.env.busJejuBaseUrl}/data/search/searchSimpleLineListByLineNumAndType`,
        routeInfo: `${runtime.env.busJejuBaseUrl}/data/search/getLineInfoByLineId`,
      },
    },
  };
}
