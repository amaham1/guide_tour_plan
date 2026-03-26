import { fetchPlainText } from "@/worker/core/fetch";
import { isExcludedTransitRoute } from "@/lib/transit-route-policy";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  parseRouteDetailHtml,
  parseRouteSearchHtml,
  parseScheduleTableRows,
  type ParsedScheduleTable,
  type ParsedScheduleTrip,
  type ParsedScheduleVariant,
  type RouteDetail,
} from "@/worker/jobs/bus-jeju-parser";
import { normalizeText } from "@/worker/jobs/helpers";
import { buildRouteMatchKeys } from "@/worker/jobs/route-labels";
import {
  AUTHORITATIVE_MATCH_MINIMUM_COVERAGE,
  AUTHORITATIVE_NEAR_COMPLETE_MIN_COVERAGE,
  AUTHORITATIVE_MINIMUM_STOP_SCORE,
  isAuthoritativeScheduleMatch,
} from "@/worker/jobs/schedule-authoritativeness";
import {
  chooseBestPatternMatch,
  matchStopNamesToPattern,
  type MatchableRoutePattern,
} from "@/worker/jobs/schedule-pattern-matching";
import { fetchScheduleTable } from "@/worker/jobs/schedule-table";
import type { JobOutcome } from "@/worker/jobs/types";

const busTypes = [1, 2, 3, 4] as const;
const ROUTES_HTML_CONCURRENCY = 12;
const MIN_PROFILE_STOP_COUNT = 3;
const MIN_PROFILE_STOP_RATIO = 0.4;

async function fetchRouteSearch(runtime: WorkerRuntime, routeNumber: string) {
  return fetchPlainText(`${runtime.env.busJejuBaseUrl}/mobile/schedule/listSchedule`, {
    keyword: routeNumber,
  });
}

async function fetchRouteCatalogPage(runtime: WorkerRuntime, busType: (typeof busTypes)[number]) {
  return fetchPlainText(`${runtime.env.busJejuBaseUrl}/mobile/schedule/listSchedule`, {
    busType,
  });
}

async function fetchRouteDetail(runtime: WorkerRuntime, scheduleId: string) {
  return fetchPlainText(
    `${runtime.env.busJejuBaseUrl}/mobile/schedule/detailSchedule?scheduleId=${scheduleId}`,
  );
}

function buildPatternIndex(
  patterns: Array<{
    id: string;
    displayName: string | null;
    directionLabel: string | null;
    route: { shortName: string };
    stops: Array<{
      sequence: number;
      stop: {
        id: string;
        displayName: string;
        translations: Array<{ displayName: string }>;
      };
    }>;
  }>,
) {
  const byShortName = new Map<string, MatchableRoutePattern[]>();

  for (const pattern of patterns) {
    const matchablePattern = {
      id: pattern.id,
      shortName: pattern.route.shortName,
      displayName: pattern.displayName,
      directionLabel: pattern.directionLabel,
      stops: pattern.stops.map((stop) => ({
        stopId: stop.stop.id,
        sequence: stop.sequence,
        displayName: stop.stop.displayName,
        translations: stop.stop.translations.map((translation) => translation.displayName),
      })),
    } satisfies MatchableRoutePattern;

    for (const key of buildRouteMatchKeys(pattern.route.shortName)) {
      const normalizedKey = normalizeText(key);
      const next = byShortName.get(normalizedKey) ?? [];
      if (!next.some((item) => item.id === matchablePattern.id)) {
        next.push(matchablePattern);
      }
      byShortName.set(normalizedKey, next);
    }
  }

  return byShortName;
}

function isSpecialSchedule(item: { label: string; shortName: string }, detail: RouteDetail) {
  return isExcludedTransitRoute([item.label, item.shortName, detail.shortName]);
}

async function deactivateScheduleSources(runtime: WorkerRuntime, scheduleId: string) {
  await runtime.prisma.trip.deleteMany({
    where: {
      scheduleSource: {
        is: {
          scheduleId,
        },
      },
    },
  });

  await runtime.prisma.routePatternScheduleSource.updateMany({
    where: {
      scheduleId,
    },
    data: {
      isActive: false,
    },
  });
}

function isUnstableVariantTable(table: ParsedScheduleTable) {
  return (
    table.hasVariantColumn &&
    table.concreteVariantRowCount > 0 &&
    table.unresolvedVariantRowCount > 0
  );
}

function getDetailVariant(detail: RouteDetail, variantKey: string) {
  return (
    detail.variants.find((variant) => variant.variantKey === variantKey) ??
    detail.variants.find((variant) => variant.variantKey === "default") ??
    detail.variants[0] ??
    null
  );
}

function collectPatternCandidates(
  patternIndex: Map<string, MatchableRoutePattern[]>,
  variantKey: string,
  fallbackKeys: string[],
) {
  const exactCandidates = new Map<string, MatchableRoutePattern>();
  if (variantKey !== "default") {
    for (const key of buildRouteMatchKeys(variantKey)) {
      for (const candidate of patternIndex.get(normalizeText(key)) ?? []) {
        exactCandidates.set(candidate.id, candidate);
      }
    }
  }

  if (exactCandidates.size > 0) {
    return [...exactCandidates.values()];
  }

  const fallbackCandidates = new Map<string, MatchableRoutePattern>();
  for (const key of fallbackKeys) {
    for (const candidate of patternIndex.get(normalizeText(key)) ?? []) {
      fallbackCandidates.set(candidate.id, candidate);
    }
  }

  return [...fallbackCandidates.values()];
}

function buildSourceLabel(baseLabel: string, variant: ParsedScheduleVariant) {
  if (variant.variantKey === "default") {
    return baseLabel;
  }

  return `${baseLabel} [${variant.rawVariantLabel}]`;
}

async function mapWithConcurrency<T, R>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;

      if (currentIndex >= values.length) {
        return;
      }

      results[currentIndex] = await mapper(values[currentIndex], currentIndex);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );

  return results;
}

function isAcceptedScheduleMatch(
  stopNames: string[],
  candidates: MatchableRoutePattern[],
  match: NonNullable<ReturnType<typeof chooseBestPatternMatch>>,
) {
  const matchedPattern = candidates.find((candidate) => candidate.id === match.patternId);
  if (!matchedPattern) {
    return false;
  }
  return isAuthoritativeScheduleMatch(stopNames, matchedPattern.stops.length, match);
}

type RoutesHtmlItemResult = {
  matchedVariants: Array<{
    scheduleId: string;
    variantKey: string;
    shortName: string;
    routePatternId: string;
    coverageRatio: number;
    score: number;
  }>;
  unmatchedVariants: Array<{
    scheduleId: string;
    variantKey: string;
    shortName: string;
    stopCount: number;
    reason: string;
    reasonSubtype: string;
    bestCandidate: {
      routePatternId: string;
      shortName: string;
      displayName: string | null;
      directionLabel: string | null;
      matchedStopCount: number;
      coverageRatio: number;
      score: number;
      unmatchedStopNames: string[];
      firstStopScore: number | null;
      lastStopScore: number | null;
    } | null;
    sampleStopNames: string[];
    tripCount: number;
  }>;
  skippedSpecialSchedules: Array<{
    scheduleId: string;
    shortName: string;
    reason: string;
  }>;
  resolvedMixedVariantSchedules: Array<{
    scheduleId: string;
    shortName: string;
    inheritedVariantRowCount: number;
  }>;
  unresolvedMixedVariantSchedules: Array<{
    scheduleId: string;
    shortName: string;
    inheritedVariantRowCount: number;
    unresolvedVariantRowCount: number;
  }>;
  inheritedVariantRowCount: number;
  unresolvedVariantRowCount: number;
};

type VariantStopProfile = {
  profileKey: string;
  columnIndexes: number[];
  stopNames: string[];
  tripCount: number;
};

type ScheduleNearMiss = {
  sampleStopNames: string[];
  tripCount: number;
  candidate: NonNullable<RoutesHtmlItemResult["unmatchedVariants"][number]["bestCandidate"]>;
};

type RoutesHtmlRejectionBreakdown = {
  reason: string;
  reasonSubtype: string;
  count: number;
};

function isUsableStopProfile(profile: VariantStopProfile, richestStopCount: number) {
  if (profile.stopNames.length < 2) {
    return false;
  }

  if (richestStopCount < MIN_PROFILE_STOP_COUNT) {
    return true;
  }

  return (
    profile.stopNames.length >= MIN_PROFILE_STOP_COUNT &&
    profile.stopNames.length / richestStopCount >= MIN_PROFILE_STOP_RATIO
  );
}

function buildVariantStopProfiles(stopNames: string[], trips: ParsedScheduleTrip[]) {
  const profiles = new Map<string, VariantStopProfile>();

  for (const trip of trips) {
    const columnIndexes = trip.times
      .map((value, index) => (value ? index : -1))
      .filter((index) => index >= 0);

    if (columnIndexes.length < 2) {
      continue;
    }

    const profileKey = columnIndexes.join(",");
    const current = profiles.get(profileKey);
    if (current) {
      current.tripCount += 1;
      continue;
    }

    profiles.set(profileKey, {
      profileKey,
      columnIndexes,
      stopNames: columnIndexes.map((index) => stopNames[index]),
      tripCount: 1,
    });
  }

  return [...profiles.values()].sort((left, right) => {
    if (left.tripCount !== right.tripCount) {
      return right.tripCount - left.tripCount;
    }

    return right.stopNames.length - left.stopNames.length;
  });
}

function compareNearMisses(left: ScheduleNearMiss, right: ScheduleNearMiss) {
  if (left.candidate.coverageRatio !== right.candidate.coverageRatio) {
    return right.candidate.coverageRatio - left.candidate.coverageRatio;
  }

  if (left.candidate.matchedStopCount !== right.candidate.matchedStopCount) {
    return right.candidate.matchedStopCount - left.candidate.matchedStopCount;
  }

  if (left.candidate.score !== right.candidate.score) {
    return right.candidate.score - left.candidate.score;
  }

  if (left.tripCount !== right.tripCount) {
    return right.tripCount - left.tripCount;
  }

  if ((left.candidate.firstStopScore ?? 0) !== (right.candidate.firstStopScore ?? 0)) {
    return (right.candidate.firstStopScore ?? 0) - (left.candidate.firstStopScore ?? 0);
  }

  if ((left.candidate.lastStopScore ?? 0) !== (right.candidate.lastStopScore ?? 0)) {
    return (right.candidate.lastStopScore ?? 0) - (left.candidate.lastStopScore ?? 0);
  }

  return left.candidate.routePatternId.localeCompare(right.candidate.routePatternId);
}

function findBestNearMiss(
  stopProfiles: VariantStopProfile[],
  candidates: MatchableRoutePattern[],
): ScheduleNearMiss | null {
  let best: ScheduleNearMiss | null = null;

  for (const stopProfile of stopProfiles) {
    for (const candidate of candidates) {
      const result = matchStopNamesToPattern(
        stopProfile.stopNames,
        candidate,
        AUTHORITATIVE_MINIMUM_STOP_SCORE,
      );

      if (result.matchedStops.length === 0) {
        continue;
      }

      const nearMiss = {
        sampleStopNames: stopProfile.stopNames,
        tripCount: stopProfile.tripCount,
        candidate: {
          routePatternId: candidate.id,
          shortName: candidate.shortName,
          displayName: candidate.displayName ?? null,
          directionLabel: candidate.directionLabel ?? null,
          matchedStopCount: result.matchedStops.length,
          coverageRatio: result.coverageRatio,
          score: result.score,
          unmatchedStopNames: result.unmatchedStopNames,
          firstStopScore: result.matchedStops[0]?.score ?? null,
          lastStopScore: result.matchedStops[result.matchedStops.length - 1]?.score ?? null,
        },
      } satisfies ScheduleNearMiss;

      if (!best || compareNearMisses(best, nearMiss) > 0) {
        best = nearMiss;
      }
    }
  }

  return best;
}

function classifyRejectionSubtype(
  reason: string,
  stopCount: number,
  bestCandidate: RoutesHtmlItemResult["unmatchedVariants"][number]["bestCandidate"],
) {
  if (reason === "NO_PATTERN_CANDIDATES" || !bestCandidate) {
    return "no_candidates";
  }

  const matchedStopCount = bestCandidate.matchedStopCount;
  const terminalScore = Math.min(
    bestCandidate.firstStopScore ?? 0,
    bestCandidate.lastStopScore ?? 0,
  );

  if (stopCount <= 2 || matchedStopCount <= 2) {
    return "sparse_profile";
  }

  if (
    bestCandidate.coverageRatio === 1 &&
    bestCandidate.unmatchedStopNames.length === 0 &&
    terminalScore >= AUTHORITATIVE_MINIMUM_STOP_SCORE &&
    terminalScore < 90
  ) {
    return "terminal_alias_gap";
  }

  if (bestCandidate.coverageRatio < AUTHORITATIVE_MATCH_MINIMUM_COVERAGE) {
    return "low_coverage";
  }

  return "authoritativeness_gap";
}

function summarizeRejectionBreakdown(
  items: Array<Pick<RoutesHtmlItemResult["unmatchedVariants"][number], "reason" | "reasonSubtype">>,
) {
  const summary = new Map<string, RoutesHtmlRejectionBreakdown>();

  for (const item of items) {
    const key = `${item.reason}::${item.reasonSubtype}`;
    const current = summary.get(key) ?? {
      reason: item.reason,
      reasonSubtype: item.reasonSubtype,
      count: 0,
    };
    current.count += 1;
    summary.set(key, current);
  }

  return [...summary.values()].sort(
    (left, right) =>
      right.count - left.count ||
      left.reason.localeCompare(right.reason) ||
      left.reasonSubtype.localeCompare(right.reasonSubtype),
  );
}

function summarizeRouteLabels(
  items: Array<{
    shortName: string;
    reason?: string;
  }>,
) {
  const summary = new Map<
    string,
    {
      shortName: string;
      count: number;
      reasons: Map<string, number>;
    }
  >();

  for (const item of items) {
    const key = normalizeText(item.shortName || "unknown") || "unknown";
    const next =
      summary.get(key) ??
      ({
        shortName: item.shortName || "unknown",
        count: 0,
        reasons: new Map<string, number>(),
      } satisfies {
        shortName: string;
        count: number;
        reasons: Map<string, number>;
      });

    next.count += 1;
    if (item.reason) {
      next.reasons.set(item.reason, (next.reasons.get(item.reason) ?? 0) + 1);
    }

    summary.set(key, next);
  }

  return [...summary.values()]
    .sort((left, right) => right.count - left.count || left.shortName.localeCompare(right.shortName))
    .map((item) => ({
      shortName: item.shortName,
      count: item.count,
      reasons: [...item.reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    }));
}

async function processDiscoveredSchedule(
  runtime: WorkerRuntime,
  item: { scheduleId: string; shortName: string; label: string },
  patternIndex: Map<string, MatchableRoutePattern[]>,
): Promise<RoutesHtmlItemResult> {
  const matchedVariants: RoutesHtmlItemResult["matchedVariants"] = [];
  const unmatchedVariants: RoutesHtmlItemResult["unmatchedVariants"] = [];
  const skippedSpecialSchedules: RoutesHtmlItemResult["skippedSpecialSchedules"] = [];
  const resolvedMixedVariantSchedules: RoutesHtmlItemResult["resolvedMixedVariantSchedules"] = [];
  const unresolvedMixedVariantSchedules: RoutesHtmlItemResult["unresolvedMixedVariantSchedules"] = [];
  let inheritedVariantRowCount = 0;
  let unresolvedVariantRowCount = 0;

  try {
    const detailHtml = await fetchRouteDetail(runtime, item.scheduleId);
    const detail = parseRouteDetailHtml(detailHtml, item.scheduleId);

    if (isSpecialSchedule(item, detail)) {
      await deactivateScheduleSources(runtime, item.scheduleId);
      skippedSpecialSchedules.push({
        scheduleId: item.scheduleId,
        shortName: detail.shortName || item.shortName,
        reason: "SPECIAL_ROUTE_EXCLUDED",
      });

      return {
        matchedVariants,
        unmatchedVariants,
        skippedSpecialSchedules,
        resolvedMixedVariantSchedules,
        unresolvedMixedVariantSchedules,
        inheritedVariantRowCount,
        unresolvedVariantRowCount,
      };
    }

    const { rows } = await fetchScheduleTable(runtime, item.scheduleId);
    const table = parseScheduleTableRows(rows);
    inheritedVariantRowCount = table.inheritedVariantRowCount;
    unresolvedVariantRowCount = table.unresolvedVariantRowCount;

    if (table.hasVariantColumn) {
      if (table.unresolvedVariantRowCount > 0) {
        unresolvedMixedVariantSchedules.push({
          scheduleId: item.scheduleId,
          shortName: detail.shortName || item.shortName,
          inheritedVariantRowCount: table.inheritedVariantRowCount,
          unresolvedVariantRowCount: table.unresolvedVariantRowCount,
        });
      } else if (table.inheritedVariantRowCount > 0) {
        resolvedMixedVariantSchedules.push({
          scheduleId: item.scheduleId,
          shortName: detail.shortName || item.shortName,
          inheritedVariantRowCount: table.inheritedVariantRowCount,
        });
      }
    }

    if (isUnstableVariantTable(table)) {
      await deactivateScheduleSources(runtime, item.scheduleId);
      skippedSpecialSchedules.push({
        scheduleId: item.scheduleId,
        shortName: detail.shortName || item.shortName,
        reason: "UNSTABLE_VARIANT_KEY",
      });

      return {
        matchedVariants,
        unmatchedVariants,
        skippedSpecialSchedules,
        resolvedMixedVariantSchedules,
        unresolvedMixedVariantSchedules,
        inheritedVariantRowCount,
        unresolvedVariantRowCount,
      };
    }

    const fallbackKeys = [
      ...new Set([
        ...buildRouteMatchKeys(detail.shortName || item.shortName),
        ...buildRouteMatchKeys(item.shortName),
        ...buildRouteMatchKeys(item.label),
      ]),
    ];

    const scheduleMatches: Array<{
      variant: ParsedScheduleVariant;
      routePatternId: string;
      coverageRatio: number;
      score: number;
      tripCount: number;
      stopCount: number;
    }> = [];

    for (const variant of table.variants) {
      const detailVariant = getDetailVariant(detail, variant.variantKey);
      const candidates = collectPatternCandidates(patternIndex, variant.variantKey, fallbackKeys);
      const stopProfiles = buildVariantStopProfiles(table.stopNames, variant.trips);
      const richestStopCount = stopProfiles[0]?.stopNames.length ?? 0;
      const matchedPatterns = new Map<
        string,
        {
          routePatternId: string;
          coverageRatio: number;
          score: number;
          tripCount: number;
          stopCount: number;
        }
      >();

      for (const stopProfile of stopProfiles) {
        if (!isUsableStopProfile(stopProfile, richestStopCount)) {
          continue;
        }

        const match = chooseBestPatternMatch(
          {
            variantKey: variant.variantKey,
            stopNames: stopProfile.stopNames,
            terminalHint: detail.terminalHint,
            viaStops: detailVariant?.viaStops ?? [],
            minimumCoverage: AUTHORITATIVE_MATCH_MINIMUM_COVERAGE,
            minimumStopScore: AUTHORITATIVE_MINIMUM_STOP_SCORE,
          },
          candidates,
        );

        if (!match || !isAcceptedScheduleMatch(stopProfile.stopNames, candidates, match)) {
          continue;
        }

        const existing = matchedPatterns.get(match.patternId);
        if (
          !existing ||
          stopProfile.tripCount > existing.tripCount ||
          (stopProfile.tripCount === existing.tripCount &&
            stopProfile.stopNames.length > existing.stopCount) ||
          (stopProfile.tripCount === existing.tripCount &&
            stopProfile.stopNames.length === existing.stopCount &&
            match.score > existing.score)
        ) {
          matchedPatterns.set(match.patternId, {
            routePatternId: match.patternId,
            coverageRatio: match.coverageRatio,
            score: match.score,
            tripCount: stopProfile.tripCount,
            stopCount: stopProfile.stopNames.length,
          });
        }
      }

      if (matchedPatterns.size === 0) {
        const bestNearMiss = findBestNearMiss(stopProfiles, candidates);
        const stopCount = Math.max(...stopProfiles.map((profile) => profile.stopNames.length), 0);
        const reason =
          candidates.length === 0
            ? "NO_PATTERN_CANDIDATES"
            : "NON_AUTHORITATIVE_PATTERN_MATCH";
        unmatchedVariants.push({
          scheduleId: item.scheduleId,
          variantKey: variant.variantKey,
          shortName: detailVariant?.shortName ?? detail.shortName ?? item.shortName,
          stopCount,
          reason,
          reasonSubtype: classifyRejectionSubtype(reason, stopCount, bestNearMiss?.candidate ?? null),
          bestCandidate: bestNearMiss?.candidate ?? null,
          sampleStopNames: bestNearMiss?.sampleStopNames ?? [],
          tripCount: bestNearMiss?.tripCount ?? 0,
        });
        continue;
      }

      scheduleMatches.push(
        ...[...matchedPatterns.values()].map((matchedPattern) => ({
          variant,
          routePatternId: matchedPattern.routePatternId,
          coverageRatio: matchedPattern.coverageRatio,
          score: matchedPattern.score,
          tripCount: matchedPattern.tripCount,
          stopCount: matchedPattern.stopCount,
        })),
      );
    }

    await deactivateScheduleSources(runtime, item.scheduleId);

    for (const scheduleMatch of scheduleMatches) {
      const detailVariant = getDetailVariant(detail, scheduleMatch.variant.variantKey);
      await runtime.prisma.routePatternScheduleSource.upsert({
        where: {
          scheduleId_variantKey_routePatternId: {
            scheduleId: item.scheduleId,
            variantKey: scheduleMatch.variant.variantKey,
            routePatternId: scheduleMatch.routePatternId,
          },
        },
        update: {
          sourceLabel: buildSourceLabel(item.label || detail.displayName, scheduleMatch.variant),
          effectiveDate: detail.effectiveDate,
          isActive: true,
        },
        create: {
          scheduleId: item.scheduleId,
          variantKey: scheduleMatch.variant.variantKey,
          routePatternId: scheduleMatch.routePatternId,
          sourceLabel: buildSourceLabel(item.label || detail.displayName, scheduleMatch.variant),
          effectiveDate: detail.effectiveDate,
          isActive: true,
        },
      });

      await runtime.prisma.routePattern.update({
        where: {
          id: scheduleMatch.routePatternId,
        },
        data: {
          scheduleId: item.scheduleId,
          busType: detail.busType,
          directionLabel: detail.waypointText ?? detail.directionLabel,
          displayName: detail.waypointText
            ? `${detailVariant?.shortName ?? detail.shortName} ${detail.waypointText}`
            : detailVariant?.shortName ?? detail.shortName,
          viaText: detailVariant?.viaText ?? detail.viaText,
          waypointText: detail.waypointText,
          serviceNote: detailVariant?.serviceNote ?? detail.serviceNote,
          effectiveDate: detail.effectiveDate,
        },
      });

      matchedVariants.push({
        scheduleId: item.scheduleId,
        variantKey: scheduleMatch.variant.variantKey,
        shortName: detailVariant?.shortName ?? detail.shortName ?? item.shortName,
        routePatternId: scheduleMatch.routePatternId,
        coverageRatio: scheduleMatch.coverageRatio,
        score: scheduleMatch.score,
      });
    }
  } catch (error) {
    unmatchedVariants.push({
      scheduleId: item.scheduleId,
      variantKey: "default",
      shortName: item.shortName,
      stopCount: 0,
      reason: error instanceof Error ? error.message : "UNKNOWN_ERROR",
      reasonSubtype: "processing_error",
      bestCandidate: null,
      sampleStopNames: [],
      tripCount: 0,
    });
  }

  return {
    matchedVariants,
    unmatchedVariants,
    skippedSpecialSchedules,
    resolvedMixedVariantSchedules,
    unresolvedMixedVariantSchedules,
    inheritedVariantRowCount,
    unresolvedVariantRowCount,
  };
}

export async function runRoutesHtmlJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const routeNumbers = runtime.env.routeSearchTerms;
  const discovered = new Map<string, { scheduleId: string; shortName: string; label: string }>();

  for (const busType of busTypes) {
    const html = await fetchRouteCatalogPage(runtime, busType);
    for (const item of parseRouteSearchHtml(html)) {
      discovered.set(item.scheduleId, item);
    }
  }

  for (const routeNumber of routeNumbers) {
    const html = await fetchRouteSearch(runtime, routeNumber);
    for (const item of parseRouteSearchHtml(html)) {
      discovered.set(item.scheduleId, item);
    }
  }

  const patterns = await runtime.prisma.routePattern.findMany({
    where: {
      isActive: true,
      route: {
        isActive: true,
      },
    },
    include: {
      route: true,
      stops: {
        orderBy: {
          sequence: "asc",
        },
        include: {
          stop: {
            include: {
              translations: true,
            },
          },
        },
      },
    },
  });

  const patternIndex = buildPatternIndex(patterns);
  const processedSchedules = await mapWithConcurrency(
    [...discovered.values()],
    ROUTES_HTML_CONCURRENCY,
    async (item) => processDiscoveredSchedule(runtime, item, patternIndex),
  );

  const matchedVariants = processedSchedules.flatMap((item) => item.matchedVariants);
  const unmatchedVariants = processedSchedules.flatMap((item) => item.unmatchedVariants);
  const skippedSpecialSchedules = processedSchedules.flatMap(
    (item) => item.skippedSpecialSchedules,
  );
  const resolvedMixedVariantSchedules = processedSchedules.flatMap(
    (item) => item.resolvedMixedVariantSchedules,
  );
  const unresolvedMixedVariantSchedules = processedSchedules.flatMap(
    (item) => item.unresolvedMixedVariantSchedules,
  );
  const inheritedVariantRowCount = processedSchedules.reduce(
    (sum, item) => sum + item.inheritedVariantRowCount,
    0,
  );
  const unresolvedVariantRowCount = processedSchedules.reduce(
    (sum, item) => sum + item.unresolvedVariantRowCount,
    0,
  );
  const nearMisses = unmatchedVariants
    .filter(
      (
        item,
      ): item is RoutesHtmlItemResult["unmatchedVariants"][number] & {
        bestCandidate: NonNullable<RoutesHtmlItemResult["unmatchedVariants"][number]["bestCandidate"]>;
      } => Boolean(item.bestCandidate),
    )
    .sort((left, right) =>
      compareNearMisses(
        {
          sampleStopNames: left.sampleStopNames,
          tripCount: left.tripCount,
          candidate: left.bestCandidate,
        },
        {
          sampleStopNames: right.sampleStopNames,
          tripCount: right.tripCount,
          candidate: right.bestCandidate,
        },
      ),
    )
    .slice(0, 40);

  return {
    processedCount: discovered.size,
    successCount: matchedVariants.length,
    failureCount: unmatchedVariants.length,
    meta: {
      busTypes,
      routeNumbers,
      discoveredSchedules: [...discovered.keys()],
      matchedVariants,
      matchedRouteLabels: summarizeRouteLabels(matchedVariants),
      unmatchedVariants,
      unmatchedRouteLabels: summarizeRouteLabels(unmatchedVariants),
      rejectionBreakdown: summarizeRejectionBreakdown(unmatchedVariants),
      nearMisses,
      skippedSpecialSchedules,
      skippedRouteLabels: summarizeRouteLabels(skippedSpecialSchedules),
      resolvedMixedVariantSchedules,
      unresolvedMixedVariantSchedules,
      inheritedVariantRowCount,
      unresolvedVariantRowCount,
    },
  };
}
