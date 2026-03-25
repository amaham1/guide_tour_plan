import { fetchPlainText } from "@/worker/core/fetch";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  parseRouteDetailHtml,
  parseRouteSearchHtml,
  parseScheduleTableRows,
  type ParsedScheduleVariant,
  type RouteDetail,
} from "@/worker/jobs/bus-jeju-parser";
import { normalizeText } from "@/worker/jobs/helpers";
import { buildRouteMatchKeys } from "@/worker/jobs/route-labels";
import {
  chooseBestPatternMatch,
  type MatchableRoutePattern,
} from "@/worker/jobs/schedule-pattern-matching";
import { fetchScheduleTable } from "@/worker/jobs/schedule-table";
import type { JobOutcome } from "@/worker/jobs/types";

const busTypes = [1, 2, 3, 4] as const;
const broadSpecialScheduleKeywords = [
  "\uC784\uC2DC",
  "\uC6B0\uB3C4",
  "\uC635\uC11C\uBC84\uC2A4",
  "\uAD00\uAD11\uC9C0\uC21C\uD658",
] as const;

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
  const haystacks = [item.label, item.shortName, detail.shortName]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  return haystacks.some((value) => {
    const compact = value.replace(/\s+/g, "");
    return (
      broadSpecialScheduleKeywords.some((keyword) => compact.includes(keyword)) ||
      /(?:^|[|(])\uB9C8\uC744(?:\uBC84\uC2A4)?(?:\)|$)/.test(compact)
    );
  });
}

async function deactivateScheduleSources(runtime: WorkerRuntime, scheduleId: string) {
  await runtime.prisma.routePatternScheduleSource.updateMany({
    where: {
      scheduleId,
    },
    data: {
      isActive: false,
    },
  });
}

function isUnstableVariantTable(table: { variants: Array<{ variantKey: string }> }) {
  return table.variants.length > 1 && table.variants.some((variant) => variant.variantKey === "default");
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
  const matchedVariants: Array<{
    scheduleId: string;
    variantKey: string;
    routePatternId: string;
    coverageRatio: number;
    score: number;
  }> = [];
  const unmatchedVariants: Array<{
    scheduleId: string;
    variantKey: string;
    shortName: string;
    stopCount: number;
    reason: string;
  }> = [];
  const skippedSpecialSchedules: Array<{
    scheduleId: string;
    shortName: string;
    reason: string;
  }> = [];

  for (const item of discovered.values()) {
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
        continue;
      }

      const { rows } = await fetchScheduleTable(runtime, item.scheduleId);
      const table = parseScheduleTableRows(rows);

      if (isUnstableVariantTable(table)) {
        await deactivateScheduleSources(runtime, item.scheduleId);
        skippedSpecialSchedules.push({
          scheduleId: item.scheduleId,
          shortName: detail.shortName || item.shortName,
          reason: "UNSTABLE_VARIANT_KEY",
        });
        continue;
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
      }> = [];

      for (const variant of table.variants) {
        const detailVariant = getDetailVariant(detail, variant.variantKey);
        const candidates = collectPatternCandidates(patternIndex, variant.variantKey, fallbackKeys);
        const match = chooseBestPatternMatch(
          {
            variantKey: variant.variantKey,
            stopNames: table.stopNames,
            terminalHint: detail.terminalHint,
            viaStops: detailVariant?.viaStops ?? [],
          },
          candidates,
        );

        if (!match) {
          unmatchedVariants.push({
            scheduleId: item.scheduleId,
            variantKey: variant.variantKey,
            shortName: detailVariant?.shortName ?? detail.shortName ?? item.shortName,
            stopCount: table.stopNames.length,
            reason: candidates.length === 0 ? "NO_PATTERN_CANDIDATES" : "NO_CONFIDENT_PATTERN_MATCH",
          });
          continue;
        }

        scheduleMatches.push({
          variant,
          routePatternId: match.patternId,
          coverageRatio: match.coverageRatio,
          score: match.score,
        });
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
      });
    }
  }

  return {
    processedCount: discovered.size,
    successCount: matchedVariants.length,
    failureCount: unmatchedVariants.length,
    meta: {
      busTypes,
      routeNumbers,
      discoveredSchedules: [...discovered.keys()],
      matchedVariants,
      unmatchedVariants,
      skippedSpecialSchedules,
    },
  };
}
