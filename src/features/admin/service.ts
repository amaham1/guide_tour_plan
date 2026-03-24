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
  };
}
