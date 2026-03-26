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
    activeScheduleSourceCount,
    vehicleMaps,
    latestRouteGeometryRun,
    latestRoutesHtmlRun,
    latestTimetablesXlsxRun,
    zeroTripScheduleSourceCount,
    zeroTripScheduleSources,
  ] = await Promise.all([
    getPlannerCatalogStatus(db),
    db.dataSource.findMany({
      where: {
        isActive: true,
      },
      orderBy: {
        key: "asc",
      },
    }),
    db.ingestJob.findMany({
      where: {
        isActive: true,
      },
      include: {
        source: true,
      },
      orderBy: {
        key: "asc",
      },
    }),
    db.ingestRun.findMany({
      where: {
        job: {
          isActive: true,
        },
      },
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
        route: {
          isActive: true,
        },
        scheduleSources: {
          some: {
            isActive: true,
          },
        },
      },
      include: {
        route: true,
        scheduleSources: {
          where: {
            isActive: true,
          },
        },
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
          where: {
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
          },
          include: {
            stopTimes: true,
            derivedStopTimes: true,
            scheduleSource: {
              select: {
                isActive: true,
              },
            },
          },
        },
        vehicleDeviceMaps: true,
      },
      orderBy: {
        displayName: "asc",
      },
      take: 30,
    }),
    db.routePatternScheduleSource.count({
      where: {
        isActive: true,
        routePattern: {
          route: {
            isActive: true,
          },
        },
      },
    }),
    db.vehicleDeviceMap.findMany(),
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
    db.ingestRun.findFirst({
      where: {
        job: {
          key: "routes-html",
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      select: {
        status: true,
        startedAt: true,
        endedAt: true,
        meta: true,
      },
    }),
    db.ingestRun.findFirst({
      where: {
        job: {
          key: "timetables-xlsx",
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      select: {
        status: true,
        startedAt: true,
        endedAt: true,
        meta: true,
      },
    }),
    db.routePatternScheduleSource.count({
      where: {
        isActive: true,
        routePattern: {
          isActive: true,
          route: {
            isActive: true,
          },
        },
        trips: {
          none: {},
        },
      },
    }),
    db.routePatternScheduleSource.findMany({
      where: {
        isActive: true,
        routePattern: {
          isActive: true,
          route: {
            isActive: true,
          },
        },
        trips: {
          none: {},
        },
      },
      select: {
        id: true,
        scheduleId: true,
        variantKey: true,
        routePattern: {
          select: {
            id: true,
            displayName: true,
            directionLabel: true,
            route: {
              select: {
                shortName: true,
              },
            },
          },
        },
      },
      orderBy: [{ scheduleId: "asc" }, { variantKey: "asc" }],
      take: 8,
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
    const activeTrips = pattern.trips.filter((trip) => trip.scheduleSource?.isActive);
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
      tripCount: activeTrips.length,
      scheduleSourceCount: pattern.scheduleSources.length,
      officialStopTimeCount: activeTrips.reduce((sum, trip) => sum + trip.stopTimes.length, 0),
      generatedStopTimeCount: activeTrips.reduce(
        (sum, trip) => sum + trip.derivedStopTimes.length,
        0,
      ),
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

  const timetableReview = patterns.map((pattern) => {
    const activeTrips = pattern.trips.filter((trip) => trip.scheduleSource?.isActive);
    const officialStopTimeCount = activeTrips.reduce((sum, trip) => sum + trip.stopTimes.length, 0);
    const generatedStopTimeCount = activeTrips.reduce(
      (sum, trip) => sum + trip.derivedStopTimes.length,
      0,
    );

    return {
      id: pattern.id,
      label: `${pattern.route.shortName} ${pattern.directionLabel}`,
      tripCount: activeTrips.length,
      officialStopTimeCount,
      generatedStopTimeCount,
      hasTrips: activeTrips.length > 0,
      coverage:
        officialStopTimeCount > 0 && generatedStopTimeCount > 0
          ? "mixed"
          : generatedStopTimeCount > 0
            ? "generated_only"
            : officialStopTimeCount > 0
              ? "official"
              : "none",
    };
  });

  const latestVehicleMapRun = runs.find((run) => run.job.key === "vehicle-device-map");
  const routeGeometryMeta =
    latestRouteGeometryRun?.meta && typeof latestRouteGeometryRun.meta === "object"
      ? (latestRouteGeometryRun.meta as Record<string, unknown>)
      : null;
  const routesHtmlMeta =
    latestRoutesHtmlRun?.meta && typeof latestRoutesHtmlRun.meta === "object"
      ? (latestRoutesHtmlRun.meta as Record<string, unknown>)
      : null;
  const latestRoutesHtmlAt =
    latestRoutesHtmlRun?.endedAt ?? latestRoutesHtmlRun?.startedAt ?? null;
  const latestTimetablesXlsxAt =
    latestTimetablesXlsxRun?.endedAt ?? latestTimetablesXlsxRun?.startedAt ?? null;
  const timetableSyncStatus = !latestRoutesHtmlAt
    ? "idle"
    : latestTimetablesXlsxRun?.status === "RUNNING" &&
        latestTimetablesXlsxRun.startedAt >= latestRoutesHtmlAt
      ? "refreshing"
      : latestTimetablesXlsxRun?.status === "SUCCESS" &&
          latestTimetablesXlsxAt &&
          latestTimetablesXlsxAt >= latestRoutesHtmlAt
        ? "in_sync"
        : "stale";
  const timetableSyncLagMinutes =
    latestRoutesHtmlAt && latestTimetablesXlsxAt
      ? Math.max(
          0,
          Math.round(
            (latestRoutesHtmlAt.getTime() - latestTimetablesXlsxAt.getTime()) / 60_000,
          ),
        )
      : null;
  const mappedPatternCount = new Set(vehicleMaps.map((item) => item.routePatternId)).size;
  const matchedVariants = Array.isArray(routesHtmlMeta?.matchedVariants)
    ? routesHtmlMeta.matchedVariants
    : [];
  const unmatchedVariants = Array.isArray(routesHtmlMeta?.unmatchedVariants)
    ? routesHtmlMeta.unmatchedVariants
    : [];
  const skippedSpecialSchedules = Array.isArray(routesHtmlMeta?.skippedSpecialSchedules)
    ? routesHtmlMeta.skippedSpecialSchedules
    : [];
  const matchedRouteLabels = Array.isArray(routesHtmlMeta?.matchedRouteLabels)
    ? routesHtmlMeta.matchedRouteLabels
    : [];
  const unmatchedRouteLabels = Array.isArray(routesHtmlMeta?.unmatchedRouteLabels)
    ? routesHtmlMeta.unmatchedRouteLabels
    : [];
  const nearMisses = Array.isArray(routesHtmlMeta?.nearMisses) ? routesHtmlMeta.nearMisses : [];
  const rejectionBreakdown = Array.isArray(routesHtmlMeta?.rejectionBreakdown)
    ? routesHtmlMeta.rejectionBreakdown
    : [];
  const resolvedMixedVariantSchedules = Array.isArray(routesHtmlMeta?.resolvedMixedVariantSchedules)
    ? routesHtmlMeta.resolvedMixedVariantSchedules
    : [];
  const unresolvedMixedVariantSchedules = Array.isArray(routesHtmlMeta?.unresolvedMixedVariantSchedules)
    ? routesHtmlMeta.unresolvedMixedVariantSchedules
    : [];
  const inheritedVariantRowCount =
    typeof routesHtmlMeta?.inheritedVariantRowCount === "number"
      ? routesHtmlMeta.inheritedVariantRowCount
      : 0;
  const unresolvedVariantRowCount =
    typeof routesHtmlMeta?.unresolvedVariantRowCount === "number"
      ? routesHtmlMeta.unresolvedVariantRowCount
      : 0;

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
      mappedPatterns: mappedPatternCount,
      successRate:
        patterns.length === 0 ? 0 : Math.round((mappedPatternCount / patterns.length) * 100),
      latestRunAt: latestVehicleMapRun?.endedAt ?? null,
    },
    scheduleMatchingStats: {
      activeScheduleSourceCount,
      latestRoutesHtmlAt,
      matchedVariantCount: matchedVariants.length,
      unmatchedVariantCount: unmatchedVariants.length,
      skippedVariantCount: skippedSpecialSchedules.length,
      matchedRouteLabels: matchedRouteLabels.slice(0, 12),
      unmatchedRouteLabels: unmatchedRouteLabels.slice(0, 12),
      rejectionBreakdown: rejectionBreakdown.slice(0, 8),
      nearMisses: nearMisses.slice(0, 8),
      resolvedMixedVariantSchedules: resolvedMixedVariantSchedules.slice(0, 8),
      unresolvedMixedVariantSchedules: unresolvedMixedVariantSchedules.slice(0, 8),
      inheritedVariantRowCount,
      unresolvedVariantRowCount,
    },
    timetableSyncStats: {
      status: timetableSyncStatus,
      latestRoutesHtmlAt,
      latestTimetablesXlsxAt,
      latestTimetablesXlsxStatus: latestTimetablesXlsxRun?.status ?? null,
      lagMinutes:
        timetableSyncStatus === "stale" && timetableSyncLagMinutes !== null
          ? timetableSyncLagMinutes
          : null,
      zeroTripScheduleSourceCount,
      zeroTripScheduleSources,
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
      latestRouteGeometryAt: latestRouteGeometryRun?.endedAt ?? latestRouteGeometryRun?.startedAt ?? null,
      gtfsConfigured: Boolean(routeGeometryMeta?.gtfsConfigured),
      gtfsSource: typeof routeGeometryMeta?.gtfsSource === "string" ? routeGeometryMeta.gtfsSource : null,
      busJejuLinkCount:
        typeof routeGeometryMeta?.busJejuLinkCount === "number"
          ? routeGeometryMeta.busJejuLinkCount
          : 0,
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
