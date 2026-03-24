import { getWalkRoute, haversineMeters } from "@/lib/osrm";
import { RouteNotFoundError } from "@/lib/errors";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const MAX_PLACE_STOP_DISTANCE = 900;
const MAX_STOP_STOP_DISTANCE = 800;
const MAX_PLACE_STOP_LINKS = 3;

async function measureWalk(
  runtime: WorkerRuntime,
  from: { latitude: number; longitude: number },
  to: { latitude: number; longitude: number },
) {
  return getWalkRoute(runtime.env.osrmBaseUrl, from, to);
}

export async function runWalkLinksJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const [places, stops] = await Promise.all([
    runtime.prisma.place.findMany({
      where: {
        sourceContentId: {
          not: null,
        },
      },
    }),
    runtime.prisma.stop.findMany({
      where: {
        OR: [{ latitude: { not: 0 } }, { longitude: { not: 0 } }],
      },
    }),
  ]);

  await runtime.prisma.walkLink.deleteMany();

  const links: Array<{
    kind: string;
    fromPlaceId?: string;
    toPlaceId?: string;
    fromStopId?: string;
    toStopId?: string;
    durationMinutes: number;
    distanceMeters: number;
    rank: number;
    isPrecomputed: boolean;
  }> = [];
  let skippedNoRouteCount = 0;

  for (const place of places) {
    const rankedStops = stops
      .map((stop) => ({
        stop,
        distanceMeters: haversineMeters(place, stop),
      }))
      .filter((item) => item.distanceMeters <= MAX_PLACE_STOP_DISTANCE)
      .sort((left, right) => left.distanceMeters - right.distanceMeters)
      .slice(0, MAX_PLACE_STOP_LINKS);

    for (const [index, item] of rankedStops.entries()) {
      let measured;
      try {
        measured = await measureWalk(runtime, place, item.stop);
      } catch (error) {
        if (error instanceof RouteNotFoundError) {
          skippedNoRouteCount += 1;
          continue;
        }

        throw error;
      }

      links.push({
        kind: "PLACE_STOP",
        fromPlaceId: place.id,
        toStopId: item.stop.id,
        durationMinutes: measured.durationMinutes,
        distanceMeters: measured.distanceMeters,
        rank: index + 1,
        isPrecomputed: true,
      });
      links.push({
        kind: "STOP_PLACE",
        fromStopId: item.stop.id,
        toPlaceId: place.id,
        durationMinutes: measured.durationMinutes,
        distanceMeters: measured.distanceMeters,
        rank: index + 1,
        isPrecomputed: true,
      });
    }
  }

  for (const fromStop of stops) {
    if (fromStop.latitude === 0 && fromStop.longitude === 0) {
      continue;
    }

    const rankedStops = stops
      .filter((toStop) => toStop.id !== fromStop.id)
      .map((toStop) => ({
        stop: toStop,
        distanceMeters: haversineMeters(fromStop, toStop),
      }))
      .filter((item) => item.distanceMeters <= MAX_STOP_STOP_DISTANCE)
      .sort((left, right) => left.distanceMeters - right.distanceMeters)
      .slice(0, 4);

    for (const [index, item] of rankedStops.entries()) {
      let measured;
      try {
        measured = await measureWalk(runtime, fromStop, item.stop);
      } catch (error) {
        if (error instanceof RouteNotFoundError) {
          skippedNoRouteCount += 1;
          continue;
        }

        throw error;
      }

      links.push({
        kind: "STOP_STOP",
        fromStopId: fromStop.id,
        toStopId: item.stop.id,
        durationMinutes: measured.durationMinutes,
        distanceMeters: measured.distanceMeters,
        rank: index + 1,
        isPrecomputed: true,
      });
    }
  }

  if (links.length > 0) {
    await runtime.prisma.walkLink.createMany({
      data: links,
    });
  }

  return {
    processedCount: links.length,
    successCount: links.length,
    failureCount: 0,
    meta: {
      places: places.length,
      stops: stops.length,
      skippedNoRouteCount,
    },
  };
}
