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

const ACCESS_STOP_LIMIT = 12;
const MAX_PLACE_STOP_WALK_MINUTES = 25;
const MIN_SEARCH_WINDOW_MINUTES = 90;
const MAX_SEARCH_WINDOW_MINUTES = 210;
const SEGMENT_OPTION_LIMIT = 12;
const SEGMENT_OPTIONS_PER_PARTIAL = 8;
const PARTIAL_FRONTIER_LIMIT = 72;
const MAX_RIDE_ROUNDS = 5;
const FIRST_BOARD_BUFFER = 5;
const TRANSFER_BUFFER = 4;
const ESTIMATED_BUFFER = 6;
const MAX_SEGMENT_RESULT_DURATION_MINUTES = MAX_SEARCH_WINDOW_MINUTES + 120;
const SERVICE_UTC_OFFSET_MINUTES = 9 * 60;

const serviceDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

const serviceTimeFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Asia/Seoul",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

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

type RouteContext = {
  id: string;
  stopIds: string[];
  trips: TripContext[];
};

type RoutingIndex = {
  routesById: Map<string, RouteContext>;
  routesByStopId: Map<string, Array<{ routeId: string; stopIndex: number }>>;
};

type StopLabel = {
  stopId: string;
  arrivalMinutes: number;
  walkMinutes: number;
  safetyBufferCost: number;
  usesEstimatedStopTimes: boolean;
  realtimeEligible: boolean;
  signature: string;
  legs: DraftLeg[];
};

type PartialMetrics = Omit<CandidateMetrics, "totalDurationMinutes" | "finalArrivalMinutes">;

type PartialItinerary = {
  signature: string;
  currentMinutes: number;
  metrics: PartialMetrics;
  legs: DraftLeg[];
};

type QueueEntry = {
  stopId: string;
  arrivalMinutes: number;
  walkMinutes: number;
};

class MinHeap<T> {
  private readonly items: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get size() {
    return this.items.length;
  }

  push(value: T) {
    this.items.push(value);
    this.bubbleUp(this.items.length - 1);
  }

  pop() {
    if (this.items.length === 0) {
      return undefined;
    }

    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last) {
      this.items[0] = last;
      this.bubbleDown(0);
    }

    return top;
  }

  private bubbleUp(index: number) {
    let currentIndex = index;
    while (currentIndex > 0) {
      const parentIndex = Math.floor((currentIndex - 1) / 2);
      if (this.compare(this.items[currentIndex], this.items[parentIndex]) >= 0) {
        return;
      }

      [this.items[currentIndex], this.items[parentIndex]] = [
        this.items[parentIndex],
        this.items[currentIndex],
      ];
      currentIndex = parentIndex;
    }
  }

  private bubbleDown(index: number) {
    let currentIndex = index;
    while (true) {
      const leftIndex = currentIndex * 2 + 1;
      const rightIndex = currentIndex * 2 + 2;
      let smallestIndex = currentIndex;

      if (
        leftIndex < this.items.length &&
        this.compare(this.items[leftIndex], this.items[smallestIndex]) < 0
      ) {
        smallestIndex = leftIndex;
      }

      if (
        rightIndex < this.items.length &&
        this.compare(this.items[rightIndex], this.items[smallestIndex]) < 0
      ) {
        smallestIndex = rightIndex;
      }

      if (smallestIndex === currentIndex) {
        return;
      }

      [this.items[currentIndex], this.items[smallestIndex]] = [
        this.items[smallestIndex],
        this.items[currentIndex],
      ];
      currentIndex = smallestIndex;
    }
  }
}

function toServiceMinutes(date: Date) {
  const parts = serviceTimeFormatter.formatToParts(date);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

function fromServiceMinutes(baseDate: Date, minutes: number) {
  const parts = serviceDateFormatter.formatToParts(baseDate);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? "0");
  const month = Number(parts.find((part) => part.type === "month")?.value ?? "1");
  const day = Number(parts.find((part) => part.type === "day")?.value ?? "1");
  const result = new Date(
    Date.UTC(year, month - 1, day, 0, minutes) - SERVICE_UTC_OFFSET_MINUTES * 60_000,
  );
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

function createAccessWalkLeg(
  fromPlace: PlaceContext,
  toStop: StopContext | undefined,
  toStopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const stopName = toStop?.displayName ?? toStopId;
  return {
    kind: "walk",
    title: `${fromPlace.displayName}에서 ${stopName}까지 도보`,
    startMinutes,
    endMinutes,
    fromLabel: fromPlace.displayName,
    toLabel: stopName,
    toStopId,
  };
}

function createTransferWalkLeg(
  fromStop: StopContext | undefined,
  toStop: StopContext | undefined,
  fromStopId: string,
  toStopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const fromStopName = fromStop?.displayName ?? fromStopId;
  const toStopName = toStop?.displayName ?? toStopId;
  return {
    kind: "walk",
    title: `${fromStopName}에서 ${toStopName}까지 환승 도보`,
    startMinutes,
    endMinutes,
    fromLabel: fromStopName,
    toLabel: toStopName,
    fromStopId,
    toStopId,
  };
}

function createEgressWalkLeg(
  fromStop: StopContext | undefined,
  fromStopId: string,
  toPlace: PlaceContext,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  const stopName = fromStop?.displayName ?? fromStopId;
  return {
    kind: "walk",
    title: `${stopName}에서 ${toPlace.displayName}까지 도보`,
    startMinutes,
    endMinutes,
    fromLabel: stopName,
    toLabel: toPlace.displayName,
    fromStopId,
  };
}

function createWaitLeg(
  stopName: string,
  stopId: string,
  startMinutes: number,
  endMinutes: number,
): DraftLeg {
  return {
    kind: "wait",
    title: `${stopName}에서 버스 대기`,
    startMinutes,
    endMinutes,
    fromLabel: stopName,
    toLabel: stopName,
    fromStopId: stopId,
    toStopId: stopId,
  };
}

function createRideLeg(
  trip: TripContext,
  boardStopTime: TripStopContext,
  alightStopTime: TripStopContext,
  estimated: boolean,
): DraftLeg {
  return {
    kind: "ride",
    title: `${trip.routeShortName}번 탑승`,
    subtitle: `${boardStopTime.stopName} → ${alightStopTime.stopName}`,
    startMinutes: boardStopTime.departureMinutes,
    endMinutes: alightStopTime.arrivalMinutes,
    fromLabel: boardStopTime.stopName,
    toLabel: alightStopTime.stopName,
    routeShortName: trip.routeShortName,
    routePatternId: trip.routePatternId,
    tripId: trip.id,
    fromStopId: boardStopTime.stopId,
    toStopId: alightStopTime.stopId,
    estimated,
  };
}

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

  if (left.usesEstimatedStopTimes !== right.usesEstimatedStopTimes) {
    return Number(left.usesEstimatedStopTimes) - Number(right.usesEstimatedStopTimes);
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

  if (left.usesEstimatedStopTimes !== right.usesEstimatedStopTimes) {
    return Number(left.usesEstimatedStopTimes) - Number(right.usesEstimatedStopTimes);
  }

  if (left.realtimeEligible !== right.realtimeEligible) {
    return left.realtimeEligible ? -1 : 1;
  }

  return left.legs.length - right.legs.length;
}

function dominatesSegmentOption(left: SegmentOption, right: SegmentOption) {
  const leftRealtimePenalty = left.realtimeEligible ? 0 : 1;
  const rightRealtimePenalty = right.realtimeEligible ? 0 : 1;
  const leftEstimatedPenalty = left.usesEstimatedStopTimes ? 1 : 0;
  const rightEstimatedPenalty = right.usesEstimatedStopTimes ? 1 : 0;

  const noWorse =
    left.arrivalMinutes <= right.arrivalMinutes &&
    left.walkMinutes <= right.walkMinutes &&
    left.transfers <= right.transfers &&
    left.safetyBufferCost <= right.safetyBufferCost &&
    leftEstimatedPenalty <= rightEstimatedPenalty &&
    leftRealtimePenalty <= rightRealtimePenalty;

  const strictlyBetter =
    left.arrivalMinutes < right.arrivalMinutes ||
    left.walkMinutes < right.walkMinutes ||
    left.transfers < right.transfers ||
    left.safetyBufferCost < right.safetyBufferCost ||
    leftEstimatedPenalty < rightEstimatedPenalty ||
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

  if (left.metrics.usesEstimatedStopTimes !== right.metrics.usesEstimatedStopTimes) {
    return Number(left.metrics.usesEstimatedStopTimes) - Number(right.metrics.usesEstimatedStopTimes);
  }

  if (left.metrics.realtimeEligible !== right.metrics.realtimeEligible) {
    return left.metrics.realtimeEligible ? -1 : 1;
  }

  return left.legs.length - right.legs.length;
}

function dominatesPartialItinerary(left: PartialItinerary, right: PartialItinerary) {
  const leftRealtimePenalty = left.metrics.realtimeEligible ? 0 : 1;
  const rightRealtimePenalty = right.metrics.realtimeEligible ? 0 : 1;
  const leftEstimatedPenalty = left.metrics.usesEstimatedStopTimes ? 1 : 0;
  const rightEstimatedPenalty = right.metrics.usesEstimatedStopTimes ? 1 : 0;

  const noWorse =
    left.currentMinutes <= right.currentMinutes &&
    left.metrics.totalWalkMinutes <= right.metrics.totalWalkMinutes &&
    left.metrics.transfers <= right.metrics.transfers &&
    left.metrics.safetyBufferCost <= right.metrics.safetyBufferCost &&
    leftEstimatedPenalty <= rightEstimatedPenalty &&
    leftRealtimePenalty <= rightRealtimePenalty;

  const strictlyBetter =
    left.currentMinutes < right.currentMinutes ||
    left.metrics.totalWalkMinutes < right.metrics.totalWalkMinutes ||
    left.metrics.transfers < right.metrics.transfers ||
    left.metrics.safetyBufferCost < right.metrics.safetyBufferCost ||
    leftEstimatedPenalty < rightEstimatedPenalty ||
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
    const next = groupedTrips.get(trip.routePatternId) ?? [];
    next.push(trip);
    groupedTrips.set(trip.routePatternId, next);
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
      const candidate: StopLabel = {
        stopId: transfer.toStopId,
        arrivalMinutes: nextArrivalMinutes,
        walkMinutes: currentLabel.walkMinutes + transfer.durationMinutes,
        safetyBufferCost: currentLabel.safetyBufferCost,
        usesEstimatedStopTimes: currentLabel.usesEstimatedStopTimes,
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

    const estimated = tripUsesEstimated(
      activeBoard.trip,
      activeBoard.boardStopTime.sequence,
      alightStopTime.sequence,
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
      createRideLeg(activeBoard.trip, activeBoard.boardStopTime, alightStopTime, estimated),
    );

    const candidate: StopLabel = {
      stopId: alightStopTime.stopId,
      arrivalMinutes: alightStopTime.arrivalMinutes,
      walkMinutes: activeBoard.previousLabel.walkMinutes,
      safetyBufferCost:
        activeBoard.previousLabel.safetyBufferCost +
        (round === 1 ? FIRST_BOARD_BUFFER : TRANSFER_BUFFER) +
        (estimated ? ESTIMATED_BUFFER : 0),
      usesEstimatedStopTimes: activeBoard.previousLabel.usesEstimatedStopTimes || estimated,
      realtimeEligible:
        activeBoard.previousLabel.realtimeEligible ||
        context.realtimePatternIds.has(activeBoard.trip.routePatternId),
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
    const option: SegmentOption = {
      signature: `${label.signature}|egress:${egress.fromStopId}:${toPlace.id}`,
      arrivalMinutes,
      walkMinutes: label.walkMinutes + egress.durationMinutes,
      transfers: Math.max(0, ridesUsed - 1),
      usesEstimatedStopTimes: label.usesEstimatedStopTimes,
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
      walkMinutes: access.durationMinutes,
      safetyBufferCost: 0,
      usesEstimatedStopTimes: false,
      realtimeEligible: false,
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
        usesEstimatedStopTimes: false,
        safetyBufferCost: 0,
        realtimeEligible: false,
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
        metrics: partial.metrics,
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
        nextFrontier.push({
          signature: `${visitedPartial.signature}|${option.signature}`,
          currentMinutes: option.arrivalMinutes,
          metrics: {
            totalWalkMinutes: visitedPartial.metrics.totalWalkMinutes + option.walkMinutes,
            transfers: visitedPartial.metrics.transfers + option.transfers,
            usesEstimatedStopTimes:
              visitedPartial.metrics.usesEstimatedStopTimes || option.usesEstimatedStopTimes,
            safetyBufferCost: visitedPartial.metrics.safetyBufferCost + option.safetyBufferCost,
            realtimeEligible:
              visitedPartial.metrics.realtimeEligible || option.realtimeEligible,
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
