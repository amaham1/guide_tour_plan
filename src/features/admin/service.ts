import { db } from "@/lib/db";
import { syncSourceCatalog } from "@/lib/source-catalog";
import { getPlannerCatalogStatus } from "@/features/planner/catalog";

export async function getAdminDashboard() {
  await syncSourceCatalog(db);

  const [
    catalogStatus,
    sources,
    jobs,
    runs,
    places,
    patterns,
    vehicleMaps,
    segmentProfileCount,
    latestCustomizeJob,
    latestRouteGeometryRun,
  ] = await Promise.all([
    getPlannerCatalogStatus(db),
    db.dataSource.findMany({
      orderBy: {
        key: "asc",
      },
    }),
    db.ingestJob.findMany({
      include: {
        source: true,
      },
      orderBy: {
        key: "asc",
      },
    }),
    db.ingestRun.findMany({
      include: {
        job: true,
      },
      orderBy: {
        startedAt: "desc",
      },
      take: 20,
    }),
    db.place.findMany({
      include: {
        walkFromLinks: true,
        walkToLinks: true,
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 30,
    }),
    db.routePattern.findMany({
      where: {
        scheduleId: {
          not: null,
        },
      },
      include: {
        route: true,
        geometry: true,
        stopProjections: {
          orderBy: {
            sequence: "asc",
          },
        },
        stops: {
          include: {
            stop: true,
          },
          orderBy: {
            sequence: "asc",
          },
        },
        trips: {
          include: {
            stopTimes: true,
          },
        },
        vehicleDeviceMap: true,
      },
      orderBy: {
        displayName: "asc",
      },
      take: 30,
    }),
    db.vehicleDeviceMap.findMany(),
    db.segmentTravelProfile.count(),
    db.ingestJob.findUnique({
      where: {
        key: "osrm-bus-customize",
      },
      select: {
        lastSuccessfulAt: true,
      },
    }),
    db.ingestRun.findFirst({
      where: {
        job: {
          key: "route-geometries",
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      select: {
        startedAt: true,
        endedAt: true,
        meta: true,
      },
    }),
  ]);

  const poiJoinExceptions = places
    .filter((place) => place.walkFromLinks.length === 0 || place.walkToLinks.length === 0)
    .map((place) => ({
      id: place.id,
      displayName: place.baseDisplayName,
      accessLinks: place.walkFromLinks.length,
      egressLinks: place.walkToLinks.length,
    }));

  const routePatternReview = patterns.map((pattern) => {
    const stopCount = pattern.stops.length;
    const unresolvedStopCount = pattern.stops.filter(
      (stop) => stop.stop.latitude === 0 && stop.stop.longitude === 0,
    ).length;
    const sequenceOk = pattern.stops.every(
      (stop, index) => stop.sequence === index + 1,
    );
    const distanceMonotonic = pattern.stops.every((stop, index, list) =>
      index === 0
        ? true
        : stop.distanceFromStart >= list[index - 1].distanceFromStart,
    );

    return {
      id: pattern.id,
      label: `${pattern.route.shortName} ${pattern.directionLabel}`,
      stopCount,
      tripCount: pattern.trips.length,
      sequenceOk,
      distanceMonotonic,
      placeholderStopCount: unresolvedStopCount,
      geometrySource: pattern.geometry?.sourceKind ?? null,
      geometryConfidence: pattern.geometry?.confidence ?? null,
      projectedStopCount: pattern.stopProjections.length,
      meanSnapDistance:
        pattern.stopProjections.length === 0
          ? null
          : Math.round(
              pattern.stopProjections.reduce((sum, item) => sum + item.snapDistanceMeters, 0) /
                pattern.stopProjections.length,
            ),
    };
  });

  const timetableReview = patterns.map((pattern) => ({
    id: pattern.id,
    label: `${pattern.route.shortName} ${pattern.directionLabel}`,
    tripCount: pattern.trips.length,
    estimatedStopTimeCount: pattern.trips.reduce(
      (sum, trip) => sum + trip.stopTimes.filter((stopTime) => stopTime.isEstimated).length,
      0,
    ),
    hasTrips: pattern.trips.length > 0,
  }));

  const latestVehicleMapRun = runs.find((run) => run.job.key === "vehicle-device-map");
  const routeGeometryMeta =
    latestRouteGeometryRun?.meta && typeof latestRouteGeometryRun.meta === "object"
      ? (latestRouteGeometryRun.meta as Record<string, unknown>)
      : null;

  return {
    catalogStatus,
    sources,
    jobs,
    runs,
    poiJoinExceptions,
    routePatternReview,
    timetableReview,
    vehicleMapStats: {
      totalPatterns: patterns.length,
      mappedPatterns: vehicleMaps.length,
      successRate:
        patterns.length === 0 ? 0 : Math.round((vehicleMaps.length / patterns.length) * 100),
      latestRunAt: latestVehicleMapRun?.endedAt ?? null,
    },
    geometryStats: {
      totalPatterns: patterns.length,
      geometryCoverage:
        patterns.length === 0
          ? 0
          : Math.round((patterns.filter((pattern) => pattern.geometry).length / patterns.length) * 100),
      projectionCoverage:
        patterns.length === 0
          ? 0
          : Math.round(
              (patterns.filter((pattern) => pattern.stopProjections.length === pattern.stops.length).length /
                patterns.length) *
                100,
            ),
      segmentProfileCount,
      latestCustomizeAt: latestCustomizeJob?.lastSuccessfulAt ?? null,
      latestRouteGeometryAt: latestRouteGeometryRun?.endedAt ?? latestRouteGeometryRun?.startedAt ?? null,
      gtfsConfigured: Boolean(routeGeometryMeta?.gtfsConfigured),
      gtfsSource: typeof routeGeometryMeta?.gtfsSource === "string" ? routeGeometryMeta.gtfsSource : null,
      gtfsMatchCount: typeof routeGeometryMeta?.gtfsMatchCount === "number" ? routeGeometryMeta.gtfsMatchCount : 0,
      fallbackCount: typeof routeGeometryMeta?.fallbackCount === "number" ? routeGeometryMeta.fallbackCount : 0,
      gtfsLoadError:
        typeof routeGeometryMeta?.gtfsLoadError === "string" ? routeGeometryMeta.gtfsLoadError : null,
      gtfsProbe:
        routeGeometryMeta?.gtfsProbe && typeof routeGeometryMeta.gtfsProbe === "object"
          ? (routeGeometryMeta.gtfsProbe as Record<string, unknown>)
          : null,
    },
  };
}
