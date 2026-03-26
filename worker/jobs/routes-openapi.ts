import { fetchPlainText } from "@/worker/core/fetch";
import { isExcludedTransitRoute } from "@/lib/transit-route-policy";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { parseRouteDetailHtml, parseRouteSearchHtml } from "@/worker/jobs/bus-jeju-parser";
import type { JobOutcome } from "@/worker/jobs/types";

const busTypes = [1, 2, 3, 4] as const;

async function fetchRouteSearch(runtime: WorkerRuntime, routeNumber: string) {
  return fetchPlainText(`${runtime.env.busJejuBaseUrl}/mobile/schedule/listSchedule`, {
    keyword: routeNumber,
  });
}

async function fetchRouteCatalogPage(runtime: WorkerRuntime, busType: (typeof busTypes)[number]) {
  return fetchPlainText(`${runtime.env.busJejuBaseUrl}/mobile/schedule/listSchedule`, {
    busType,
  });
}

async function fetchRouteDetail(runtime: WorkerRuntime, scheduleId: string) {
  return fetchPlainText(
    `${runtime.env.busJejuBaseUrl}/mobile/schedule/detailSchedule?scheduleId=${scheduleId}`,
  );
}

export async function runRoutesOpenApiJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const routeNumbers = runtime.env.routeSearchTerms;
  const discovered = new Map<string, { scheduleId: string; shortName: string }>();

  for (const busType of busTypes) {
    const html = await fetchRouteCatalogPage(runtime, busType);
    for (const item of parseRouteSearchHtml(html)) {
      discovered.set(item.scheduleId, {
        scheduleId: item.scheduleId,
        shortName: item.shortName,
      });
    }
  }

  for (const routeNumber of routeNumbers) {
    const html = await fetchRouteSearch(runtime, routeNumber);
    for (const item of parseRouteSearchHtml(html)) {
      discovered.set(item.scheduleId, {
        scheduleId: item.scheduleId,
        shortName: item.shortName,
      });
    }
  }

  const activeRouteIds = new Set<string>();
  for (const item of discovered.values()) {
    const detailHtml = await fetchRouteDetail(runtime, item.scheduleId);
    const detail = parseRouteDetailHtml(detailHtml, item.scheduleId);
    const routeId = `route-${detail.shortName}`;
    const isActiveRoute = !isExcludedTransitRoute([
      item.shortName,
      detail.shortName,
      detail.displayName,
    ]);
    if (isActiveRoute) {
      activeRouteIds.add(routeId);
    }

    await runtime.prisma.route.upsert({
      where: {
        id: routeId,
      },
      update: {
        shortName: detail.shortName,
        displayName: detail.displayName,
        isActive: isActiveRoute,
      },
      create: {
        id: routeId,
        shortName: detail.shortName,
        displayName: detail.displayName,
        isActive: isActiveRoute,
      },
    });
  }

  await runtime.prisma.route.updateMany({
    where: {
      id: {
        notIn: [...activeRouteIds],
      },
    },
    data: {
      isActive: false,
    },
  });

  return {
    processedCount: discovered.size,
    successCount: activeRouteIds.size,
    failureCount: 0,
    meta: {
      source: `${runtime.env.busJejuBaseUrl}/mobile/schedule/listSchedule`,
      discoveredSchedules: [...discovered.keys()],
    },
  };
}
