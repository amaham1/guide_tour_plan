import { fetchPlainText } from "@/worker/core/fetch";
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

export async function runRoutesHtmlJob(runtime: WorkerRuntime): Promise<JobOutcome> {
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

  let successCount = 0;

  for (const item of discovered.values()) {
    const detailHtml = await fetchRouteDetail(runtime, item.scheduleId);
    const detail = parseRouteDetailHtml(detailHtml, item.scheduleId);

    const route = await runtime.prisma.route.upsert({
      where: {
        id: `route-${detail.shortName}`,
      },
      update: {
        shortName: detail.shortName,
        displayName: detail.displayName,
      },
      create: {
        id: `route-${detail.shortName}`,
        shortName: detail.shortName,
        displayName: detail.displayName,
      },
    });

    await runtime.prisma.routePattern.upsert({
      where: {
        id: `pattern-${detail.scheduleId}`,
      },
      update: {
        routeId: route.id,
        scheduleId: detail.scheduleId,
        busType: detail.busType,
        directionLabel: detail.directionLabel,
        displayName: detail.displayName,
        viaText: detail.viaText,
        waypointText: detail.waypointText,
        serviceNote: detail.serviceNote,
        effectiveDate: detail.effectiveDate,
      },
      create: {
        id: `pattern-${detail.scheduleId}`,
        routeId: route.id,
        scheduleId: detail.scheduleId,
        busType: detail.busType,
        directionLabel: detail.directionLabel,
        displayName: detail.displayName,
        viaText: detail.viaText,
        waypointText: detail.waypointText,
        serviceNote: detail.serviceNote,
        effectiveDate: detail.effectiveDate,
      },
    });

    successCount += 1;
  }

  return {
    processedCount: discovered.size,
    successCount,
    failureCount: 0,
    meta: {
      busTypes,
      routeNumbers,
      discoveredSchedules: [...discovered.keys()],
    },
  };
}
