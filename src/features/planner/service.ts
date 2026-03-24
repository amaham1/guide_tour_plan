import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { appEnv } from "@/lib/env";
import { InvalidRequestError, ResourceNotFoundError } from "@/lib/errors";
import {
  estimateWalkFromDistance,
  getWalkRoute,
  haversineMeters,
} from "@/lib/osrm";
import { assertPlannerCatalogReady } from "@/features/planner/catalog";
import {
  buildPlannerCandidates,
  type PlannerGraphContext,
} from "@/features/planner/engine";
import { buildOpeningHoursWarnings } from "@/features/planner/opening-hours";
import { searchKakaoPlaces } from "@/features/planner/place-search";
import { buildExecutionStatus } from "@/features/planner/realtime";
import {
  estimateDelayMinutesFromGnss,
  fetchLatestGnssPosition,
} from "@/features/planner/realtime-source";
import {
  createSessionSchema,
  planRequestSchema,
  searchRequestSchema,
  type CandidateLeg,
  type CandidateSummary,
  type CandidateWarning,
  type ExecutionStatusDto,
  type PlannerCandidateDto,
  type PlannerEngineInput,
  type PlannerPlaceInput,
  type PlannerResultDto,
  type PlannerStoredPlaceInput,
  type SearchResultDto,
} from "@/features/planner/types";

type PlannerAnchor = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
  openingHoursRaw: string | null;
  openingHoursJson: Prisma.JsonValue | null;
  dwellMinutes: number;
  storedPlaceId: string | null;
  externalProvider: string | null;
  externalRef: string | null;
  externalCategoryLabel: string | null;
};

type DynamicStopLink = {
  stopId: string;
  durationMinutes: number;
  distanceMeters: number;
};

const PLACE_STOP_PREFILTER_LIMIT = 12;
const PLACE_STOP_LIMIT = 5;
const MAX_NEARBY_STOP_DISTANCE_METERS = 1_800;

function pickPlaceName(
  place: {
    baseDisplayName: string;
    locales: Array<{
      language: string;
      displayName: string;
    }>;
  },
  language: string,
) {
  return (
    place.locales.find((locale) => locale.language === language)?.displayName ??
    place.locales.find((locale) => locale.language === "ko")?.displayName ??
    place.baseDisplayName
  );
}

function parseJson<T>(value: Prisma.JsonValue): T {
  return value as T;
}

function plannerFallbackMessage() {
  return "선택한 순서대로 오늘 연결 가능한 버스를 찾지 못했습니다. 시작 시각이나 장소 순서를 바꿔 다시 시도해 주세요.";
}

function mergeWarnings(...sets: CandidateWarning[][]) {
  const deduped = new Map<string, CandidateWarning>();

  for (const warning of sets.flat()) {
    deduped.set(`${warning.code}:${warning.message}`, warning);
  }

  return [...deduped.values()];
}

function toPlannerCandidateDto(candidate: {
  id: string;
  kind: "FASTEST" | "LEAST_WALK" | "LEAST_TRANSFER";
  score: number;
  summary: Prisma.JsonValue;
  legs: Prisma.JsonValue;
  warnings: Prisma.JsonValue | null;
}): PlannerCandidateDto {
  return {
    id: candidate.id,
    kind: candidate.kind,
    score: candidate.score,
    summary: parseJson<CandidateSummary>(candidate.summary),
    legs: parseJson<CandidateLeg[]>(candidate.legs),
    warnings: candidate.warnings
      ? parseJson<CandidateWarning[]>(candidate.warnings)
      : [],
  };
}

function isStoredPlaceInput(
  place: PlannerPlaceInput,
): place is PlannerStoredPlaceInput {
  return place.mode === "stored";
}

function buildPlaceDedupKey(place: PlannerPlaceInput) {
  if (isStoredPlaceInput(place)) {
    return `stored:${place.placeId}`;
  }

  if (place.externalId) {
    return `external:${place.provider}:${place.externalId}`;
  }

  return `external:${place.provider}:${place.displayName.toLowerCase()}:${place.latitude.toFixed(5)}:${place.longitude.toFixed(5)}`;
}

function buildPlanQueryPlaceId(
  place: {
    placeId: string | null;
    sequence: number;
    externalProvider: string | null;
    externalRef: string | null;
  },
) {
  if (place.placeId) {
    return place.placeId;
  }

  return `${place.externalProvider ?? "external"}:${place.externalRef ?? place.sequence}`;
}

async function searchStoredPlaces(
  query: string,
  limit: number,
): Promise<SearchResultDto[]> {
  const places = await db.place.findMany({
    where: {
      AND: [
        {
          sourceContentId: {
            not: null,
          },
        },
        {
          OR: [
            { baseDisplayName: { contains: query } },
            { locales: { some: { displayName: { contains: query } } } },
          ],
        },
      ],
    },
    include: {
      locales: true,
    },
    orderBy: {
      baseDisplayName: "asc",
    },
    take: limit,
  });

  return places.map<SearchResultDto>((place) => {
    const koLocale = place.locales.find((locale) => locale.language === "ko");

    return {
      id: place.id,
      kind: "place",
      displayName: koLocale?.displayName ?? place.baseDisplayName,
      categoryLabel: koLocale?.categoryLabel ?? place.category,
      regionName: place.regionName,
      latitude: place.latitude,
      longitude: place.longitude,
      meta: {
        mode: "stored",
        placeId: place.id,
        slug: place.slug,
        category: place.category,
      },
    };
  });
}

function rankCandidateStops(
  anchor: PlannerAnchor,
  stops: PlannerGraphContext["stops"],
) {
  const stopEntries = [...stops.values()]
    .filter((stop) => stop.latitude !== 0 && stop.longitude !== 0)
    .map((stop) => ({
      stop,
      crowDistanceMeters: haversineMeters(anchor, stop),
    }))
    .sort((left, right) => left.crowDistanceMeters - right.crowDistanceMeters);

  const withinRadius = stopEntries.filter(
    (entry) => entry.crowDistanceMeters <= MAX_NEARBY_STOP_DISTANCE_METERS,
  );

  return (withinRadius.length > 0 ? withinRadius : stopEntries).slice(
    0,
    PLACE_STOP_PREFILTER_LIMIT,
  );
}

async function measurePlaceStopLinks(
  anchor: PlannerAnchor,
  stops: PlannerGraphContext["stops"],
): Promise<DynamicStopLink[]> {
  const candidates = rankCandidateStops(anchor, stops);

  const measured = await Promise.all(
    candidates.map(async ({ stop, crowDistanceMeters }) => {
      try {
        const route = await getWalkRoute(
          appEnv.osrmBaseUrl,
          {
            latitude: anchor.latitude,
            longitude: anchor.longitude,
          },
          {
            latitude: stop.latitude,
            longitude: stop.longitude,
          },
        );

        return {
          stopId: stop.id,
          durationMinutes: route.durationMinutes,
          distanceMeters: route.distanceMeters,
        };
      } catch {
        return {
          stopId: stop.id,
          durationMinutes: estimateWalkFromDistance(crowDistanceMeters),
          distanceMeters: crowDistanceMeters,
        };
      }
    }),
  );

  return measured
    .sort((left, right) => {
      if (left.durationMinutes !== right.durationMinutes) {
        return left.durationMinutes - right.durationMinutes;
      }

      return left.distanceMeters - right.distanceMeters;
    })
    .slice(0, PLACE_STOP_LIMIT);
}

async function buildDynamicPlaceLinks(
  anchors: PlannerAnchor[],
  stops: PlannerGraphContext["stops"],
) {
  const accessLinksByPlace: PlannerGraphContext["accessLinksByPlace"] = new Map();
  const egressLinksByPlace: PlannerGraphContext["egressLinksByPlace"] = new Map();

  for (const anchor of anchors) {
    const measuredLinks = await measurePlaceStopLinks(anchor, stops);

    accessLinksByPlace.set(
      anchor.id,
      measuredLinks.map((link, index) => ({
        kind: "PLACE_STOP",
        fromPlaceId: anchor.id,
        toPlaceId: null,
        fromStopId: null,
        toStopId: link.stopId,
        durationMinutes: link.durationMinutes,
        distanceMeters: link.distanceMeters,
        rank: index + 1,
      })),
    );

    egressLinksByPlace.set(
      anchor.id,
      measuredLinks.map((link, index) => ({
        kind: "STOP_PLACE",
        fromPlaceId: null,
        toPlaceId: anchor.id,
        fromStopId: link.stopId,
        toStopId: null,
        durationMinutes: link.durationMinutes,
        distanceMeters: link.distanceMeters,
        rank: index + 1,
      })),
    );
  }

  return {
    accessLinksByPlace,
    egressLinksByPlace,
  };
}

async function loadPlannerGraph(
  prisma: PrismaClient,
  anchors: PlannerAnchor[],
): Promise<PlannerGraphContext> {
  const [stops, stopTransfers, patterns] = await Promise.all([
    prisma.stop.findMany({
      where: {
        routePatternStops: {
          some: {
            routePattern: {
              scheduleId: {
                not: null,
              },
            },
          },
        },
      },
    }),
    prisma.walkLink.findMany({
      where: {
        kind: "STOP_STOP",
      },
    }),
    prisma.routePattern.findMany({
      where: {
        scheduleId: {
          not: null,
        },
      },
      include: {
        route: true,
        vehicleDeviceMap: true,
        trips: {
          include: {
            stopTimes: {
              orderBy: {
                sequence: "asc",
              },
              include: {
                stop: true,
              },
            },
          },
        },
      },
    }),
  ]);

  const placeMap: PlannerGraphContext["places"] = new Map(
    anchors.map((anchor) => [
      anchor.id,
      {
        id: anchor.id,
        displayName: anchor.displayName,
        regionName: anchor.regionName,
        latitude: anchor.latitude,
        longitude: anchor.longitude,
        openingHoursRaw: anchor.openingHoursRaw,
        openingHoursJson: anchor.openingHoursJson,
      },
    ]),
  );

  const stopMap: PlannerGraphContext["stops"] = new Map(
    stops.map((stop) => [
      stop.id,
      {
        id: stop.id,
        displayName: stop.displayName,
        latitude: stop.latitude,
        longitude: stop.longitude,
      },
    ]),
  );

  const { accessLinksByPlace, egressLinksByPlace } = await buildDynamicPlaceLinks(
    anchors,
    stopMap,
  );

  const stopTransfersByOrigin: PlannerGraphContext["stopTransfersByOrigin"] =
    new Map();
  const validStopIds = new Set(stopMap.keys());

  for (const link of stopTransfers) {
    if (
      !link.fromStopId ||
      !link.toStopId ||
      !validStopIds.has(link.fromStopId) ||
      !validStopIds.has(link.toStopId)
    ) {
      continue;
    }

    const next = stopTransfersByOrigin.get(link.fromStopId) ?? [];
    next.push({
      kind: "STOP_STOP",
      fromPlaceId: null,
      toPlaceId: null,
      fromStopId: link.fromStopId,
      toStopId: link.toStopId,
      durationMinutes: link.durationMinutes,
      distanceMeters: link.distanceMeters,
      rank: link.rank,
    });
    stopTransfersByOrigin.set(link.fromStopId, next);
  }

  const realtimePatternIds = new Set<string>();
  const trips = patterns.flatMap((pattern) => {
    if (pattern.vehicleDeviceMap) {
      realtimePatternIds.add(pattern.id);
    }

    return pattern.trips.map((trip) => {
      const normalizedStopTimes = trip.stopTimes.map((stopTime) => ({
        stopId: stopTime.stopId,
        stopName: stopTime.stop.displayName,
        sequence: stopTime.sequence,
        arrivalMinutes: stopTime.arrivalMinutes,
        departureMinutes: stopTime.departureMinutes,
        isEstimated: stopTime.isEstimated,
      }));

      return {
        id: trip.id,
        routePatternId: pattern.id,
        routeShortName: pattern.route.shortName,
        routeDisplayName: pattern.route.displayName,
        headsign: trip.headsign,
        stopTimes: normalizedStopTimes,
        stopTimeByStopId: new Map(
          normalizedStopTimes.map((stopTime) => [stopTime.stopId, stopTime]),
        ),
      };
    });
  });

  return {
    places: placeMap,
    stops: stopMap,
    accessLinksByPlace,
    egressLinksByPlace,
    stopTransfersByOrigin,
    trips,
    realtimePatternIds,
  } satisfies PlannerGraphContext;
}

async function resolvePlannerAnchors(
  prisma: PrismaClient,
  language: string,
  places: PlannerPlaceInput[],
) {
  const storedPlaceIds = places
    .filter(isStoredPlaceInput)
    .map((place) => place.placeId);

  const storedPlaces = storedPlaceIds.length
    ? await prisma.place.findMany({
        where: {
          AND: [
            {
              id: {
                in: storedPlaceIds,
              },
            },
            {
              sourceContentId: {
                not: null,
              },
            },
          ],
        },
        include: {
          locales: true,
        },
      })
    : [];

  const storedPlaceMap = new Map(storedPlaces.map((place) => [place.id, place]));

  if (storedPlaceMap.size !== new Set(storedPlaceIds).size) {
    throw new ResourceNotFoundError("일부 장소를 찾지 못했습니다.");
  }

  const anchors: PlannerAnchor[] = places.map((place, index) => {
    if (isStoredPlaceInput(place)) {
      const storedPlace = storedPlaceMap.get(place.placeId);
      if (!storedPlace) {
        throw new ResourceNotFoundError("일부 장소를 찾지 못했습니다.");
      }

      return {
        id: storedPlace.id,
        displayName: pickPlaceName(storedPlace, language),
        regionName: storedPlace.regionName,
        latitude: storedPlace.latitude,
        longitude: storedPlace.longitude,
        openingHoursRaw: storedPlace.openingHoursRaw,
        openingHoursJson: storedPlace.openingHoursJson,
        dwellMinutes: place.dwellMinutes,
        storedPlaceId: storedPlace.id,
        externalProvider: null,
        externalRef: null,
        externalCategoryLabel: null,
      };
    }

    return {
      id: `external:${index + 1}`,
      displayName: place.displayName,
      regionName: place.regionName,
      latitude: place.latitude,
      longitude: place.longitude,
      openingHoursRaw: null,
      openingHoursJson: null,
      dwellMinutes: place.dwellMinutes,
      storedPlaceId: null,
      externalProvider: place.provider,
      externalRef: place.externalId ?? null,
      externalCategoryLabel: place.categoryLabel,
    };
  });

  return {
    anchors,
    buildEngineInput(startAt: string) {
      return {
        startAt,
        places: anchors.map((anchor) => ({
          placeId: anchor.id,
          dwellMinutes: anchor.dwellMinutes,
        })),
      } satisfies PlannerEngineInput;
    },
  };
}

export async function searchCatalog(rawInput: unknown) {
  const input = searchRequestSchema.parse(rawInput);
  await assertPlannerCatalogReady(db);

  if (input.kind === "place") {
    const combined = new Map<string, SearchResultDto>();

    if (appEnv.kakaoRestApiKey) {
      const kakaoResults = await searchKakaoPlaces(input.q, input.limit);
      for (const result of kakaoResults) {
        combined.set(result.id, result);
      }
    }

    if (combined.size < input.limit) {
      const storedResults = await searchStoredPlaces(input.q, input.limit - combined.size);
      for (const result of storedResults) {
        combined.set(result.id, result);
      }
    }

    return [...combined.values()].slice(0, input.limit);
  }

  const stops = await db.stop.findMany({
    where: {
      AND: [
        {
          routePatternStops: {
            some: {
              routePattern: {
                scheduleId: {
                  not: null,
                },
              },
            },
          },
        },
        {
          OR: [
            { displayName: { contains: input.q } },
            { translations: { some: { displayName: { contains: input.q } } } },
          ],
        },
      ],
    },
    include: {
      translations: true,
    },
    orderBy: {
      displayName: "asc",
    },
    take: input.limit,
  });

  return stops.map<SearchResultDto>((stop) => ({
    id: stop.id,
    kind: "stop",
    displayName: stop.displayName,
    categoryLabel: "정류장",
    regionName: stop.regionName,
    latitude: stop.latitude,
    longitude: stop.longitude,
    meta: {
      stopId: stop.id,
      translations: stop.translations.length,
    },
  }));
}

export async function createPlannerResult(rawInput: unknown): Promise<PlannerResultDto> {
  const input = planRequestSchema.parse(rawInput);
  await assertPlannerCatalogReady(db);

  const uniquePlaces = new Set(input.places.map(buildPlaceDedupKey));
  if (uniquePlaces.size !== input.places.length) {
    throw new InvalidRequestError("같은 장소를 중복해서 선택할 수 없습니다.");
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

  const graph = await loadPlannerGraph(db, anchors);
  const engineInput = buildEngineInput(input.startAt);
  const candidates = buildPlannerCandidates(planQuery.id, engineInput, graph);

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

  await db.planQuery.update({
    where: { id: planQuery.id },
    data: {
      status: candidates.length > 0 ? "COMPUTED" : "NO_ROUTE",
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

  return {
    planId: planQuery.id,
    startAt: planQuery.startAt.toISOString(),
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
      planQuery.candidates.length === 0 ? plannerFallbackMessage() : undefined,
  };
}

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
    summary: parseJson<CandidateSummary>(candidate.summary),
    legs: parseJson<CandidateLeg[]>(candidate.legs),
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
  const rideLeg =
    provisional.currentLeg?.kind === "ride"
      ? provisional.currentLeg
      : provisional.nextLeg?.kind === "ride"
        ? provisional.nextLeg
        : null;

  if (!rideLeg?.routePatternId) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: "NO_ACTIVE_RIDE",
    };
  }

  const mapping = vehicleDeviceMap.get(rideLeg.routePatternId);
  if (!mapping) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: "VEHICLE_MAP_MISSING",
    };
  }

  if (!appEnv.dataGoKrServiceKey) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: "DATA_GO_KR_SERVICE_KEY_MISSING",
    };
  }

  if (!rideLeg.fromStopId || !rideLeg.toStopId) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: "STOP_REFERENCE_MISSING",
    };
  }

  const [startStop, endStop] = await Promise.all([
    prisma.stop.findUnique({ where: { id: rideLeg.fromStopId } }),
    prisma.stop.findUnique({ where: { id: rideLeg.toStopId } }),
  ]);

  if (!startStop || !endStop) {
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: "STOP_LOOKUP_FAILED",
    };
  }

  try {
    const position = await fetchLatestGnssPosition(
      appEnv.dataGoKrServiceKey,
      mapping.deviceId,
      now,
    );

    if (!position) {
      return {
        applied: false,
        delayMinutes: 0,
        replacementSuggested: false,
        notice: "현재는 시간표 기준 안내입니다.",
        reason: "GNSS_EMPTY",
      };
    }

    const delayMinutes = estimateDelayMinutesFromGnss(
      rideLeg,
      startStop,
      endStop,
      position,
      now,
    );
    const replacementSuggested = delayMinutes >= 3 && Boolean(provisional.nextLeg);

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
    return {
      applied: false,
      delayMinutes: 0,
      replacementSuggested: false,
      notice: "현재는 시간표 기준 안내입니다.",
      reason: error instanceof Error ? error.message : "GNSS_REQUEST_FAILED",
    };
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

  const snapshot = parseJson<{
    summary: CandidateSummary;
    legs: CandidateLeg[];
  }>(session.snapshot);

  const routePatternIds = snapshot.legs.flatMap((leg) =>
    leg.routePatternId ? [leg.routePatternId] : [],
  );
  const mappedPatterns = await db.vehicleDeviceMap.findMany({
    where: {
      routePatternId: {
        in: routePatternIds,
      },
    },
  });
  const vehicleMap = new Map(
    mappedPatterns.map((item) => [
      item.routePatternId,
      {
        deviceId: item.deviceId,
        routePatternId: item.routePatternId,
        externalRouteId: item.externalRouteId,
      },
    ]),
  );

  const now = new Date();
  const provisional = buildExecutionStatus(session.id, snapshot, {}, now);
  const realtimeSignal = await resolveRealtimeSignal(provisional, vehicleMap, db, now);
  const status = buildExecutionStatus(
    session.id,
    snapshot,
    {
      realtime: realtimeSignal,
    },
    now,
  );

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
