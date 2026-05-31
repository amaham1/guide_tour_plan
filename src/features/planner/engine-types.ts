import type { CandidateLeg, CandidateMetrics, CandidateTimeReliability } from "@/features/planner/types";

export type PlaceContext = {
  id: string;
  displayName: string;
  regionName: string;
  latitude: number;
  longitude: number;
  openingHoursRaw: string | null;
  openingHoursJson: unknown;
};

export type StopContext = {
  id: string;
  displayName: string;
  latitude: number;
  longitude: number;
};

export type WalkLinkContext = {
  kind: string;
  fromPlaceId: string | null;
  toPlaceId: string | null;
  fromStopId: string | null;
  toStopId: string | null;
  durationMinutes: number;
  distanceMeters: number;
  rank: number;
};

export type TripStopContext = {
  stopId: string;
  stopName: string;
  sequence: number;
  arrivalMinutes: number;
  departureMinutes: number;
  timeReliability: CandidateTimeReliability;
  windowStartMinutes: number | null;
  windowEndMinutes: number | null;
  isEstimated?: boolean;
};

export type TripContext = {
  id: string;
  routingKey?: string;
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

export type DraftLeg = Omit<
  CandidateLeg,
  "id" | "startAt" | "endAt" | "durationMinutes" | "startWindowAt" | "endWindowAt"
> & {
  startMinutes: number;
  endMinutes: number;
  startWindowAt?: number | null;
  endWindowAt?: number | null;
};

export type SegmentOption = {
  signature: string;
  arrivalMinutes: number;
  arrivalWindowStartMinutes: number | null;
  arrivalWindowEndMinutes: number | null;
  walkMinutes: number;
  transfers: number;
  worstTimeReliability: CandidateTimeReliability;
  roughWindowMinutes: number;
  safetyBufferCost: number;
  realtimeEligible: boolean;
  legs: DraftLeg[];
};

export type ItineraryDraft = {
  signature: string;
  metrics: CandidateMetrics;
  legs: DraftLeg[];
};

export type RouteContext = {
  id: string;
  stopIds: string[];
  trips: TripContext[];
};

export type RoutingIndex = {
  routesById: Map<string, RouteContext>;
  routesByStopId: Map<string, Array<{ routeId: string; stopIndex: number }>>;
};

export type StopLabel = {
  stopId: string;
  arrivalMinutes: number;
  arrivalWindowStartMinutes: number | null;
  arrivalWindowEndMinutes: number | null;
  walkMinutes: number;
  safetyBufferCost: number;
  worstTimeReliability: CandidateTimeReliability;
  roughWindowMinutes: number;
  realtimeEligible: boolean;
  signature: string;
  legs: DraftLeg[];
};

export type PartialMetrics = Omit<CandidateMetrics, "totalDurationMinutes" | "finalArrivalMinutes">;

export type PartialItinerary = {
  signature: string;
  currentMinutes: number;
  metrics: PartialMetrics;
  legs: DraftLeg[];
};

export type QueueEntry = {
  stopId: string;
  arrivalMinutes: number;
  walkMinutes: number;
};
