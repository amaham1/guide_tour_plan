import * as XLSX from "xlsx";
import { loadWorkbook } from "@/worker/core/files";
import { fetchJson } from "@/worker/core/fetch";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { parseScheduleTableRows, type RawScheduleCell } from "@/worker/jobs/bus-jeju-parser";
import {
  fetchBusJejuLineCandidates,
  fetchBusJejuLineInfo,
  type BusJejuLineInfo,
} from "@/worker/jobs/bus-jeju-live";
import {
  buildStopNameKeys,
  ensureDailyServiceCalendar,
  normalizeText,
  scoreStopNameMatch,
} from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type TimetableSheetRow = Record<string, unknown>;

type KnownStop = {
  id: string;
  displayName: string;
  translations: string[];
};

type KnownStopIndex = {
  stops: KnownStop[];
  stopById: Map<string, KnownStop>;
  stopIdsByKey: Map<string, string[]>;
};

type ResolvedStopIds = {
  stopIds: string[];
  unmatchedStopNames: string[];
  matchedLineId: string | null;
  score: number;
};

const lineInfoCache = new Map<string, Promise<BusJejuLineInfo[]>>();

export function parseTimetableWorkbook(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<TimetableSheetRow>(sheet, {
    defval: "",
  });
}

function buildRawRowsFromWorkbookRows(rows: TimetableSheetRow[]): RawScheduleCell[] {
  if (rows.length === 0) {
    return [];
  }

  const headers = Object.keys(rows[0]).filter((key) => key !== "rowLabel");
  const cells: RawScheduleCell[] = headers.map((header, index) => ({
    ROW_SEQ: 0,
    COLUMN_SEQ: index + 1,
    COLUMN_NM: normalizeText(header),
  }));

  rows.forEach((row, rowIndex) => {
    headers.forEach((header, columnIndex) => {
      cells.push({
        ROW_SEQ: rowIndex + 1,
        COLUMN_SEQ: columnIndex + 1,
        COLUMN_NM: normalizeText(row[header]) || null,
      });
    });
  });

  return cells;
}

async function fetchScheduleTable(runtime: WorkerRuntime, scheduleId: string) {
  const source = runtime.env.routeTimetableBaseUrl;

  if (source && /\.(xlsx|xls)$/i.test(source)) {
    const workbook = await loadWorkbook(source);
    return {
      rows: buildRawRowsFromWorkbookRows(parseTimetableWorkbook(workbook)),
      source,
    };
  }

  const rows = await fetchJson<RawScheduleCell[]>(
    `${runtime.env.busJejuBaseUrl}/data/schedule/getScheduleTableInfo`,
    undefined,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams({
        scheduleId,
      }),
    },
  );

  return {
    rows,
    source: source || "bus-jeju-json",
  };
}

function buildKnownStopIndex(
  stops: Array<{
    id: string;
    displayName: string;
    translations: Array<{ displayName: string }>;
  }>,
) {
  const normalizedStops: KnownStop[] = stops.map((stop) => ({
    id: stop.id,
    displayName: stop.displayName,
    translations: stop.translations.map((translation) => translation.displayName),
  }));

  const stopById = new Map(normalizedStops.map((stop) => [stop.id, stop]));
  const stopIdsByKey = new Map<string, string[]>();

  for (const stop of normalizedStops) {
    for (const label of [stop.displayName, ...stop.translations]) {
      for (const key of buildStopNameKeys(label)) {
        const existing = stopIdsByKey.get(key) ?? [];
        if (!existing.includes(stop.id)) {
          existing.push(stop.id);
          stopIdsByKey.set(key, existing);
        }
      }
    }
  }

  return {
    stops: normalizedStops,
    stopById,
    stopIdsByKey,
  } satisfies KnownStopIndex;
}

function getKnownStopScore(stopName: string, stop: KnownStop) {
  return Math.max(
    scoreStopNameMatch(stopName, stop.displayName),
    ...stop.translations.map((translation) => scoreStopNameMatch(stopName, translation)),
  );
}

function chooseKnownStop(stopName: string, knownStops: KnownStopIndex) {
  const exactCandidateIds = new Set<string>();
  const normalizedStopName = normalizeText(stopName);

  for (const key of buildStopNameKeys(stopName)) {
    for (const stopId of knownStops.stopIdsByKey.get(key) ?? []) {
      exactCandidateIds.add(stopId);
    }
  }

  const candidates =
    exactCandidateIds.size > 0
      ? [...exactCandidateIds]
          .map((stopId) => knownStops.stopById.get(stopId))
          .filter((stop): stop is KnownStop => Boolean(stop))
      : knownStops.stops;

  let bestStop: KnownStop | null = null;
  let bestScore = 0;

  for (const stop of candidates) {
    const score = getKnownStopScore(stopName, stop);
    const currentGap = Math.abs(stop.displayName.length - normalizedStopName.length);
    const bestGap = bestStop
      ? Math.abs(bestStop.displayName.length - normalizedStopName.length)
      : Number.POSITIVE_INFINITY;

    if (
      score > bestScore ||
      (score === bestScore &&
        (currentGap < bestGap ||
          (currentGap === bestGap &&
            bestStop &&
            stop.displayName.length > bestStop.displayName.length)))
    ) {
      bestStop = stop;
      bestScore = score;
    }
  }

  if (!bestStop || bestScore < 70) {
    return null;
  }

  return {
    stopId: bestStop.id,
    score: bestScore,
  };
}

async function fetchCandidateLineInfos(runtime: WorkerRuntime, routeShortName: string) {
  const cacheKey = routeShortName;
  const cached = lineInfoCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pending = (async () => {
    const searchTerms = [...new Set([routeShortName, routeShortName.split("-")[0] ?? routeShortName])]
      .map((term) => normalizeText(term))
      .filter(Boolean);
    const candidates = new Map<string, { routeId: string | number }>();

    for (const term of searchTerms) {
      let rows: Awaited<ReturnType<typeof fetchBusJejuLineCandidates>> = [];
      try {
        rows = await fetchBusJejuLineCandidates(runtime, term);
      } catch {
        continue;
      }

      for (const row of rows) {
        if (normalizeText(row.routeNum) === normalizeText(routeShortName.split("-")[0])) {
          candidates.set(String(row.routeId), {
            routeId: row.routeId,
          });
        }
      }
    }

    const lineInfos = await Promise.all(
      [...candidates.values()].map(async (candidate) => {
        try {
          return await fetchBusJejuLineInfo(runtime, candidate.routeId);
        } catch {
          return null;
        }
      }),
    );

    return lineInfos.filter((item): item is BusJejuLineInfo => Boolean(item));
  })();

  lineInfoCache.set(cacheKey, pending);
  return pending;
}

function matchScheduleStopsToLineInfo(
  stopNames: string[],
  lineInfo: BusJejuLineInfo,
  knownStops: KnownStopIndex,
) {
  const orderedStations = [...lineInfo.stationInfoList].sort(
    (left, right) => Number(left.linkOrd ?? 0) - Number(right.linkOrd ?? 0),
  );
  const stopIds: string[] = [];
  const unmatchedStopNames: string[] = [];
  let score = 0;
  let cursor = 0;

  for (const stopName of stopNames) {
    let bestIndex = -1;
    let bestStopId = "";
    let bestScore = 0;

    for (let index = cursor; index < orderedStations.length; index += 1) {
      const station = orderedStations[index];
      const stationId = normalizeText(station.stationId);
      const knownStop = knownStops.stopById.get(stationId);
      const currentScore = Math.max(
        scoreStopNameMatch(stopName, station.stationNm),
        knownStop ? getKnownStopScore(stopName, knownStop) : 0,
      );

      if (currentScore > bestScore) {
        bestIndex = index;
        bestStopId = stationId;
        bestScore = currentScore;
      }

      if (currentScore === 100) {
        break;
      }
    }

    if (bestIndex >= 0 && bestScore >= 70) {
      stopIds.push(bestStopId);
      score += bestScore;
      cursor = bestIndex + 1;
      continue;
    }

    const fallback = chooseKnownStop(stopName, knownStops);
    if (!fallback) {
      unmatchedStopNames.push(stopName);
      continue;
    }

    stopIds.push(fallback.stopId);
    score += Math.floor(fallback.score / 2);
  }

  return {
    stopIds,
    unmatchedStopNames,
    matchedLineId: normalizeText(lineInfo.routeId) || null,
    score,
  };
}

function resolveStopIdsFromKnownStops(stopNames: string[], knownStops: KnownStopIndex) {
  const stopIds: string[] = [];
  const unmatchedStopNames: string[] = [];
  let score = 0;

  for (const stopName of stopNames) {
    const matched = chooseKnownStop(stopName, knownStops);
    if (!matched) {
      unmatchedStopNames.push(stopName);
      continue;
    }

    stopIds.push(matched.stopId);
    score += matched.score;
  }

  return {
    stopIds,
    unmatchedStopNames,
    matchedLineId: null,
    score,
  } satisfies ResolvedStopIds;
}

async function resolveStopIds(
  runtime: WorkerRuntime,
  routeShortName: string,
  stopNames: string[],
  knownStops: KnownStopIndex,
) {
  const lineInfos = await fetchCandidateLineInfos(runtime, routeShortName);
  const candidateMatches = lineInfos.map((lineInfo) =>
    matchScheduleStopsToLineInfo(stopNames, lineInfo, knownStops),
  );
  const fallbackMatch = resolveStopIdsFromKnownStops(stopNames, knownStops);
  const ranked = [...candidateMatches, fallbackMatch].sort((left, right) => {
    if (left.unmatchedStopNames.length !== right.unmatchedStopNames.length) {
      return left.unmatchedStopNames.length - right.unmatchedStopNames.length;
    }

    return right.score - left.score;
  });

  return ranked[0] ?? fallbackMatch;
}

async function purgeLegacyTransitData(runtime: WorkerRuntime) {
  await runtime.prisma.routePattern.deleteMany({
    where: {
      scheduleId: null,
    },
  });

  await runtime.prisma.stopTime.deleteMany({
    where: {
      trip: {
        routePattern: {
          scheduleId: {
            not: null,
          },
        },
      },
    },
  });
  await runtime.prisma.trip.deleteMany({
    where: {
      routePattern: {
        scheduleId: {
          not: null,
        },
      },
    },
  });
  await runtime.prisma.routePatternStop.deleteMany({
    where: {
      routePattern: {
        scheduleId: {
          not: null,
        },
      },
    },
  });
  await runtime.prisma.stop.deleteMany({
    where: {
      OR: [
        { id: { startsWith: "route-stop-" } },
        {
          id: {
            in: [
              "stop-airport",
              "stop-cityhall",
              "stop-museum",
              "stop-dongmun",
              "stop-iho",
              "stop-hallim",
              "stop-seongsan",
            ],
          },
        },
      ],
    },
  });
  await runtime.prisma.route.deleteMany({
    where: {
      patterns: {
        none: {},
      },
    },
  });
}

export async function runTimetablesXlsxJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  await ensureDailyServiceCalendar(runtime.prisma);
  await purgeLegacyTransitData(runtime);

  const [patterns, knownStops] = await Promise.all([
    runtime.prisma.routePattern.findMany({
      where: {
        scheduleId: {
          not: null,
        },
      },
      include: {
        route: true,
      },
    }),
    runtime.prisma.stop.findMany({
      include: {
        translations: true,
      },
    }),
  ]);

  const knownStopIndex = buildKnownStopIndex(knownStops);
  let tripCount = 0;
  let failureCount = 0;
  let processedPatterns = 0;
  const unmatchedPatterns: Array<{
    patternId: string;
    routeShortName: string;
    unmatchedStopNames: string[];
  }> = [];

  console.log(`[timetables-xlsx] processing ${patterns.length} route patterns`);

  for (const pattern of patterns) {
    if (!pattern.scheduleId) {
      continue;
    }

    let rows: RawScheduleCell[] = [];
    try {
      ({ rows } = await fetchScheduleTable(runtime, pattern.scheduleId));
    } catch (error) {
      failureCount += 1;
      unmatchedPatterns.push({
        patternId: pattern.id,
        routeShortName: pattern.route.shortName,
        unmatchedStopNames: [
          error instanceof Error
            ? `FETCH_FAILED:${normalizeText(error.message)}`
            : "FETCH_FAILED",
        ],
      });
      processedPatterns += 1;
      if (processedPatterns % 10 === 0 || processedPatterns === patterns.length) {
        console.log(
          `[timetables-xlsx] ${processedPatterns}/${patterns.length} patterns, trips=${tripCount}, failures=${failureCount}`,
        );
      }
      continue;
    }

    const table = parseScheduleTableRows(rows);

    if (table.stopNames.length === 0 || table.trips.length === 0) {
      failureCount += 1;
      unmatchedPatterns.push({
        patternId: pattern.id,
        routeShortName: pattern.route.shortName,
        unmatchedStopNames: ["EMPTY_TIMETABLE"],
      });
      processedPatterns += 1;
      if (processedPatterns % 10 === 0 || processedPatterns === patterns.length) {
        console.log(
          `[timetables-xlsx] ${processedPatterns}/${patterns.length} patterns, trips=${tripCount}, failures=${failureCount}`,
        );
      }
      continue;
    }

    const resolved = await resolveStopIds(
      runtime,
      pattern.route.shortName,
      table.stopNames,
      knownStopIndex,
    );

    if (
      resolved.unmatchedStopNames.length > 0 ||
      resolved.stopIds.length !== table.stopNames.length
    ) {
      failureCount += 1;
      unmatchedPatterns.push({
        patternId: pattern.id,
        routeShortName: pattern.route.shortName,
        unmatchedStopNames:
          resolved.unmatchedStopNames.length > 0
            ? resolved.unmatchedStopNames
            : ["INCOMPLETE_STOP_MATCH"],
      });
      processedPatterns += 1;
      if (processedPatterns % 10 === 0 || processedPatterns === patterns.length) {
        console.log(
          `[timetables-xlsx] ${processedPatterns}/${patterns.length} patterns, trips=${tripCount}, failures=${failureCount}`,
        );
      }
      continue;
    }

    await runtime.prisma.routePatternStop.createMany({
      data: resolved.stopIds.map((stopId, index) => ({
        routePatternId: pattern.id,
        stopId,
        sequence: index + 1,
        distanceFromStart: index * 1_000,
      })),
    });

    for (const row of table.trips) {
      const knownTimes = row.times.filter((item): item is string => Boolean(item));
      const startTime = knownTimes[0] ?? "00:00";

      const trip = await runtime.prisma.trip.create({
        data: {
          id: `${pattern.id}-trip-${row.rowLabel}`,
          routePatternId: pattern.id,
          serviceCalendarId: "svc-daily",
          headsign: pattern.directionLabel,
          startTime,
          rowLabel: row.rowLabel,
        },
      });

      await runtime.prisma.stopTime.createMany({
        data: row.times.map((time, index) => {
          const minutes = time
            ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
            : 0;
          return {
            tripId: trip.id,
            stopId: resolved.stopIds[index],
            sequence: index + 1,
            arrivalMinutes: minutes,
            departureMinutes: minutes,
            isEstimated: row.estimatedColumns.includes(index),
          };
        }),
      });
      tripCount += 1;
    }

    processedPatterns += 1;
    if (processedPatterns % 10 === 0 || processedPatterns === patterns.length) {
      console.log(
        `[timetables-xlsx] ${processedPatterns}/${patterns.length} patterns, trips=${tripCount}, failures=${failureCount}`,
      );
    }
  }

  return {
    processedCount: patterns.length,
    successCount: tripCount,
    failureCount,
    meta: {
      patterns: patterns.length,
      trips: tripCount,
      unmatchedPatterns,
    },
  };
}
