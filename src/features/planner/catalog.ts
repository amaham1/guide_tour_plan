import { Prisma, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { appEnv } from "@/lib/env";
import { SetupRequiredError } from "@/lib/errors";

export type PlannerCatalogStatus = {
  ready: boolean;
  placeCount: number;
  stopCount: number;
  routePatternCount: number;
  routePatternStopCount: number;
  tripCount: number;
  timetableRoutePatternCount: number;
  officialStopCount: number;
  generatedStopCount: number;
  searchableStopCount: number;
  unresolvedStopCount: number;
  estimatedStopTimeCount: number;
  walkLinkCount: number;
  routeGeometryCount: number;
  stopProjectionCount: number;
  segmentProfileCount: number;
  lastBusCustomizeAt: string | null;
  message: string;
};

const BUS_JOB_KEYS = [
  "stops",
  "routes-openapi",
  "route-patterns-openapi",
  "routes-html",
  "route-geometries",
  "timetables-xlsx",
  "walk-links",
] as const;

const CATALOG_STATUS_CACHE_TTL_MS = 30_000;

let cachedCatalogStatus:
  | {
      loadedAt: number;
      status: PlannerCatalogStatus;
    }
  | undefined;
let catalogStatusPromise: Promise<PlannerCatalogStatus> | undefined;

async function getRawCount(prisma: PrismaClient, query: Prisma.Sql) {
  const rows = await prisma.$queryRaw<Array<{ count: number | bigint }>>(query);
  return Number(rows[0]?.count ?? 0);
}

export async function getPlannerCatalogStatus(prisma: PrismaClient = db) {
  const now = Date.now();
  if (cachedCatalogStatus && now - cachedCatalogStatus.loadedAt < CATALOG_STATUS_CACHE_TTL_MS) {
    return cachedCatalogStatus.status;
  }

  if (!catalogStatusPromise) {
    catalogStatusPromise = (async () => {
      const [
        placeCount,
        stopCount,
        routePatternCount,
        routePatternStopCount,
        tripCount,
        timetableRoutePatternCount,
        officialStopCount,
        generatedStopCount,
        searchableStopCount,
        unresolvedStopCount,
        estimatedStopTimeCount,
        walkLinkCount,
        routeGeometryCount,
        stopProjectionCount,
        segmentProfileCount,
        lastBusCustomizeAt,
        jobs,
      ] = await Promise.all([
        prisma.place.count({
          where: {
            sourceContentId: {
              not: null,
            },
          },
        }),
        prisma.stop.count(),
        prisma.routePattern.count({
          where: {
            isActive: true,
            route: {
              isActive: true,
            },
          },
        }),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(*) AS count
            FROM "RoutePatternStop" AS rps
            INNER JOIN "RoutePattern" AS rp
              ON rp."id" = rps."routePatternId"
            INNER JOIN "Route" AS r
              ON r."id" = rp."routeId"
            WHERE rp."isActive" = 1
              AND r."isActive" = 1
          `,
        ),
        prisma.trip.count({
          where: {
            routePattern: {
              isActive: true,
              route: {
                isActive: true,
              },
            },
            scheduleSource: {
              is: {
                isActive: true,
              },
            },
          },
        }),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(DISTINCT t."routePatternId") AS count
            FROM "Trip" AS t
            INNER JOIN "RoutePattern" AS rp
              ON rp."id" = t."routePatternId"
            INNER JOIN "Route" AS r
              ON r."id" = rp."routeId"
            INNER JOIN "RoutePatternScheduleSource" AS s
              ON s."id" = t."scheduleSourceId"
            WHERE rp."isActive" = 1
              AND r."isActive" = 1
              AND s."isActive" = 1
          `,
        ),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(DISTINCT st."stopId") AS count
            FROM "StopTime" AS st
            INNER JOIN "Trip" AS t
              ON t."id" = st."tripId"
            INNER JOIN "RoutePattern" AS rp
              ON rp."id" = t."routePatternId"
            INNER JOIN "Route" AS r
              ON r."id" = rp."routeId"
            INNER JOIN "RoutePatternScheduleSource" AS s
              ON s."id" = t."scheduleSourceId"
            WHERE rp."isActive" = 1
              AND r."isActive" = 1
              AND s."isActive" = 1
              AND st."isEstimated" = 0
          `,
        ),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(DISTINCT dst."stopId") AS count
            FROM "DerivedStopTime" AS dst
            INNER JOIN "Trip" AS t
              ON t."id" = dst."tripId"
            INNER JOIN "RoutePattern" AS rp
              ON rp."id" = t."routePatternId"
            INNER JOIN "Route" AS r
              ON r."id" = rp."routeId"
            INNER JOIN "RoutePatternScheduleSource" AS s
              ON s."id" = t."scheduleSourceId"
            WHERE rp."isActive" = 1
              AND r."isActive" = 1
              AND s."isActive" = 1
          `,
        ),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(DISTINCT coverage."stopId") AS count
            FROM (
              SELECT st."stopId" AS "stopId"
              FROM "StopTime" AS st
              INNER JOIN "Trip" AS t
                ON t."id" = st."tripId"
              INNER JOIN "RoutePattern" AS rp
                ON rp."id" = t."routePatternId"
              INNER JOIN "Route" AS r
                ON r."id" = rp."routeId"
              INNER JOIN "RoutePatternScheduleSource" AS s
                ON s."id" = t."scheduleSourceId"
              WHERE rp."isActive" = 1
                AND r."isActive" = 1
                AND s."isActive" = 1
                AND st."isEstimated" = 0

              UNION

              SELECT dst."stopId" AS "stopId"
              FROM "DerivedStopTime" AS dst
              INNER JOIN "Trip" AS t
                ON t."id" = dst."tripId"
              INNER JOIN "RoutePattern" AS rp
                ON rp."id" = t."routePatternId"
              INNER JOIN "Route" AS r
                ON r."id" = rp."routeId"
              INNER JOIN "RoutePatternScheduleSource" AS s
                ON s."id" = t."scheduleSourceId"
              WHERE rp."isActive" = 1
                AND r."isActive" = 1
                AND s."isActive" = 1
            ) AS coverage
          `,
        ),
        getRawCount(
          prisma,
          Prisma.sql`
            SELECT COUNT(DISTINCT rps."stopId") AS count
            FROM "RoutePatternStop" AS rps
            INNER JOIN "RoutePattern" AS rp
              ON rp."id" = rps."routePatternId"
            INNER JOIN "Route" AS r
              ON r."id" = rp."routeId"
            WHERE rp."isActive" = 1
              AND r."isActive" = 1
              AND NOT EXISTS (
                SELECT 1
                FROM "StopTime" AS st
                INNER JOIN "Trip" AS t
                  ON t."id" = st."tripId"
                INNER JOIN "RoutePattern" AS rp2
                  ON rp2."id" = t."routePatternId"
                INNER JOIN "Route" AS r2
                  ON r2."id" = rp2."routeId"
                INNER JOIN "RoutePatternScheduleSource" AS s
                  ON s."id" = t."scheduleSourceId"
                WHERE s."isActive" = 1
                  AND rp2."isActive" = 1
                  AND r2."isActive" = 1
                  AND st."isEstimated" = 0
                  AND st."stopId" = rps."stopId"
              )
              AND NOT EXISTS (
                SELECT 1
                FROM "DerivedStopTime" AS dst
                INNER JOIN "Trip" AS t
                  ON t."id" = dst."tripId"
                INNER JOIN "RoutePattern" AS rp2
                  ON rp2."id" = t."routePatternId"
                INNER JOIN "Route" AS r2
                  ON r2."id" = rp2."routeId"
                INNER JOIN "RoutePatternScheduleSource" AS s
                  ON s."id" = t."scheduleSourceId"
                WHERE s."isActive" = 1
                  AND rp2."isActive" = 1
                  AND r2."isActive" = 1
                  AND dst."stopId" = rps."stopId"
              )
          `,
        ),
        prisma.stopTime.count({
          where: {
            isEstimated: true,
            trip: {
              routePattern: {
                isActive: true,
                route: {
                  isActive: true,
                },
              },
              scheduleSource: {
                is: {
                  isActive: true,
                },
              },
            },
          },
        }),
        prisma.walkLink.count({
          where: {
            kind: "STOP_STOP",
          },
        }),
        prisma.routePatternGeometry.count(),
        prisma.routePatternStopProjection.count(),
        prisma.segmentTravelProfile.count(),
        prisma.ingestJob.findUnique({
          where: {
            key: "osrm-bus-customize",
          },
          select: {
            lastSuccessfulAt: true,
          },
        }),
        prisma.ingestJob.findMany({
          where: {
            key: {
              in: [...BUS_JOB_KEYS, "visit-jeju-places", "osrm-bus-customize"],
            },
          },
        }),
      ]);

      const busJobs = jobs.filter((job) =>
        BUS_JOB_KEYS.includes(job.key as (typeof BUS_JOB_KEYS)[number]),
      );
      const busReady =
        busJobs.length === BUS_JOB_KEYS.length &&
        busJobs.every((job) => Boolean(job.lastSuccessfulAt)) &&
        stopCount > 0 &&
        routePatternCount > 0 &&
        tripCount > 0 &&
        timetableRoutePatternCount > 0 &&
        walkLinkCount > 0;

      const placeSearchReady = Boolean(appEnv.kakaoRestApiKey);
      const ready = busReady && placeSearchReady;

      let message = "플래너 카탈로그가 준비되었습니다.";
      if (!busReady) {
        message =
          "버스 기본 데이터 또는 sparse 공식 시간표 적재가 아직 완료되지 않았습니다. 관리자 화면에서 버스 ingest를 다시 실행해 주세요.";
      } else if (!placeSearchReady) {
        message = "장소 검색을 위해 KAKAO_REST_API_KEY를 설정해 주세요.";
      } else if (generatedStopCount > 0) {
        message =
          "공식 시각이 없는 중간 정류장은 `생성 시각 포함` 옵션을 켰을 때 함께 안내됩니다.";
      }

      const status = {
        ready,
        placeCount,
        stopCount,
        routePatternCount,
        routePatternStopCount,
        tripCount,
        timetableRoutePatternCount,
        officialStopCount,
        generatedStopCount,
        searchableStopCount,
        unresolvedStopCount,
        estimatedStopTimeCount,
        walkLinkCount,
        routeGeometryCount,
        stopProjectionCount,
        segmentProfileCount,
        lastBusCustomizeAt: lastBusCustomizeAt?.lastSuccessfulAt?.toISOString() ?? null,
        message,
      } satisfies PlannerCatalogStatus;

      cachedCatalogStatus = {
        loadedAt: Date.now(),
        status,
      };

      return status;
    })().finally(() => {
      catalogStatusPromise = undefined;
    });
  }

  return catalogStatusPromise;
}

export async function assertPlannerCatalogReady(prisma: PrismaClient = db) {
  const status = await getPlannerCatalogStatus(prisma);
  if (!status.ready) {
    throw new SetupRequiredError(status.message);
  }

  return status;
}
