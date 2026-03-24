import { PlanPreference } from "@prisma/client";
import { compareMetrics, scoreCandidate } from "@/features/planner/scoring";
import { haversineMeters } from "@/lib/osrm";
import type {
  CandidateLeg,
  CandidateMetrics,
  CandidateSummary,
  CandidateWarning,
  PlannerCandidateDto,
  PlannerEngineInput,
} from "@/features/planner/types";

const ACCESS_STOP_LIMIT = 5;
const MAX_PLACE_STOP_WALK_MINUTES = 25;
const MIN_SEARCH_WINDOW_MINUTES = 90;
const MAX_SEARCH_WINDOW_MINUTES = 210;
const SEGMENT_OPTION_LIMIT = 5;
const BRANCH_LIMIT = 40;
const FIRST_BOARD_BUFFER = 5;
const TRANSFER_BUFFER = 4;
const ESTIMATED_BUFFER = 6;

type PlaceContext = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
  openingHoursRaw: string | null;
  openingHoursJson: unknown;
};

type StopContext = {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
};

type WalkLinkContext = {
  kind: string;
  fromPlaceId: string | null;
  toPlaceId: string | null;
  fromStopId: string | null;
  toStopId: string | null;
  durationMinutes: number;
  distanceMeters: number;
  rank: number;
};

type TripStopContext = {
  stopId: string;
  stopName: string;
  sequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
  isEstimated: boolean;
};

type TripContext = {
  id: string;
  routePatternId: string;
  routeShortName: string;
  routeDisplayName: string;
  headsign: string;
  stopTimes: TripStopContext[];
  stopTimeByStopId: Map<string, TripStopContext>;
};

export type PlannerGraphContext = {
  places: Map<string, PlaceContext>;
  stops: Map<string, StopContext>;
  accessLinksByPlace: Map<string, WalkLinkContext[]>;
  egressLinksByPlace: Map<string, WalkLinkContext[]>;
  stopTransfersByOrigin: Map<string, WalkLinkContext[]>;
  trips: TripContext[];
  realtimePatternIds: Set<string>;
};

type DraftLeg = Omit<CandidateLeg, "id" | "startAt" | "endAt" | "durationMinutes"> & {
  startMinutes: number;
  endMinutes: number;
};

type SegmentOption = {
  signature: string;
  arrivalMinutes: number;
  walkMinutes: number;
  transfers: number;
  usesEstimatedStopTimes: boolean;
  safetyBufferCost: number;
  realtimeEligible: boolean;
  legs: DraftLeg[];
};

type ItineraryDraft = {
  signature: string;
  metrics: CandidateMetrics;
  legs: DraftLeg[];
};

function toServiceMinutes(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function fromServiceMinutes(baseDate: Date, minutes: number) {
  const result = new Date(baseDate);
  result.setHours(0, 0, 0, 0);
  result.setMinutes(minutes);
  return result.toISOString();
}

function createLegId(prefix: string, index: number) {
  return `${prefix}-${index + 1}`;
}

function buildWarnings(metrics: CandidateMetrics): CandidateWarning[] {
  const warnings: CandidateWarning[] = [];

  if (metrics.usesEstimatedStopTimes) {
    warnings.push({
      code: "ESTIMATED_STOP_TIMES",
      message: "일부 정류장 시각은 보간값입니다. 여유 시간을 두고 이동해 주세요.",
    });
  }

  if (!metrics.realtimeEligible) {
    warnings.push({
      code: "REALTIME_UNAVAILABLE",
      message: "실시간 매핑이 없는 구간이 포함되어 있어 시간표 기준으로 안내합니다.",
    });
  }

  if (metrics.transfers > 0) {
    warnings.push({
      code: "TRANSFER_REQUIRED",
      message: `환승 ${metrics.transfers}회가 포함되어 있어 다음 탑승 구간을 다시 확인해야 합니다.`,
    });
  }

  return warnings;
}

function getCandidateCopy(kind: PlanPreference) {
  switch (kind) {
    case "FASTEST":
      return {
        title: "가장 빠른 동선",
        narrative: "최종 도착 시각이 가장 앞서는 조합입니다.",
      };
    case "LEAST_WALK":
      return {
        title: "도보 최소 동선",
        narrative: "걷는 시간을 줄이는 대신 대기 구간이 조금 더 있을 수 있습니다.",
      };
    case "LEAST_TRANSFER":
      return {
        title: "환승 최소 동선",
        narrative: "탑승 흐름을 단순하게 유지하는 데 초점을 둔 조합입니다.",
      };
  }
}

function materializeLegs(baseDate: Date, legs: DraftLeg[], prefix: string): CandidateLeg[] {
  return legs.map((leg, index) => ({
    id: createLegId(prefix, index),
    kind: leg.kind,
    title: leg.title,
    subtitle: leg.subtitle,
    startAt: fromServiceMinutes(baseDate, leg.startMinutes),
    endAt: fromServiceMinutes(baseDate, leg.endMinutes),
    durationMinutes: leg.endMinutes - leg.startMinutes,
    fromLabel: leg.fromLabel,
    toLabel: leg.toLabel,
    routeShortName: leg.routeShortName,
    routePatternId: leg.routePatternId,
    tripId: leg.tripId,
    placeId: leg.placeId,
    fromStopId: leg.fromStopId,
    toStopId: leg.toStopId,
    estimated: leg.estimated,
  }));
}

function buildSummary(
  planId: string,
  baseDate: Date,
  kind: PlanPreference,
  metrics: CandidateMetrics,
): CandidateSummary {
  const copy = getCandidateCopy(kind);
  return {
    planId,
    title: copy.title,
    narrative: copy.narrative,
    totalDurationMinutes: metrics.totalDurationMinutes,
    totalWalkMinutes: metrics.totalWalkMinutes,
    transfers: metrics.transfers,
    finalArrivalAt: fromServiceMinutes(baseDate, metrics.finalArrivalMinutes),
    realtimeEligible: metrics.realtimeEligible,
    usesEstimatedStopTimes: metrics.usesEstimatedStopTimes,
    safetyBufferCost: metrics.safetyBufferCost,
  };
}

function createVisitLeg(
  placeId: string,
  placeName: string,
  startMinutes: number,
  dwellMinutes: number,
): DraftLeg {
  return {
    kind: "visit",
    title: `${placeName} 체류`,
    subtitle: `${dwellMinutes}분 머무르기`,
    startMinutes,
    endMinutes: startMinutes + dwellMinutes,
    fromLabel: placeName,
    toLabel: placeName,
    placeId,
  };
}

function tripUsesEstimated(trip: TripContext, fromSequence: number, toSequence: number) {
  return trip.stopTimes.some(
    (stopTime) =>
      stopTime.sequence >= fromSequence &&
      stopTime.sequence <= toSequence &&
      stopTime.isEstimated,
  );
}

function pushUniqueSegment(
  collection: SegmentOption[],
  option: SegmentOption,
  bestBySignature: Map<string, SegmentOption>,
) {
  const existing = bestBySignature.get(option.signature);
  if (
    !existing ||
    option.arrivalMinutes < existing.arrivalMinutes ||
    (option.arrivalMinutes === existing.arrivalMinutes &&
      option.walkMinutes < existing.walkMinutes)
  ) {
    bestBySignature.set(option.signature, option);
  }

  collection.length = 0;
  collection.push(...bestBySignature.values());
}

function sortSegmentOptions(options: SegmentOption[]) {
  return [...options]
    .sort((left, right) => {
      if (left.arrivalMinutes !== right.arrivalMinutes) {
        return left.arrivalMinutes - right.arrivalMinutes;
      }

      if (left.walkMinutes !== right.walkMinutes) {
        return left.walkMinutes - right.walkMinutes;
      }

      return left.transfers - right.transfers;
    })
    .slice(0, SEGMENT_OPTION_LIMIT);
}

function getSegmentSearchWindowMinutes(fromPlace: PlaceContext, toPlace: PlaceContext) {
  const crowDistanceKilometers = haversineMeters(fromPlace, toPlace) / 1_000;
  const projectedMinutes = Math.round(60 + crowDistanceKilometers * 2.5);

  return Math.max(
    MIN_SEARCH_WINDOW_MINUTES,
    Math.min(MAX_SEARCH_WINDOW_MINUTES, projectedMinutes),
  );
}

function findSegmentOptions(
  currentPlaceId: string,
  nextPlaceId: string,
  earliestDepartureMinutes: number,
  context: PlannerGraphContext,
): SegmentOption[] {
  const fromPlace = context.places.get(currentPlaceId);
  const toPlace = context.places.get(nextPlaceId);

  if (!fromPlace || !toPlace) {
    return [];
  }

  const accessLinks =
    context.accessLinksByPlace
      .get(currentPlaceId)
      ?.filter((link) => link.durationMinutes <= MAX_PLACE_STOP_WALK_MINUTES)
      .sort((left, right) => left.rank - right.rank || left.durationMinutes - right.durationMinutes)
      .slice(0, ACCESS_STOP_LIMIT) ?? [];

  const egressLinks =
    context.egressLinksByPlace
      .get(nextPlaceId)
      ?.filter((link) => link.durationMinutes <= MAX_PLACE_STOP_WALK_MINUTES)
      .sort((left, right) => left.rank - right.rank || left.durationMinutes - right.durationMinutes)
      .slice(0, ACCESS_STOP_LIMIT) ?? [];

  const collected: SegmentOption[] = [];
  const bestBySignature = new Map<string, SegmentOption>();
  const searchWindowEndsAt =
    earliestDepartureMinutes + getSegmentSearchWindowMinutes(fromPlace, toPlace);

  for (const access of accessLinks) {
    if (!access.toStopId) {
      continue;
    }

    const walkToStopEndsAt = earliestDepartureMinutes + access.durationMinutes;
    const firstRideReadyAt = walkToStopEndsAt + FIRST_BOARD_BUFFER;

    for (const egress of egressLinks) {
      if (!egress.fromStopId) {
        continue;
      }

      for (const trip of context.trips) {
        const board = trip.stopTimeByStopId.get(access.toStopId);
        const alight = trip.stopTimeByStopId.get(egress.fromStopId);

        if (!board || !alight || board.sequence >= alight.sequence) {
          continue;
        }

        if (
          board.departureMinutes < firstRideReadyAt ||
          board.departureMinutes > searchWindowEndsAt
        ) {
          continue;
        }

        const estimated = tripUsesEstimated(trip, board.sequence, alight.sequence);
        const walkOutEndsAt = alight.arrivalMinutes + egress.durationMinutes;
        const legs: DraftLeg[] = [
          {
            kind: "walk",
            title: `${fromPlace.displayName}에서 ${context.stops.get(access.toStopId)?.displayName ?? access.toStopId}까지 도보`,
            startMinutes: earliestDepartureMinutes,
            endMinutes: walkToStopEndsAt,
            fromLabel: fromPlace.displayName,
            toLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
            toStopId: access.toStopId,
          },
        ];

        if (board.departureMinutes > walkToStopEndsAt) {
          legs.push({
            kind: "wait",
            title: `${context.stops.get(access.toStopId)?.displayName ?? access.toStopId}에서 버스 대기`,
            startMinutes: walkToStopEndsAt,
            endMinutes: board.departureMinutes,
            fromLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
            toLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
            fromStopId: access.toStopId,
            toStopId: access.toStopId,
          });
        }

        legs.push({
          kind: "ride",
          title: `${trip.routeShortName}번 탑승`,
          subtitle: `${context.stops.get(access.toStopId)?.displayName ?? access.toStopId} → ${context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId}`,
          startMinutes: board.departureMinutes,
          endMinutes: alight.arrivalMinutes,
          fromLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
          toLabel: context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId,
          routeShortName: trip.routeShortName,
          routePatternId: trip.routePatternId,
          tripId: trip.id,
          fromStopId: access.toStopId,
          toStopId: egress.fromStopId,
          estimated,
        });

        legs.push({
          kind: "walk",
          title: `${context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId}에서 ${toPlace.displayName}까지 도보`,
          startMinutes: alight.arrivalMinutes,
          endMinutes: walkOutEndsAt,
          fromLabel: context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId,
          toLabel: toPlace.displayName,
          fromStopId: egress.fromStopId,
        });

        pushUniqueSegment(
          collected,
          {
            signature: `direct:${trip.id}:${access.toStopId}:${egress.fromStopId}`,
            arrivalMinutes: walkOutEndsAt,
            walkMinutes: access.durationMinutes + egress.durationMinutes,
            transfers: 0,
            usesEstimatedStopTimes: estimated,
            safetyBufferCost: FIRST_BOARD_BUFFER + (estimated ? ESTIMATED_BUFFER : 0),
            realtimeEligible: context.realtimePatternIds.has(trip.routePatternId),
            legs,
          },
          bestBySignature,
        );
      }

      for (const firstTrip of context.trips) {
        const boardFirst = firstTrip.stopTimeByStopId.get(access.toStopId);
        if (!boardFirst || boardFirst.departureMinutes < firstRideReadyAt) {
          continue;
        }

        for (const transferStop of firstTrip.stopTimes.filter(
          (stopTime) => stopTime.sequence > boardFirst.sequence,
        )) {
          const transferMoves: WalkLinkContext[] = [
            {
              kind: "STOP_STOP",
              fromPlaceId: null,
              toPlaceId: null,
              fromStopId: transferStop.stopId,
              toStopId: transferStop.stopId,
              durationMinutes: 0,
              distanceMeters: 0,
              rank: 0,
            },
            ...(context.stopTransfersByOrigin.get(transferStop.stopId) ?? []),
          ];

          for (const transferMove of transferMoves) {
            if (!transferMove.toStopId) {
              continue;
            }

            const transferWalkEndsAt =
              transferStop.arrivalMinutes + transferMove.durationMinutes + TRANSFER_BUFFER;

            for (const secondTrip of context.trips) {
              if (secondTrip.id === firstTrip.id) {
                continue;
              }

              const boardSecond = secondTrip.stopTimeByStopId.get(transferMove.toStopId);
              const alightSecond = secondTrip.stopTimeByStopId.get(egress.fromStopId);

              if (
                !boardSecond ||
                !alightSecond ||
                boardSecond.sequence >= alightSecond.sequence
              ) {
                continue;
              }

              if (
                boardSecond.departureMinutes < transferWalkEndsAt ||
                boardSecond.departureMinutes > searchWindowEndsAt
              ) {
                continue;
              }

              const firstEstimated = tripUsesEstimated(
                firstTrip,
                boardFirst.sequence,
                transferStop.sequence,
              );
              const secondEstimated = tripUsesEstimated(
                secondTrip,
                boardSecond.sequence,
                alightSecond.sequence,
              );
              const walkOutEndsAt = alightSecond.arrivalMinutes + egress.durationMinutes;
              const legs: DraftLeg[] = [
                {
                  kind: "walk",
                  title: `${fromPlace.displayName}에서 ${context.stops.get(access.toStopId)?.displayName ?? access.toStopId}까지 도보`,
                  startMinutes: earliestDepartureMinutes,
                  endMinutes: walkToStopEndsAt,
                  fromLabel: fromPlace.displayName,
                  toLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
                  toStopId: access.toStopId,
                },
              ];

              if (boardFirst.departureMinutes > walkToStopEndsAt) {
                legs.push({
                  kind: "wait",
                  title: `${context.stops.get(access.toStopId)?.displayName ?? access.toStopId}에서 버스 대기`,
                  startMinutes: walkToStopEndsAt,
                  endMinutes: boardFirst.departureMinutes,
                  fromLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
                  toLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
                  fromStopId: access.toStopId,
                  toStopId: access.toStopId,
                });
              }

              legs.push({
                kind: "ride",
                title: `${firstTrip.routeShortName}번 탑승`,
                subtitle: `${context.stops.get(access.toStopId)?.displayName ?? access.toStopId} → ${transferStop.stopName}`,
                startMinutes: boardFirst.departureMinutes,
                endMinutes: transferStop.arrivalMinutes,
                fromLabel: context.stops.get(access.toStopId)?.displayName ?? access.toStopId,
                toLabel: transferStop.stopName,
                routeShortName: firstTrip.routeShortName,
                routePatternId: firstTrip.routePatternId,
                tripId: firstTrip.id,
                fromStopId: access.toStopId,
                toStopId: transferStop.stopId,
                estimated: firstEstimated,
              });

              if (transferMove.durationMinutes > 0) {
                legs.push({
                  kind: "walk",
                  title: `${transferStop.stopName}에서 ${context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId}까지 환승 도보`,
                  startMinutes: transferStop.arrivalMinutes,
                  endMinutes: transferStop.arrivalMinutes + transferMove.durationMinutes,
                  fromLabel: transferStop.stopName,
                  toLabel: context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId,
                  fromStopId: transferStop.stopId,
                  toStopId: transferMove.toStopId,
                });
              }

              const secondWaitStartsAt = transferStop.arrivalMinutes + transferMove.durationMinutes;
              if (boardSecond.departureMinutes > secondWaitStartsAt) {
                legs.push({
                  kind: "wait",
                  title: `${context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId}에서 환승 대기`,
                  startMinutes: secondWaitStartsAt,
                  endMinutes: boardSecond.departureMinutes,
                  fromLabel: context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId,
                  toLabel: context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId,
                  fromStopId: transferMove.toStopId,
                  toStopId: transferMove.toStopId,
                });
              }

              legs.push({
                kind: "ride",
                title: `${secondTrip.routeShortName}번 환승`,
                subtitle: `${context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId} → ${context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId}`,
                startMinutes: boardSecond.departureMinutes,
                endMinutes: alightSecond.arrivalMinutes,
                fromLabel: context.stops.get(transferMove.toStopId)?.displayName ?? transferMove.toStopId,
                toLabel: context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId,
                routeShortName: secondTrip.routeShortName,
                routePatternId: secondTrip.routePatternId,
                tripId: secondTrip.id,
                fromStopId: transferMove.toStopId,
                toStopId: egress.fromStopId,
                estimated: secondEstimated,
              });

              legs.push({
                kind: "walk",
                title: `${context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId}에서 ${toPlace.displayName}까지 도보`,
                startMinutes: alightSecond.arrivalMinutes,
                endMinutes: walkOutEndsAt,
                fromLabel: context.stops.get(egress.fromStopId)?.displayName ?? egress.fromStopId,
                toLabel: toPlace.displayName,
                fromStopId: egress.fromStopId,
              });

              pushUniqueSegment(
                collected,
                {
                  signature: `transfer:${firstTrip.id}:${transferStop.stopId}:${secondTrip.id}:${transferMove.toStopId}:${egress.fromStopId}`,
                  arrivalMinutes: walkOutEndsAt,
                  walkMinutes:
                    access.durationMinutes +
                    transferMove.durationMinutes +
                    egress.durationMinutes,
                  transfers: 1,
                  usesEstimatedStopTimes: firstEstimated || secondEstimated,
                  safetyBufferCost:
                    FIRST_BOARD_BUFFER +
                    TRANSFER_BUFFER +
                    ((firstEstimated || secondEstimated) ? ESTIMATED_BUFFER : 0),
                  realtimeEligible:
                    context.realtimePatternIds.has(firstTrip.routePatternId) ||
                    context.realtimePatternIds.has(secondTrip.routePatternId),
                  legs,
                },
                bestBySignature,
              );
            }
          }
        }
      }
    }
  }

  return sortSegmentOptions(collected);
}

function buildItineraries(
  input: PlannerEngineInput,
  context: PlannerGraphContext,
): ItineraryDraft[] {
  const startAt = new Date(input.startAt);
  const serviceStartMinutes = toServiceMinutes(startAt);
  const finished: ItineraryDraft[] = [];
  const lastIndex = input.places.length - 1;

  const dfs = (
    index: number,
    currentMinutes: number,
    legs: DraftLeg[],
    metrics: Omit<CandidateMetrics, "totalDurationMinutes" | "finalArrivalMinutes">,
    signatureParts: string[],
  ) => {
    if (finished.length >= BRANCH_LIMIT) {
      return;
    }

    const currentPlaceInput = input.places[index];
    const currentPlace = context.places.get(currentPlaceInput.placeId);
    if (!currentPlace) {
      return;
    }

    const visitLeg = createVisitLeg(
      currentPlace.id,
      currentPlace.displayName,
      currentMinutes,
      currentPlaceInput.dwellMinutes,
    );
    const withVisit = [...legs, visitLeg];
    const departAfterVisit = visitLeg.endMinutes;

    if (index === lastIndex) {
      finished.push({
        signature: [...signatureParts, `visit:${currentPlace.id}`].join("|"),
        metrics: {
          ...metrics,
          totalDurationMinutes: departAfterVisit - serviceStartMinutes,
          finalArrivalMinutes: departAfterVisit,
        },
        legs: withVisit,
      });
      return;
    }

    const nextPlaceInput = input.places[index + 1];
    const segmentOptions = findSegmentOptions(
      currentPlaceInput.placeId,
      nextPlaceInput.placeId,
      departAfterVisit,
      context,
    ).slice(0, 3);

    for (const option of segmentOptions) {
      dfs(
        index + 1,
        option.arrivalMinutes,
        [...withVisit, ...option.legs],
        {
          totalWalkMinutes: metrics.totalWalkMinutes + option.walkMinutes,
          transfers: metrics.transfers + option.transfers,
          usesEstimatedStopTimes:
            metrics.usesEstimatedStopTimes || option.usesEstimatedStopTimes,
          safetyBufferCost: metrics.safetyBufferCost + option.safetyBufferCost,
          realtimeEligible: metrics.realtimeEligible || option.realtimeEligible,
        },
        [...signatureParts, option.signature],
      );
    }
  };

  dfs(
    0,
    serviceStartMinutes,
    [],
    {
      totalWalkMinutes: 0,
      transfers: 0,
      usesEstimatedStopTimes: false,
      safetyBufferCost: 0,
      realtimeEligible: false,
    },
    [],
  );

  const deduped = new Map<string, ItineraryDraft>();
  for (const itinerary of finished) {
    const existing = deduped.get(itinerary.signature);
    if (
      !existing ||
      itinerary.metrics.finalArrivalMinutes < existing.metrics.finalArrivalMinutes
    ) {
      deduped.set(itinerary.signature, itinerary);
    }
  }

  return [...deduped.values()];
}

export function buildPlannerCandidates(
  planId: string,
  input: PlannerEngineInput,
  context: PlannerGraphContext,
): Omit<PlannerCandidateDto, "id">[] {
  const itineraries = buildItineraries(input, context);
  if (itineraries.length === 0) {
    return [];
  }

  const baseDate = new Date(input.startAt);
  const preferences: PlanPreference[] = [
    "FASTEST",
    "LEAST_WALK",
    "LEAST_TRANSFER",
  ];
  const usedSignatures = new Set<string>();
  const selected: Array<{ kind: PlanPreference; itinerary: ItineraryDraft }> = [];

  for (const kind of preferences) {
    const sorted = [...itineraries].sort((left, right) =>
      compareMetrics(kind, left.metrics, right.metrics),
    );
    const next = sorted.find((itinerary) => !usedSignatures.has(itinerary.signature));

    if (next) {
      usedSignatures.add(next.signature);
      selected.push({ kind, itinerary: next });
    }
  }

  if (selected.length < preferences.length) {
    const fallback = [...itineraries].sort((left, right) =>
      compareMetrics("FASTEST", left.metrics, right.metrics),
    );

    for (const kind of preferences) {
      if (selected.some((item) => item.kind === kind)) {
        continue;
      }

      const next = fallback.find((itinerary) => !usedSignatures.has(itinerary.signature));
      const chosen = next ?? fallback[0];
      if (!chosen) {
        continue;
      }

      usedSignatures.add(chosen.signature);
      selected.push({ kind, itinerary: chosen });
    }
  }

  return selected.map(({ kind, itinerary }) => ({
    kind,
    score: scoreCandidate(kind, itinerary.metrics),
    summary: buildSummary(planId, baseDate, kind, itinerary.metrics),
    legs: materializeLegs(baseDate, itinerary.legs, kind.toLowerCase()),
    warnings: buildWarnings(itinerary.metrics),
  }));
}
