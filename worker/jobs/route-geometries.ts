import { GeometrySourceKind } from "@prisma/client";
import {
  geoPointToCoordinate,
  geometryLengthMeters,
  projectPointOntoPolyline,
  samplePolyline,
  type GeoPoint,
} from "@/lib/geometry";
import {
  loadGtfsTextSet as loadGtfsTextSetFromSource,
  parseGtfsRows,
  probeGtfsSource,
} from "@/lib/gtfs";
import { matchTraceGeometry, getRouteGeometry } from "@/lib/osrm";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { fetchBusJejuLinkInfo } from "@/worker/jobs/bus-jeju-live";
import {
  chooseBestPatternMatch,
  type MatchableRoutePattern,
} from "@/worker/jobs/schedule-pattern-matching";
import type { JobOutcome } from "@/worker/jobs/types";

type GtfsRouteRow = {
  route_id: string;
  route_short_name?: string;
  route_long_name?: string;
};

type GtfsTripRow = {
  route_id: string;
  trip_id: string;
  trip_headsign?: string;
  direction_id?: string;
  shape_id?: string;
};

type GtfsStopTimeRow = {
  trip_id: string;
  stop_id: string;
  stop_sequence: string;
};

type GtfsStopRow = {
  stop_id: string;
  stop_name?: string;
};

type GtfsShapeRow = {
  shape_id: string;
  shape_pt_lat: string;
  shape_pt_lon: string;
  shape_pt_sequence: string;
};

type GtfsShapeCandidate = MatchableRoutePattern & {
  shapeId: string;
  geometry: GeoPoint[];
};

function parseBusJejuLinkGeometry(
  rows: Array<{
    localX: string | number;
    localY: string | number;
  }>,
) {
  const geometry: GeoPoint[] = [];

  for (const row of rows) {
    const longitude = Number(row.localX);
    const latitude = Number(row.localY);
    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      continue;
    }

    const point: GeoPoint = [longitude, latitude];
    const previous = geometry[geometry.length - 1];
    if (!previous || previous[0] !== point[0] || previous[1] !== point[1]) {
      geometry.push(point);
    }
  }

  return geometry;
}

async function loadRuntimeGtfsTextSet(runtime: WorkerRuntime) {
  const source = runtime.env.gtfsFeedUrl.trim() || runtime.env.gtfsShapesPath.trim();
  if (!source) {
    return null;
  }

  return loadGtfsTextSetFromSource(source);
}

async function loadGtfsCandidates(runtime: WorkerRuntime) {
  const textSet = await loadRuntimeGtfsTextSet(runtime);
  if (
    !textSet ||
    !textSet.routes ||
    !textSet.trips ||
    !textSet.stopTimes ||
    !textSet.stops ||
    !textSet.shapes
  ) {
    return {
      source: textSet?.source ?? null,
      candidatesByShortName: new Map<string, GtfsShapeCandidate[]>(),
    };
  }

  const routes = parseGtfsRows<GtfsRouteRow>(textSet.routes);
  const trips = parseGtfsRows<GtfsTripRow>(textSet.trips);
  const stopTimes = parseGtfsRows<GtfsStopTimeRow>(textSet.stopTimes);
  const stops = parseGtfsRows<GtfsStopRow>(textSet.stops);
  const shapes = parseGtfsRows<GtfsShapeRow>(textSet.shapes);

  const routesById = new Map(routes.map((route) => [route.route_id, route]));
  const stopsById = new Map(stops.map((stop) => [stop.stop_id, stop]));
  const stopTimesByTripId = new Map<string, GtfsStopTimeRow[]>();
  const shapesById = new Map<string, GeoPoint[]>();

  for (const row of stopTimes) {
    const next = stopTimesByTripId.get(row.trip_id) ?? [];
    next.push(row);
    stopTimesByTripId.set(row.trip_id, next);
  }

  for (const row of shapes) {
    const latitude = Number(row.shape_pt_lat);
    const longitude = Number(row.shape_pt_lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const next = shapesById.get(row.shape_id) ?? [];
    next.push([longitude, latitude]);
    shapesById.set(row.shape_id, next);
  }

  const candidates = new Map<string, GtfsShapeCandidate>();

  for (const trip of trips) {
    if (!trip.shape_id) {
      continue;
    }

    const route = routesById.get(trip.route_id);
    const shortName = route?.route_short_name?.trim() || route?.route_long_name?.trim();
    const shapeGeometry = shapesById.get(trip.shape_id) ?? [];
    const tripStops = (stopTimesByTripId.get(trip.trip_id) ?? [])
      .sort((left, right) => Number(left.stop_sequence) - Number(right.stop_sequence))
      .map((row) => ({
        stopId: row.stop_id,
        sequence: Number(row.stop_sequence),
        displayName: stopsById.get(row.stop_id)?.stop_name?.trim() || row.stop_id,
        translations: [] as string[],
      }));

    if (!shortName || tripStops.length < 2 || shapeGeometry.length < 2) {
      continue;
    }

    const key = `${shortName}:${trip.shape_id}:${trip.direction_id ?? ""}`;
    if (candidates.has(key)) {
      continue;
    }

    candidates.set(key, {
      id: key,
      shortName,
      displayName: route?.route_long_name?.trim() || shortName,
      directionLabel: trip.trip_headsign?.trim() || trip.direction_id?.trim() || null,
      stops: tripStops,
      shapeId: trip.shape_id,
      geometry: shapeGeometry,
    });
  }

  const candidatesByShortName = new Map<string, GtfsShapeCandidate[]>();
  for (const candidate of candidates.values()) {
    const keys = [
      candidate.shortName.trim(),
      candidate.shortName.split("-")[0]?.trim(),
    ].filter(Boolean) as string[];

    for (const key of keys) {
      const next = candidatesByShortName.get(key) ?? [];
      next.push(candidate);
      candidatesByShortName.set(key, next);
    }
  }

  return {
    source: textSet.source,
    candidatesByShortName,
  };
}

async function buildMatchedGeometry(
  runtime: WorkerRuntime,
  geometry: GeoPoint[],
) {
  if (!runtime.env.osrmBusDistanceBaseUrl || geometry.length < 2) {
    return null;
  }

  try {
    const matches = await matchTraceGeometry(
      runtime.env.osrmBusDistanceBaseUrl,
      "driving",
      samplePolyline(geometry, 80).map(geoPointToCoordinate),
    );
    const best = matches.sort((left, right) => right.confidence - left.confidence)[0];

    if (!best || best.confidence < 0.8 || best.geometry.length < 2) {
      return null;
    }

    return {
      geometry: best.geometry,
      confidence: best.confidence,
      lengthMeters: best.distanceMeters,
      durationSeconds: best.durationSeconds,
      nodes: best.nodes,
    };
  } catch {
    return null;
  }
}

function buildProjectionRecords(
  routePatternId: string,
  sourceKind: GeometrySourceKind,
  baseConfidence: number,
  stops: Array<{
    stopId: string;
    sequence: number;
    stop: {
      latitude: number;
      longitude: number;
    };
  }>,
  geometry: GeoPoint[],
) {
  const projections = [];
  let previousOffset = 0;

  for (const stop of stops) {
    const projection = projectPointOntoPolyline(
      {
        latitude: stop.stop.latitude,
        longitude: stop.stop.longitude,
      },
      geometry,
    );

    if (!projection) {
      return null;
    }

    const offsetMeters = Math.max(previousOffset, projection.offsetMeters);
    previousOffset = offsetMeters;
    const confidence = Math.max(
      0.1,
      Math.min(1, baseConfidence * Math.max(0.2, 1 - projection.distanceMeters / 400)),
    );

    projections.push({
      routePatternId,
      stopId: stop.stopId,
      sequence: stop.sequence,
      offsetMeters,
      snapDistanceMeters: projection.distanceMeters,
      sourceKind,
      confidence,
    });
  }

  return projections;
}

export async function runRouteGeometriesJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const configuredGtfsSource =
    runtime.env.gtfsFeedUrl.trim() || runtime.env.gtfsShapesPath.trim() || null;
  let gtfs: {
    source: string | null;
    candidatesByShortName: Map<string, GtfsShapeCandidate[]>;
  } = {
    source: configuredGtfsSource ?? null,
    candidatesByShortName: new Map<string, GtfsShapeCandidate[]>(),
  };
  let gtfsProbe: Awaited<ReturnType<typeof probeGtfsSource>> | null = null;
  let gtfsLoadError: string | null = null;

  if (configuredGtfsSource) {
    try {
      gtfs = await loadGtfsCandidates(runtime);
      gtfsProbe = await probeGtfsSource(configuredGtfsSource);
    } catch (error) {
      gtfsLoadError = error instanceof Error ? error.message : "Unknown GTFS load error";
    }
  }
  const routePatterns = await runtime.prisma.routePattern.findMany({
    where: {
      isActive: true,
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

  let successCount = 0;
  let failureCount = 0;
  let busJejuLinkCount = 0;
  let gtfsMatchCount = 0;
  let fallbackCount = 0;

  for (const pattern of routePatterns) {
    const stopNames = pattern.stops.map((item) => item.stop.displayName);
    const gtfsCandidates = [
      ...(gtfs.candidatesByShortName.get(pattern.route.shortName) ?? []),
      ...(gtfs.candidatesByShortName.get(pattern.route.shortName.split("-")[0] ?? "") ?? []),
    ];

    const gtfsMatch =
      gtfsCandidates.length > 0
        ? chooseBestPatternMatch(
            {
              stopNames,
            },
            gtfsCandidates,
          )
        : null;

    let sourceKind: GeometrySourceKind = GeometrySourceKind.OSRM_DERIVED;
    let shapeRef: string | null = null;
    let confidence = 0.6;
    let geometry: GeoPoint[] = [];
    let lengthMeters = 0;
    let durationSeconds = 0;
    let nodes: number[] = [];

    if (pattern.externalRouteId) {
      try {
        const linkRows = await fetchBusJejuLinkInfo(runtime, pattern.externalRouteId);
        const linkGeometry = parseBusJejuLinkGeometry(linkRows);
        if (linkGeometry.length >= 2) {
          const matchedGeometry = await buildMatchedGeometry(runtime, linkGeometry);
          sourceKind = GeometrySourceKind.BUS_JEJU_LINK;
          shapeRef = String(pattern.externalRouteId);
          confidence = matchedGeometry?.confidence ?? 0.95;
          geometry = matchedGeometry?.geometry ?? linkGeometry;
          lengthMeters = matchedGeometry?.lengthMeters ?? geometryLengthMeters(geometry);
          durationSeconds = matchedGeometry?.durationSeconds ?? 0;
          nodes = matchedGeometry?.nodes ?? [];
          busJejuLinkCount += 1;
        }
      } catch {
        // Fall through to GTFS or OSRM-derived geometry.
      }
    }

    if (gtfsMatch) {
      const candidate = gtfsCandidates.find((item) => item.id === gtfsMatch.patternId);
      if (candidate && geometry.length < 2) {
        const matchedGeometry = await buildMatchedGeometry(runtime, candidate.geometry);
        sourceKind = GeometrySourceKind.GTFS;
        shapeRef = candidate.shapeId;
        confidence = matchedGeometry?.confidence ?? Math.max(0.8, gtfsMatch.coverageRatio);
        geometry = matchedGeometry?.geometry ?? candidate.geometry;
        lengthMeters = matchedGeometry?.lengthMeters ?? geometryLengthMeters(geometry);
        durationSeconds = matchedGeometry?.durationSeconds ?? 0;
        nodes = matchedGeometry?.nodes ?? [];
        gtfsMatchCount += 1;
      }
    }

    if (geometry.length < 2) {
      try {
        const route = await getRouteGeometry(
          runtime.env.osrmBusDistanceBaseUrl,
          "driving",
          pattern.stops
            .filter((item) => item.stop.latitude !== 0 || item.stop.longitude !== 0)
            .map((item) => ({
              latitude: item.stop.latitude,
              longitude: item.stop.longitude,
            })),
        );
        geometry = route.geometry;
        lengthMeters = route.distanceMeters;
        durationSeconds = route.durationSeconds;
        nodes = route.nodes;
        sourceKind = GeometrySourceKind.OSRM_DERIVED;
        confidence = 0.6;
        fallbackCount += 1;
      } catch {
        failureCount += 1;
        continue;
      }
    }

    const projections = buildProjectionRecords(
      pattern.id,
      sourceKind,
      confidence,
      pattern.stops,
      geometry,
    );

    if (!projections) {
      failureCount += 1;
      continue;
    }

    await runtime.prisma.routePatternGeometry.upsert({
      where: {
        routePatternId: pattern.id,
      },
      update: {
        sourceKind,
        shapeRef,
        geometry: {
          type: "LineString",
          coordinates: geometry,
          durationSeconds,
          nodes,
        },
        lengthMeters,
        confidence,
      },
      create: {
        routePatternId: pattern.id,
        sourceKind,
        shapeRef,
        geometry: {
          type: "LineString",
          coordinates: geometry,
          durationSeconds,
          nodes,
        },
        lengthMeters,
        confidence,
      },
    });

    await runtime.prisma.routePatternStopProjection.deleteMany({
      where: {
        routePatternId: pattern.id,
      },
    });
    await runtime.prisma.routePatternStopProjection.createMany({
      data: projections,
    });

    for (const projection of projections) {
      await runtime.prisma.routePatternStop.updateMany({
        where: {
          routePatternId: pattern.id,
          sequence: projection.sequence,
        },
        data: {
          distanceFromStart: projection.offsetMeters,
        },
      });
    }

    successCount += 1;
  }

  return {
    processedCount: routePatterns.length,
    successCount,
    failureCount,
    meta: {
      gtfsSource: gtfs.source,
      gtfsConfigured: Boolean(configuredGtfsSource),
      gtfsProbe,
      gtfsLoadError,
      busJejuLinkCount,
      gtfsMatchCount,
      fallbackCount,
    },
  };
}
