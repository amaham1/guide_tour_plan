import { runRoutePatternsOpenApiJob } from "@/worker/jobs/route-patterns-openapi";
import { runRoutesOpenApiJob } from "@/worker/jobs/routes-openapi";
import { runRoutesHtmlJob } from "@/worker/jobs/routes-html";
import { runStopTranslationsJob } from "@/worker/jobs/stop-translations";
import { runStopsJob } from "@/worker/jobs/stops";
import { runTimetablesXlsxJob } from "@/worker/jobs/timetables-xlsx";
import { runTransitAuditJob } from "@/worker/jobs/transit-audit";
import type { JobHandler } from "@/worker/jobs/types";
import { runVehicleDeviceMapJob } from "@/worker/jobs/vehicle-device-map";
import { runVisitJejuPlacesJob } from "@/worker/jobs/visit-jeju-places";
import { runWalkLinksJob } from "@/worker/jobs/walk-links";

export const jobRegistry: Record<string, JobHandler> = {
  stops: runStopsJob,
  "stop-translations": runStopTranslationsJob,
  "routes-openapi": runRoutesOpenApiJob,
  "route-patterns-openapi": runRoutePatternsOpenApiJob,
  "routes-html": runRoutesHtmlJob,
  "timetables-xlsx": runTimetablesXlsxJob,
  "walk-links": runWalkLinksJob,
  "vehicle-device-map": runVehicleDeviceMapJob,
  "transit-audit": runTransitAuditJob,
  "visit-jeju-places": runVisitJejuPlacesJob,
};
