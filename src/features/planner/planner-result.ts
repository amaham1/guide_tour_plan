import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { InvalidRequestError, ResourceNotFoundError } from "@/lib/errors";
import { assertPlannerCatalogReady } from "@/features/planner/catalog";
import { buildPlannerCandidates } from "@/features/planner/engine";
import { buildOpeningHoursWarnings } from "@/features/planner/opening-hours";
import { loadPlannerGraph } from "@/features/planner/graph-loader";
import {
  buildPlaceDedupKey,
  buildPlanQueryPlaceId,
  pickPlaceName,
  resolvePlannerAnchors,
} from "@/features/planner/anchors";
import {
  nextHigherTimeReliabilityMode,
  nextSuggestedModeFromStatus,
  plannerFallbackMessageForStatus,
  statusFromNextSuggestedMode,
} from "@/features/planner/reliability-policy";
import {
  isTimeReliabilityMode,
  toPlannerCandidateDto,
} from "@/features/planner/serialization";
import {
  planRequestSchema,
  type CandidateWarning,
  type PlannerResultDto,
  type TimeReliabilityMode,
} from "@/features/planner/types";

function mergeWarnings(...sets: CandidateWarning[][]) {
  const deduped = new Map<string, CandidateWarning>();

  for (const warning of sets.flat()) {
    deduped.set(`${warning.code}:${warning.message}`, warning);
  }

  return [...deduped.values()];
}

export async function createPlannerResult(rawInput: unknown): Promise<PlannerResultDto> {
  const input = planRequestSchema.parse(rawInput);
  await assertPlannerCatalogReady(db);

  const uniquePlaces = new Set(input.places.map(buildPlaceDedupKey));
  if (uniquePlaces.size !== input.places.length) {
    throw new InvalidRequestError("같은 장소를 중복해서 선택할 수는 없습니다.");
  }

  const { anchors, buildEngineInput } = await resolvePlannerAnchors(
    db,
    input.language,
    input.places,
  );

  const planQuery = await db.planQuery.create({
    data: {
      language: input.language,
      startAt: new Date(input.startAt),
      includeGeneratedTimes: input.includeGeneratedTimes,
      timeReliabilityMode: input.timeReliabilityMode,
      preference: input.preference,
      status: "READY",
      places: {
        create: anchors.map((anchor, index) => ({
          placeId: anchor.storedPlaceId,
          externalProvider: anchor.externalProvider,
          externalRef: anchor.externalRef,
          externalDisplayName: anchor.displayName,
          externalRegionName: anchor.regionName,
          externalCategoryLabel: anchor.externalCategoryLabel,
          externalLatitude: anchor.latitude,
          externalLongitude: anchor.longitude,
          dwellMinutes: anchor.dwellMinutes,
          sequence: index + 1,
        })),
      },
    },
  });

  const runCandidatesForMode = async (mode: TimeReliabilityMode) => {
    const graph = await loadPlannerGraph(db, anchors, mode);
    const engineInput = buildEngineInput(
      input.startAt,
      mode,
      mode !== "OFFICIAL_ONLY",
    );

    return {
      graph,
      candidates: buildPlannerCandidates(planQuery.id, engineInput, graph),
    };
  };

  const initialMode =
    input.timeReliabilityMode === "ALLOW_ROUGH"
      ? "INCLUDE_ESTIMATED"
      : input.timeReliabilityMode;
  let { graph, candidates } = await runCandidatesForMode(initialMode);
  let nextSuggestedTimeReliabilityMode: TimeReliabilityMode | null = null;

  if (candidates.length === 0 && input.timeReliabilityMode === "ALLOW_ROUGH") {
    const rerun = await runCandidatesForMode("ALLOW_ROUGH");
    graph = rerun.graph;
    candidates = rerun.candidates;
  }

  for (const candidate of candidates) {
    const openingWarnings = buildOpeningHoursWarnings(graph.places, candidate.legs);
    const warnings = mergeWarnings(candidate.warnings, openingWarnings);

    await db.planCandidate.create({
      data: {
        planQueryId: planQuery.id,
        kind: candidate.kind,
        score: candidate.score,
        summary: candidate.summary as Prisma.InputJsonValue,
        legs: candidate.legs as Prisma.InputJsonValue,
        warnings: warnings as Prisma.InputJsonValue,
      },
    });
  }

  if (candidates.length === 0) {
    const nextMode = nextHigherTimeReliabilityMode(input.timeReliabilityMode);
    if (nextMode) {
      const preview = await runCandidatesForMode(nextMode);
      if (preview.candidates.length > 0) {
        nextSuggestedTimeReliabilityMode = nextMode;
      } else {
        const fallbackMode = nextHigherTimeReliabilityMode(nextMode);
        if (fallbackMode) {
          const fallbackPreview = await runCandidatesForMode(fallbackMode);
          if (fallbackPreview.candidates.length > 0) {
            nextSuggestedTimeReliabilityMode = fallbackMode;
          }
        }
      }
    }
  }

  await db.planQuery.update({
    where: { id: planQuery.id },
    data: {
      status:
        candidates.length > 0
          ? "COMPUTED"
          : statusFromNextSuggestedMode(nextSuggestedTimeReliabilityMode),
    },
  });

  return getPlannerResult(planQuery.id);
}

export async function getPlannerResult(planId: string): Promise<PlannerResultDto> {
  const planQuery = await db.planQuery.findUnique({
    where: { id: planId },
    include: {
      places: {
        orderBy: {
          sequence: "asc",
        },
        include: {
          place: {
            include: {
              locales: true,
            },
          },
        },
      },
      candidates: {
        orderBy: {
          createdAt: "asc",
        },
      },
    },
  });

  if (!planQuery) {
    throw new ResourceNotFoundError("플랜을 찾지 못했습니다.");
  }

  const timeReliabilityMode = isTimeReliabilityMode(planQuery.timeReliabilityMode)
    ? planQuery.timeReliabilityMode
    : planQuery.includeGeneratedTimes
      ? "INCLUDE_ESTIMATED"
      : "OFFICIAL_ONLY";
  const nextSuggestedTimeReliabilityMode = nextSuggestedModeFromStatus(planQuery.status);

  return {
    planId: planQuery.id,
    startAt: planQuery.startAt.toISOString(),
    includeGeneratedTimes: planQuery.includeGeneratedTimes,
    timeReliabilityMode,
    nextSuggestedTimeReliabilityMode,
    preference: planQuery.preference ?? undefined,
    places: planQuery.places.map((place) => ({
      placeId: buildPlanQueryPlaceId(place),
      displayName: place.place
        ? pickPlaceName(place.place, planQuery.language)
        : (place.externalDisplayName ?? "장소"),
      dwellMinutes: place.dwellMinutes,
    })),
    candidates: planQuery.candidates.map(toPlannerCandidateDto),
    fallbackMessage:
      planQuery.candidates.length === 0
        ? plannerFallbackMessageForStatus({
            timeReliabilityMode,
            nextSuggestedTimeReliabilityMode,
          })
        : undefined,
  };
}
