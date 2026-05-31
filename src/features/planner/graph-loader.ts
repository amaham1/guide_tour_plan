import type { PrismaClient } from "@prisma/client";
import { appEnv } from "@/lib/env";
import { RouteNotFoundError } from "@/lib/errors";
import { getWalkRoute, haversineMeters } from "@/lib/osrm";
import type { PlannerGraphContext } from "@/features/planner/engine";
import type { CandidateTimeReliability, TimeReliabilityMode } from "@/features/planner/types";
import type { PlannerAnchor } from "@/features/planner/anchors";
import {
  choosePreferredDerivedStopTimes,
  getAllowedDerivedTimeSources,
} from "@/features/planner/reliability-policy";

type DynamicStopLink = {
  stopId: string;
  durationMinutes: number;
  distanceMeters: number;
};

const PLACE_STOP_PREFILTER_LIMIT = 24;
const PLACE_STOP_LIMIT = 12;
const MAX_NEARBY_STOP_DISTANCE_METERS = 3_000;

function isUsableSparseOfficialTrip(
  patternStops: Array<{ sequence: number; stop: { id: string } }>,
  trip: {
    scheduleSource: { isActive: boolean } | null;
    stopTimes: Array<{ stopId: string; sequence: number; isEstimated: boolean }>;
  },
) {
  if (!trip.scheduleSource?.isActive || trip.stopTimes.length < 2) {
    return false;
  }

  const patternStopBySequence = new Map(
    patternStops.map((patternStop) => [patternStop.sequence, patternStop.stop.id]),
  );

  return trip.stopTimes.every((stopTime, index) => {
    const expectedStopId = patternStopBySequence.get(stopTime.sequence);
    const previousStopTime = index > 0 ? trip.stopTimes[index - 1] : null;
    return (
      !stopTime.isEstimated &&
      expectedStopId === stopTime.stopId &&
      (previousStopTime === null || stopTime.sequence > previousStopTime.sequence)
    );
  });
}

function isUsableGeneratedStopTimes(
  patternStops: Array<{ sequence: number; stop: { id: string } }>,
  stopTimes: Array<{ stopId: string; sequence: number }>,
) {
  const patternStopBySequence = new Map(
    patternStops.map((patternStop) => [patternStop.sequence, patternStop.stop.id]),
  );

  return stopTimes.every((stopTime, index) => {
    const expectedStopId = patternStopBySequence.get(stopTime.sequence);
    const previousStopTime = index > 0 ? stopTimes[index - 1] : null;
    return (
      expectedStopId === stopTime.stopId &&
      (previousStopTime === null || stopTime.sequence > previousStopTime.sequence)
    );
  });
}

function buildTripRoutingKey(
  routePatternId: string,
  stopTimes: Array<{ stopId: string; sequence: number }>,
) {
  return `${routePatternId}:stops:${stopTimes
    .map((stopTime) => `${stopTime.stopId}:${stopTime.sequence}`)
    .join(">")}`;
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
    candidates.map(async ({ stop }) => {
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
      } catch (error) {
        if (error instanceof RouteNotFoundError) {
          return null;
        }

        throw error;
      }
    }),
  );

  const reachableLinks = measured.filter((link): link is DynamicStopLink => link !== null);
  if (reachableLinks.length === 0) {
    throw new RouteNotFoundError(
      `${anchor.displayName} 근처에서 버스로 연결 가능한 정류장을 찾지 못했습니다.`,
    );
  }

  return reachableLinks
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

export async function loadPlannerGraph(
  prisma: PrismaClient,
  anchors: PlannerAnchor[],
  timeReliabilityMode: TimeReliabilityMode,
): Promise<PlannerGraphContext> {
  const [stops, stopTransfers, patterns] = await Promise.all([
    prisma.stop.findMany(),
    prisma.walkLink.findMany({
      where: {
        kind: "STOP_STOP",
      },
    }),
    prisma.routePattern.findMany({
      where: {
        isActive: true,
        route: {
          isActive: true,
        },
        trips: {
          some: {
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
            stopTimes: {
              some: {},
            },
          },
        },
      },
      include: {
        route: true,
        stops: {
          orderBy: {
            sequence: "asc",
          },
          include: {
            stop: true,
          },
        },
        trips: {
          where: {
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
            stopTimes: {
              some: {},
            },
          },
          include: {
            scheduleSource: {
              select: {
                isActive: true,
              },
            },
            stopTimes: {
              orderBy: {
                sequence: "asc",
              },
              include: {
                stop: true,
              },
            },
            derivedStopTimes: {
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
  const allowedDerivedTimeSources = getAllowedDerivedTimeSources(timeReliabilityMode);

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
  const trips = patterns.flatMap((pattern) =>
    pattern.trips.flatMap((trip) => {
      if (!isUsableSparseOfficialTrip(pattern.stops, trip)) {
        return [];
      }

      const mergedStopTimes = new Map<
        number,
        {
          stopId: string;
          stopName: string;
          sequence: number;
          arrivalMinutes: number;
          departureMinutes: number;
          timeReliability: CandidateTimeReliability;
          windowStartMinutes: number | null;
          windowEndMinutes: number | null;
        }
      >();

      for (const stopTime of trip.stopTimes) {
        mergedStopTimes.set(stopTime.sequence, {
          stopId: stopTime.stopId,
          stopName: stopTime.stop.displayName,
          sequence: stopTime.sequence,
          arrivalMinutes: stopTime.arrivalMinutes,
          departureMinutes: stopTime.departureMinutes,
          timeReliability: "OFFICIAL",
          windowStartMinutes: null,
          windowEndMinutes: null,
        });
      }

      const allowedDerivedStopTimes = trip.derivedStopTimes.filter((stopTime) =>
        allowedDerivedTimeSources.has(stopTime.timeSource),
      );
      const preferredDerivedStopTimes = choosePreferredDerivedStopTimes(allowedDerivedStopTimes);
      const usableDerivedStopTimes =
        allowedDerivedTimeSources.size > 0 &&
        preferredDerivedStopTimes.length > 0 &&
        isUsableGeneratedStopTimes(pattern.stops, preferredDerivedStopTimes);

      if (usableDerivedStopTimes) {
        for (const stopTime of preferredDerivedStopTimes) {
          if (!allowedDerivedTimeSources.has(stopTime.timeSource)) {
            continue;
          }

          if (mergedStopTimes.has(stopTime.sequence)) {
            continue;
          }

          mergedStopTimes.set(stopTime.sequence, {
            stopId: stopTime.stopId,
            stopName: stopTime.stop.displayName,
            sequence: stopTime.sequence,
            arrivalMinutes: stopTime.arrivalMinutes,
            departureMinutes: stopTime.departureMinutes,
            timeReliability:
              stopTime.timeSource === "DISTANCE_INTERPOLATED" ? "ROUGH" : "ESTIMATED",
            windowStartMinutes: stopTime.windowStartMinutes,
            windowEndMinutes: stopTime.windowEndMinutes,
          });
        }
      } else if (allowedDerivedStopTimes.length > 0) {
        console.warn("Skipped invalid derived stop times while loading planner graph", {
          tripId: trip.id,
          routePatternId: pattern.id,
          derivedStopTimeCount: allowedDerivedStopTimes.length,
        });
      }

      const normalizedStopTimes = [...mergedStopTimes.values()].sort(
        (left, right) => left.sequence - right.sequence,
      );

      if (normalizedStopTimes.length < 2) {
        return [];
      }

      return [
        {
          id: trip.id,
          routingKey: buildTripRoutingKey(pattern.id, normalizedStopTimes),
          routePatternId: pattern.id,
          routeShortName: pattern.route.shortName,
          routeDisplayName: pattern.route.displayName,
          headsign: trip.headsign,
          stopTimes: normalizedStopTimes,
          stopTimeByStopId: new Map(
            normalizedStopTimes.map((stopTime) => [stopTime.stopId, stopTime]),
          ),
        },
      ];
    }),
  );

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
