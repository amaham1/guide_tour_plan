import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { appEnv } from "@/lib/env";
import { SetupRequiredError } from "@/lib/errors";

export type PlannerCatalogStatus = {
  ready: boolean;
  placeCount: number;
  stopCount: number;
  routePatternCount: number;
  tripCount: number;
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
        tripCount,
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
        // Readiness only needs to know that stop data exists.
        // Counting only "searchable" stops through nested relations is very expensive on SQLite
        // and was making every search request take several seconds.
        prisma.stop.count(),
        prisma.routePattern.count({
          where: {
            isActive: true,
          },
        }),
        prisma.trip.count({
          where: {
            routePattern: {
              isActive: true,
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
        walkLinkCount > 0;

      const placeSearchReady = Boolean(appEnv.kakaoRestApiKey);
      const ready = busReady && placeSearchReady;

      let message = "플래너 카탈로그가 준비되었습니다.";
      if (!busReady) {
        message =
          "먼저 버스 ingest가 필요합니다. 관리자 화면에서 정류장, 노선, 시간표, 보행 링크 적재를 완료해 주세요.";
      } else if (!placeSearchReady) {
        message = "장소 검색을 위해 KAKAO_REST_API_KEY를 설정해 주세요.";
      }

      const status = {
        ready,
        placeCount,
        stopCount,
        routePatternCount,
        tripCount,
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
