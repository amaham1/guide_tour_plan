import { PlanPreference } from "@prisma/client";
import { compareMetrics, scoreCandidate } from "@/features/planner/scoring";
import { haversineMeters } from "@/lib/osrm";
import type {
  PlannerCandidateDto,
  PlannerEngineInput,
} from "@/features/planner/types";
import {
  ACCESS_STOP_LIMIT,
  FIRST_BOARD_BUFFER,
  MAX_PLACE_STOP_WALK_MINUTES,
  MAX_RIDE_ROUNDS,
  MAX_SEARCH_WINDOW_MINUTES,
  MAX_SEGMENT_RESULT_DURATION_MINUTES,
  MIN_SEARCH_WINDOW_MINUTES,
  PARTIAL_FRONTIER_LIMIT,
  SEGMENT_OPTIONS_PER_PARTIAL,
  SEGMENT_OPTION_LIMIT,
  TRANSFER_BUFFER,
} from "@/features/planner/engine-constants";
import { MinHeap } from "@/features/planner/engine-heap";
import {
  buildSummary,
  buildWarnings,
  createAccessWalkLeg,
  createEgressWalkLeg,
  createRideLeg,
  createTransferWalkLeg,
  createVisitLeg,
  createWaitLeg,
  getRideLegTimeReliability,
  materializeLegs,
} from "@/features/planner/engine-legs";
import {
  getStopTimeWindow,
  getStopTimeWindowMinutes,
  getTimeReliabilityBuffer,
  getTimeReliabilityRank,
  getWindowMinutes,
  maxTimeReliability,
  mergeWindows,
  shiftWindow,
  toServiceMinutes,
} from "@/features/planner/engine-time";
import type {
  ItineraryDraft,
  PartialItinerary,
  PlaceContext,
  PlannerGraphContext,
  QueueEntry,
  RouteContext,
  RoutingIndex,
  SegmentOption,
  StopLabel,
  TripContext,
  TripStopContext,
  WalkLinkContext,
} from "@/features/planner/engine-types";

export type { PlannerGraphContext } from "@/features/planner/engine-types";



function compareStopLabels(left: StopLabel, right: StopLabel) {
  if (left.arrivalMinutes !== right.arrivalMinutes) {
    return left.arrivalMinutes - right.arrivalMinutes;
  }

  if (left.walkMinutes !== right.walkMinutes) {
    return left.walkMinutes - right.walkMinutes;
  }

  if (left.safetyBufferCost !== right.safetyBufferCost) {
    return left.safetyBufferCost - right.safetyBufferCost;
  }

  if (left.worstTimeReliability !== right.worstTimeReliability) {
    return (
      getTimeReliabilityRank(left.worstTimeReliability) -
      getTimeReliabilityRank(right.worstTimeReliability)
    );
  }

  if (left.roughWindowMinutes !== right.roughWindowMinutes) {
    return left.roughWindowMinutes - right.roughWindowMinutes;
  }

  if (left.realtimeEligible !== right.realtimeEligible) {
    return left.realtimeEligible ? -1 : 1;
  }

  return left.legs.length - right.legs.length;
}

function compareSegmentOptions(left: SegmentOption, right: SegmentOption) {
  if (left.arrivalMinutes !== right.arrivalMinutes) {
    return left.arrivalMinutes - right.arrivalMinutes;
  }

  if (left.walkMinutes !== right.walkMinutes) {
    return left.walkMinutes - right.walkMinutes;
  }

  if (left.transfers !== right.transfers) {
    return left.transfers - right.transfers;
  }

  if (left.safetyBufferCost !== right.safetyBufferCost) {
    return left.safetyBufferCost - right.safetyBufferCost;
  }

  if (left.worstTimeReliability !== right.worstTimeReliability) {
    return (
      getTimeReliabilityRank(left.worstTimeReliability) -
      getTimeReliabilityRank(right.worstTimeReliability)
    );
  }

  if (left.roughWindowMinutes !== right.roughWindowMinutes) {
    return left.roughWindowMinutes - right.roughWindowMinutes;
  }

  if (left.realtimeEligible !== right.realtimeEligible) {
    return left.realtimeEligible ? -1 : 1;
  }

  return left.legs.length - right.legs.length;
}

function dominatesSegmentOption(left: SegmentOption, right: SegmentOption) {
  const leftRealtimePenalty = left.realtimeEligible ? 0 : 1;
  const rightRealtimePenalty = right.realtimeEligible ? 0 : 1;
  const leftReliabilityPenalty = getTimeReliabilityRank(left.worstTimeReliability);
  const rightReliabilityPenalty = getTimeReliabilityRank(right.worstTimeReliability);

  const noWorse =
    left.arrivalMinutes <= right.arrivalMinutes &&
    left.walkMinutes <= right.walkMinutes &&
    left.transfers <= right.transfers &&
    left.safetyBufferCost <= right.safetyBufferCost &&
    leftReliabilityPenalty <= rightReliabilityPenalty &&
    left.roughWindowMinutes <= right.roughWindowMinutes &&
    leftRealtimePenalty <= rightRealtimePenalty;

  const strictlyBetter =
    left.arrivalMinutes < right.arrivalMinutes ||
    left.walkMinutes < right.walkMinutes ||
    left.transfers < right.transfers ||
    left.safetyBufferCost < right.safetyBufferCost ||
    leftReliabilityPenalty < rightReliabilityPenalty ||
    left.roughWindowMinutes < right.roughWindowMinutes ||
    leftRealtimePenalty < rightRealtimePenalty;

  return noWorse && strictlyBetter;
}

function comparePartialItineraries(left: PartialItinerary, right: PartialItinerary) {
  if (left.currentMinutes !== right.currentMinutes) {
    return left.currentMinutes - right.currentMinutes;
  }

  if (left.metrics.totalWalkMinutes !== right.metrics.totalWalkMinutes) {
    return left.metrics.totalWalkMinutes - right.metrics.totalWalkMinutes;
  }

  if (left.metrics.transfers !== right.metrics.transfers) {
    return left.metrics.transfers - right.metrics.transfers;
  }

  if (left.metrics.safetyBufferCost !== right.metrics.safetyBufferCost) {
    return left.metrics.safetyBufferCost - right.metrics.safetyBufferCost;
  }

  if (left.metrics.worstTimeReliability !== right.metrics.worstTimeReliability) {
    return (
      getTimeReliabilityRank(left.metrics.worstTimeReliability) -
      getTimeReliabilityRank(right.metrics.worstTimeReliability)
    );
  }

  if (left.metrics.roughWindowMinutes !== right.metrics.roughWindowMinutes) {
    return left.metrics.roughWindowMinutes - right.metrics.roughWindowMinutes;
  }

  if (left.metrics.realtimeEligible !== right.metrics.realtimeEligible) {
    return left.metrics.realtimeEligible ? -1 : 1;
  }

  return left.legs.length - right.legs.length;
}

function dominatesPartialItinerary(left: PartialItinerary, right: PartialItinerary) {
  const leftRealtimePenalty = left.metrics.realtimeEligible ? 0 : 1;
  const rightRealtimePenalty = right.metrics.realtimeEligible ? 0 : 1;
  const leftReliabilityPenalty = getTimeReliabilityRank(left.metrics.worstTimeReliability);
  const rightReliabilityPenalty = getTimeReliabilityRank(right.metrics.worstTimeReliability);

  const noWorse =
    left.currentMinutes <= right.currentMinutes &&
    left.metrics.totalWalkMinutes <= right.metrics.totalWalkMinutes &&
    left.metrics.transfers <= right.metrics.transfers &&
    left.metrics.safetyBufferCost <= right.metrics.safetyBufferCost &&
    leftReliabilityPenalty <= rightReliabilityPenalty &&
    left.metrics.roughWindowMinutes <= right.metrics.roughWindowMinutes &&
    leftRealtimePenalty <= rightRealtimePenalty;

  const strictlyBetter =
    left.currentMinutes < right.currentMinutes ||
    left.metrics.totalWalkMinutes < right.metrics.totalWalkMinutes ||
    left.metrics.transfers < right.metrics.transfers ||
    left.metrics.safetyBufferCost < right.metrics.safetyBufferCost ||
    leftReliabilityPenalty < rightReliabilityPenalty ||
    left.metrics.roughWindowMinutes < right.metrics.roughWindowMinutes ||
    leftRealtimePenalty < rightRealtimePenalty;

  return noWorse && strictlyBetter;
}

function upsertStopLabel(labels: Map<string, StopLabel>, candidate: StopLabel) {
  const existing = labels.get(candidate.stopId);
  if (!existing || compareStopLabels(candidate, existing) < 0) {
    labels.set(candidate.stopId, candidate);
    return true;
  }

  return false;
}

function upsertSegmentOption(bestBySignature: Map<string, SegmentOption>, candidate: SegmentOption) {
  const existing = bestBySignature.get(candidate.signature);
  if (!existing || compareSegmentOptions(candidate, existing) < 0) {
    bestBySignature.set(candidate.signature, candidate);
  }
}

function sortSegmentOptions(options: SegmentOption[]) {
  const sorted = [...options].sort(compareSegmentOptions);
  const frontier: SegmentOption[] = [];

  for (const option of sorted) {
    if (frontier.some((existing) => dominatesSegmentOption(existing, option))) {
      continue;
    }

    frontier.push(option);
    if (frontier.length >= SEGMENT_OPTION_LIMIT) {
      break;
    }
  }

  return frontier;
}

function prunePartialFrontier(partials: PartialItinerary[]) {
  const bestBySignature = new Map<string, PartialItinerary>();
  for (const partial of partials) {
    const existing = bestBySignature.get(partial.signature);
    if (!existing || comparePartialItineraries(partial, existing) < 0) {
      bestBySignature.set(partial.signature, partial);
    }
  }

  const sorted = [...bestBySignature.values()].sort(comparePartialItineraries);
  const frontier: PartialItinerary[] = [];

  for (const partial of sorted) {
    if (frontier.some((existing) => dominatesPartialItinerary(existing, partial))) {
      continue;
    }

    frontier.push(partial);
    if (frontier.length >= PARTIAL_FRONTIER_LIMIT) {
      break;
    }
  }

  return frontier;
}

function buildRouteIndex(context: PlannerGraphContext): RoutingIndex {
  const groupedTrips = new Map<string, TripContext[]>();

  for (const trip of context.trips) {
    const routeKey = trip.routingKey ?? trip.routePatternId;
    const next = groupedTrips.get(routeKey) ?? [];
    next.push(trip);
    groupedTrips.set(routeKey, next);
  }

  const routesById = new Map<string, RouteContext>();
  const routesByStopId = new Map<string, Array<{ routeId: string; stopIndex: number }>>();

  for (const [routeId, routeTrips] of groupedTrips) {
    const trips = [...routeTrips].sort((left, right) => {
      const leftDeparture = left.stopTimes[0]?.departureMinutes ?? Number.POSITIVE_INFINITY;
      const rightDeparture = right.stopTimes[0]?.departureMinutes ?? Number.POSITIVE_INFINITY;
      return leftDeparture - rightDeparture;
    });

    const stopIds = trips[0]?.stopTimes.map((stopTime) => stopTime.stopId) ?? [];
    if (stopIds.length === 0) {
      continue;
    }

    routesById.set(routeId, {
      id: routeId,
      stopIds,
      trips,
    });

    stopIds.forEach((stopId, stopIndex) => {
      const next = routesByStopId.get(stopId) ?? [];
      next.push({ routeId, stopIndex });
      routesByStopId.set(stopId, next);
    });
  }

  return {
    routesById,
    routesByStopId,
  };
}

function findEarliestBoardableTrip(
  route: RouteContext,
  stopIndex: number,
  readyAt: number,
  searchWindowEndsAt: number,
) {
  let best:
    | {
        trip: TripContext;
        boardStopTime: TripStopContext;
      }
    | null = null;

  for (const trip of route.trips) {
    const boardStopTime = trip.stopTimes[stopIndex];
    if (!boardStopTime) {
      continue;
    }

    if (
      boardStopTime.departureMinutes < readyAt ||
      boardStopTime.departureMinutes > searchWindowEndsAt
    ) {
      continue;
    }

    if (!best || boardStopTime.departureMinutes < best.boardStopTime.departureMinutes) {
      best = {
        trip,
        boardStopTime,
      };
    }
  }

  return best;
}

function getSegmentSearchWindowMinutes(fromPlace: PlaceContext, toPlace: PlaceContext) {
  const crowDistanceKilometers = haversineMeters(fromPlace, toPlace) / 1_000;
  const projectedMinutes = Math.round(60 + crowDistanceKilometers * 2.5);

  return Math.max(
    MIN_SEARCH_WINDOW_MINUTES,
    Math.min(MAX_SEARCH_WINDOW_MINUTES, projectedMinutes),
  );
}

function collectRoutesToScan(labels: Map<string, StopLabel>, routingIndex: RoutingIndex) {
  const startByRoute = new Map<string, number>();

  for (const stopId of labels.keys()) {
    for (const reference of routingIndex.routesByStopId.get(stopId) ?? []) {
      const currentStart = startByRoute.get(reference.routeId);
      if (currentStart === undefined || reference.stopIndex < currentStart) {
        startByRoute.set(reference.routeId, reference.stopIndex);
      }
    }
  }

  return [...startByRoute.entries()]
    .map(([routeId, startIndex]) => {
      const route = routingIndex.routesById.get(routeId);
      return route ? { route, startIndex } : null;
    })
    .filter((entry): entry is { route: RouteContext; startIndex: number } => entry !== null);
}

function relaxTransferLabels(
  seeds: Map<string, StopLabel>,
  context: PlannerGraphContext,
  maxArrivalMinutes: number,
) {
  const best = new Map<string, StopLabel>();
  const queue = new MinHeap<QueueEntry>(
    (left, right) =>
      left.arrivalMinutes - right.arrivalMinutes || left.walkMinutes - right.walkMinutes,
  );

  for (const seed of seeds.values()) {
    if (seed.arrivalMinutes > maxArrivalMinutes) {
      continue;
    }

    if (upsertStopLabel(best, seed)) {
      queue.push({
        stopId: seed.stopId,
        arrivalMinutes: seed.arrivalMinutes,
        walkMinutes: seed.walkMinutes,
      });
    }
  }

  while (queue.size > 0) {
    const current = queue.pop();
    if (!current) {
      break;
    }

    const currentLabel = best.get(current.stopId);
    if (
      !currentLabel ||
      currentLabel.arrivalMinutes !== current.arrivalMinutes ||
      currentLabel.walkMinutes !== current.walkMinutes
    ) {
      continue;
    }

    const fromStop = context.stops.get(current.stopId);
    for (const transfer of context.stopTransfersByOrigin.get(current.stopId) ?? []) {
      if (!transfer.toStopId || transfer.toStopId === current.stopId) {
        continue;
      }

      const nextArrivalMinutes = currentLabel.arrivalMinutes + transfer.durationMinutes;
      if (nextArrivalMinutes > maxArrivalMinutes) {
        continue;
      }

      const toStop = context.stops.get(transfer.toStopId);
      const shiftedWindow = shiftWindow(
        currentLabel.arrivalWindowStartMinutes,
        currentLabel.arrivalWindowEndMinutes,
        transfer.durationMinutes,
      );
      const candidate: StopLabel = {
        stopId: transfer.toStopId,
        arrivalMinutes: nextArrivalMinutes,
        arrivalWindowStartMinutes: shiftedWindow.startMinutes,
        arrivalWindowEndMinutes: shiftedWindow.endMinutes,
        walkMinutes: currentLabel.walkMinutes + transfer.durationMinutes,
        safetyBufferCost: currentLabel.safetyBufferCost,
        worstTimeReliability: currentLabel.worstTimeReliability,
        roughWindowMinutes: currentLabel.roughWindowMinutes,
        realtimeEligible: currentLabel.realtimeEligible,
        signature: `${currentLabel.signature}|walk:${current.stopId}:${transfer.toStopId}`,
        legs: [
          ...currentLabel.legs,
          createTransferWalkLeg(
            fromStop,
            toStop,
            current.stopId,
            transfer.toStopId,
            currentLabel.arrivalMinutes,
            nextArrivalMinutes,
          ),
        ],
      };

      if (upsertStopLabel(best, candidate)) {
        queue.push({
          stopId: candidate.stopId,
          arrivalMinutes: candidate.arrivalMinutes,
          walkMinutes: candidate.walkMinutes,
        });
      }
    }
  }

  return best;
}

function scanRoute(
  route: RouteContext,
  startIndex: number,
  previousRoundLabels: Map<string, StopLabel>,
  currentRoundSeeds: Map<string, StopLabel>,
  round: number,
  context: PlannerGraphContext,
  searchWindowEndsAt: number,
  maxArrivalMinutes: number,
) {
  let activeBoard:
    | {
        trip: TripContext;
        boardStopTime: TripStopContext;
        boardStopIndex: number;
        previousLabel: StopLabel;
      }
    | null = null;

  for (let stopIndex = startIndex; stopIndex < route.stopIds.length; stopIndex += 1) {
    const stopId = route.stopIds[stopIndex];
    const previousLabel = previousRoundLabels.get(stopId);

    if (previousLabel) {
      const readyAt =
        previousLabel.arrivalMinutes + (round === 1 ? FIRST_BOARD_BUFFER : TRANSFER_BUFFER);
      if (readyAt <= searchWindowEndsAt) {
        const candidateBoard = findEarliestBoardableTrip(
          route,
          stopIndex,
          readyAt,
          searchWindowEndsAt,
        );
        if (candidateBoard) {
          const candidateTrip = candidateBoard.trip;
          const candidateBoardStopTime = candidateBoard.boardStopTime;
          const candidateDeparture = candidateBoardStopTime.departureMinutes;
          const activeDeparture = activeBoard?.trip.stopTimes[stopIndex]?.departureMinutes;

          if (
            !activeBoard ||
              activeDeparture === undefined ||
              candidateDeparture < activeDeparture ||
              (candidateDeparture === activeDeparture &&
                compareStopLabels(previousLabel, activeBoard.previousLabel) < 0)
          ) {
            activeBoard = {
              trip: candidateTrip,
              boardStopTime: candidateBoardStopTime,
              boardStopIndex: stopIndex,
              previousLabel,
            };
          }
        }
      }
    }

    if (!activeBoard || stopIndex <= activeBoard.boardStopIndex) {
      continue;
    }

    const alightStopTime = activeBoard.trip.stopTimes[stopIndex];
    if (
      !alightStopTime ||
      alightStopTime.arrivalMinutes > maxArrivalMinutes ||
      alightStopTime.arrivalMinutes < activeBoard.boardStopTime.departureMinutes
    ) {
      continue;
    }

    const rideTimeReliability = getRideLegTimeReliability(
      activeBoard.boardStopTime,
      alightStopTime,
    );
    const inheritedArrivalWindow = shiftWindow(
      activeBoard.previousLabel.arrivalWindowStartMinutes,
      activeBoard.previousLabel.arrivalWindowEndMinutes,
      alightStopTime.arrivalMinutes - activeBoard.previousLabel.arrivalMinutes,
    );
    const boardArrivalWindow = shiftWindow(
      activeBoard.boardStopTime.windowStartMinutes,
      activeBoard.boardStopTime.windowEndMinutes,
      alightStopTime.arrivalMinutes - activeBoard.boardStopTime.departureMinutes,
    );
    const mergedArrivalWindow = mergeWindows(
      inheritedArrivalWindow,
      boardArrivalWindow,
      getStopTimeWindow(alightStopTime),
    );

    const nextLegs = [...activeBoard.previousLabel.legs];
    if (activeBoard.boardStopTime.departureMinutes > activeBoard.previousLabel.arrivalMinutes) {
      nextLegs.push(
        createWaitLeg(
          activeBoard.boardStopTime.stopName,
          activeBoard.boardStopTime.stopId,
          activeBoard.previousLabel.arrivalMinutes,
          activeBoard.boardStopTime.departureMinutes,
        ),
      );
    }
    nextLegs.push(
      createRideLeg(
        activeBoard.trip,
        activeBoard.boardStopTime,
        alightStopTime,
        rideTimeReliability,
      ),
    );

    const candidate: StopLabel = {
      stopId: alightStopTime.stopId,
      arrivalMinutes: alightStopTime.arrivalMinutes,
      arrivalWindowStartMinutes: mergedArrivalWindow.startMinutes,
      arrivalWindowEndMinutes: mergedArrivalWindow.endMinutes,
      walkMinutes: activeBoard.previousLabel.walkMinutes,
      safetyBufferCost:
        activeBoard.previousLabel.safetyBufferCost +
        (round === 1 ? FIRST_BOARD_BUFFER : TRANSFER_BUFFER) +
        getTimeReliabilityBuffer(rideTimeReliability),
      worstTimeReliability: maxTimeReliability(
        activeBoard.previousLabel.worstTimeReliability,
        rideTimeReliability,
      ),
      roughWindowMinutes: Math.max(
        activeBoard.previousLabel.roughWindowMinutes,
        getWindowMinutes(
          mergedArrivalWindow.startMinutes,
          mergedArrivalWindow.endMinutes,
        ),
        getStopTimeWindowMinutes(activeBoard.boardStopTime),
        getStopTimeWindowMinutes(alightStopTime),
      ),
      realtimeEligible:
        activeBoard.previousLabel.realtimeEligible && rideTimeReliability !== "ROUGH",
      signature: `${activeBoard.previousLabel.signature}|ride:${activeBoard.trip.id}:${activeBoard.boardStopTime.stopId}:${alightStopTime.stopId}`,
      legs: nextLegs,
    };

    upsertStopLabel(currentRoundSeeds, candidate);
  }
}

function collectSegmentOptions(
  labels: Map<string, StopLabel>,
  egressLinks: WalkLinkContext[],
  toPlace: PlaceContext,
  ridesUsed: number,
  context: PlannerGraphContext,
  maxArrivalMinutes: number,
  bestBySignature: Map<string, SegmentOption>,
) {
  for (const egress of egressLinks) {
    if (!egress.fromStopId) {
      continue;
    }

    const label = labels.get(egress.fromStopId);
    if (!label) {
      continue;
    }

    const arrivalMinutes = label.arrivalMinutes + egress.durationMinutes;
    if (arrivalMinutes > maxArrivalMinutes) {
      continue;
    }

    const fromStop = context.stops.get(egress.fromStopId);
    const shiftedWindow = shiftWindow(
      label.arrivalWindowStartMinutes,
      label.arrivalWindowEndMinutes,
      egress.durationMinutes,
    );
    const option: SegmentOption = {
      signature: `${label.signature}|egress:${egress.fromStopId}:${toPlace.id}`,
      arrivalMinutes,
      arrivalWindowStartMinutes: shiftedWindow.startMinutes,
      arrivalWindowEndMinutes: shiftedWindow.endMinutes,
      walkMinutes: label.walkMinutes + egress.durationMinutes,
      transfers: Math.max(0, ridesUsed - 1),
      worstTimeReliability: label.worstTimeReliability,
      roughWindowMinutes: Math.max(
        label.roughWindowMinutes,
        getWindowMinutes(shiftedWindow.startMinutes, shiftedWindow.endMinutes),
      ),
      safetyBufferCost: label.safetyBufferCost,
      realtimeEligible: label.realtimeEligible,
      legs: [
        ...label.legs,
        createEgressWalkLeg(
          fromStop,
          egress.fromStopId,
          toPlace,
          label.arrivalMinutes,
          arrivalMinutes,
        ),
      ],
    };

    upsertSegmentOption(bestBySignature, option);
  }
}

function findSegmentOptions(
  currentPlaceId: string,
  nextPlaceId: string,
  earliestDepartureMinutes: number,
  context: PlannerGraphContext,
  routingIndex: RoutingIndex,
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

  if (accessLinks.length === 0 || egressLinks.length === 0) {
    return [];
  }

  const searchWindowEndsAt =
    earliestDepartureMinutes + getSegmentSearchWindowMinutes(fromPlace, toPlace);
  const maxArrivalMinutes = earliestDepartureMinutes + MAX_SEGMENT_RESULT_DURATION_MINUTES;

  const accessSeeds = new Map<string, StopLabel>();
  for (const access of accessLinks) {
    if (!access.toStopId) {
      continue;
    }

    const toStop = context.stops.get(access.toStopId);
    const candidate: StopLabel = {
      stopId: access.toStopId,
      arrivalMinutes: earliestDepartureMinutes + access.durationMinutes,
      arrivalWindowStartMinutes: null,
      arrivalWindowEndMinutes: null,
      walkMinutes: access.durationMinutes,
      safetyBufferCost: 0,
      worstTimeReliability: "OFFICIAL",
      roughWindowMinutes: 0,
      realtimeEligible: true,
      signature: `access:${currentPlaceId}:${access.toStopId}`,
      legs: [
        createAccessWalkLeg(
          fromPlace,
          toStop,
          access.toStopId,
          earliestDepartureMinutes,
          earliestDepartureMinutes + access.durationMinutes,
        ),
      ],
    };

    upsertStopLabel(accessSeeds, candidate);
  }

  let previousRoundLabels = relaxTransferLabels(accessSeeds, context, maxArrivalMinutes);
  const bestBySignature = new Map<string, SegmentOption>();

  for (let round = 1; round <= MAX_RIDE_ROUNDS; round += 1) {
    const routesToScan = collectRoutesToScan(previousRoundLabels, routingIndex);
    if (routesToScan.length === 0) {
      break;
    }

    const roundSeeds = new Map<string, StopLabel>();
    for (const { route, startIndex } of routesToScan) {
      scanRoute(
        route,
        startIndex,
        previousRoundLabels,
        roundSeeds,
        round,
        context,
        searchWindowEndsAt,
        maxArrivalMinutes,
      );
    }

    if (roundSeeds.size === 0) {
      break;
    }

    previousRoundLabels = relaxTransferLabels(roundSeeds, context, maxArrivalMinutes);
    collectSegmentOptions(
      previousRoundLabels,
      egressLinks,
      toPlace,
      round,
      context,
      maxArrivalMinutes,
      bestBySignature,
    );
  }

  return sortSegmentOptions([...bestBySignature.values()]);
}

function buildItineraries(input: PlannerEngineInput, context: PlannerGraphContext): ItineraryDraft[] {
  const startAt = new Date(input.startAt);
  const serviceStartMinutes = toServiceMinutes(startAt);
  const routingIndex = buildRouteIndex(context);
  const segmentCache = new Map<string, SegmentOption[]>();
  const finished: PartialItinerary[] = [];

  let frontier: PartialItinerary[] = [
    {
      signature: "",
      currentMinutes: serviceStartMinutes,
      metrics: {
        totalWalkMinutes: 0,
        transfers: 0,
        worstTimeReliability: "OFFICIAL",
        finalArrivalWindowStartMinutes: null,
        finalArrivalWindowEndMinutes: null,
        roughWindowMinutes: 0,
        safetyBufferCost: 0,
        realtimeEligible: true,
      },
      legs: [],
    },
  ];

  for (let index = 0; index < input.places.length; index += 1) {
    const currentPlaceInput = input.places[index];
    const currentPlace = context.places.get(currentPlaceInput.placeId);
    if (!currentPlace) {
      continue;
    }

    const nextFrontier: PartialItinerary[] = [];
    for (const partial of frontier) {
      const visitLeg = createVisitLeg(
        currentPlace.id,
        currentPlace.displayName,
        partial.currentMinutes,
        currentPlaceInput.dwellMinutes,
      );
      const visitedPartial: PartialItinerary = {
        signature: partial.signature
          ? `${partial.signature}|visit:${currentPlace.id}`
          : `visit:${currentPlace.id}`,
        currentMinutes: visitLeg.endMinutes,
        metrics: {
          ...partial.metrics,
          finalArrivalWindowStartMinutes:
            partial.metrics.finalArrivalWindowStartMinutes !== null
              ? partial.metrics.finalArrivalWindowStartMinutes + currentPlaceInput.dwellMinutes
              : null,
          finalArrivalWindowEndMinutes:
            partial.metrics.finalArrivalWindowEndMinutes !== null
              ? partial.metrics.finalArrivalWindowEndMinutes + currentPlaceInput.dwellMinutes
              : null,
        },
        legs: [...partial.legs, visitLeg],
      };

      if (index === input.places.length - 1) {
        finished.push(visitedPartial);
        continue;
      }

      const nextPlaceInput = input.places[index + 1];
      const cacheKey = `${currentPlace.id}|${nextPlaceInput.placeId}|${visitedPartial.currentMinutes}`;
      let segmentOptions = segmentCache.get(cacheKey);
      if (!segmentOptions) {
        segmentOptions = findSegmentOptions(
          currentPlace.id,
          nextPlaceInput.placeId,
          visitedPartial.currentMinutes,
          context,
          routingIndex,
        );
        segmentCache.set(cacheKey, segmentOptions);
      }

      for (const option of segmentOptions.slice(0, SEGMENT_OPTIONS_PER_PARTIAL)) {
        const inheritedArrivalWindow = shiftWindow(
          visitedPartial.metrics.finalArrivalWindowStartMinutes,
          visitedPartial.metrics.finalArrivalWindowEndMinutes,
          option.arrivalMinutes - visitedPartial.currentMinutes,
        );
        const mergedArrivalWindow = mergeWindows(inheritedArrivalWindow, {
          startMinutes: option.arrivalWindowStartMinutes,
          endMinutes: option.arrivalWindowEndMinutes,
        });

        nextFrontier.push({
          signature: `${visitedPartial.signature}|${option.signature}`,
          currentMinutes: option.arrivalMinutes,
          metrics: {
            totalWalkMinutes: visitedPartial.metrics.totalWalkMinutes + option.walkMinutes,
            transfers: visitedPartial.metrics.transfers + option.transfers,
            worstTimeReliability: maxTimeReliability(
              visitedPartial.metrics.worstTimeReliability,
              option.worstTimeReliability,
            ),
            finalArrivalWindowStartMinutes: mergedArrivalWindow.startMinutes,
            finalArrivalWindowEndMinutes: mergedArrivalWindow.endMinutes,
            roughWindowMinutes: Math.max(
              visitedPartial.metrics.roughWindowMinutes,
              option.roughWindowMinutes,
              getWindowMinutes(
                mergedArrivalWindow.startMinutes,
                mergedArrivalWindow.endMinutes,
              ),
            ),
            safetyBufferCost: visitedPartial.metrics.safetyBufferCost + option.safetyBufferCost,
            realtimeEligible:
              visitedPartial.metrics.realtimeEligible && option.realtimeEligible,
          },
          legs: [...visitedPartial.legs, ...option.legs],
        });
      }
    }

    if (index < input.places.length - 1) {
      frontier = prunePartialFrontier(nextFrontier);
      if (frontier.length === 0) {
        break;
      }
    }
  }

  const deduped = new Map<string, PartialItinerary>();
  for (const itinerary of finished) {
    const existing = deduped.get(itinerary.signature);
    if (!existing || comparePartialItineraries(itinerary, existing) < 0) {
      deduped.set(itinerary.signature, itinerary);
    }
  }

  return [...deduped.values()].map((itinerary) => ({
    signature: itinerary.signature,
    metrics: {
      ...itinerary.metrics,
      totalDurationMinutes: itinerary.currentMinutes - serviceStartMinutes,
      finalArrivalMinutes: itinerary.currentMinutes,
    },
    legs: itinerary.legs,
  }));
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
