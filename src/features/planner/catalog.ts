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
  message: string;
};

const BUS_JOB_KEYS = ["stops", "routes-html", "timetables-xlsx", "walk-links"] as const;

export async function getPlannerCatalogStatus(prisma: PrismaClient = db) {
  const [placeCount, stopCount, routePatternCount, tripCount, walkLinkCount, jobs] =
    await Promise.all([
      prisma.place.count({
        where: {
          sourceContentId: {
            not: null,
          },
        },
      }),
      prisma.stop.count({
        where: {
          routePatternStops: {
            some: {
              routePattern: {
                scheduleId: {
                  not: null,
                },
              },
            },
          },
        },
      }),
      prisma.routePattern.count({
        where: {
          scheduleId: {
            not: null,
          },
        },
      }),
      prisma.trip.count({
        where: {
          routePattern: {
            scheduleId: {
              not: null,
            },
          },
        },
      }),
      prisma.walkLink.count({
        where: {
          kind: "STOP_STOP",
        },
      }),
      prisma.ingestJob.findMany({
        where: {
          key: {
            in: [...BUS_JOB_KEYS, "visit-jeju-places"],
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

  const placeSearchReady = placeCount > 0 || Boolean(appEnv.kakaoRestApiKey);
  const ready = busReady && placeSearchReady;

  let message = "플래너 카탈로그가 준비되었습니다.";
  if (!busReady) {
    message =
      "먼저 버스 ingest가 필요합니다. 관리자 화면에서 정류소, 노선, 시간표, 보행 링크 적재를 완료해 주세요.";
  } else if (!placeSearchReady) {
    message =
      "장소 검색원이 없습니다. Kakao REST API 키를 설정하거나 Visit Jeju 장소 ingest를 먼저 실행해 주세요.";
  }

  return {
    ready,
    placeCount,
    stopCount,
    routePatternCount,
    tripCount,
    walkLinkCount,
    message,
  } satisfies PlannerCatalogStatus;
}

export async function assertPlannerCatalogReady(prisma: PrismaClient = db) {
  const status = await getPlannerCatalogStatus(prisma);
  if (!status.ready) {
    throw new SetupRequiredError(status.message);
  }

  return status;
}
