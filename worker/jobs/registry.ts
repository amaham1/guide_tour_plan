import { runRoutesHtmlJob } from "@/worker/jobs/routes-html";
import { runStopTranslationsJob } from "@/worker/jobs/stop-translations";
import { runStopsJob } from "@/worker/jobs/stops";
import { runTimetablesXlsxJob } from "@/worker/jobs/timetables-xlsx";
import type { JobHandler } from "@/worker/jobs/types";
import { runVehicleDeviceMapJob } from "@/worker/jobs/vehicle-device-map";
import { runVisitJejuPlacesJob } from "@/worker/jobs/visit-jeju-places";
import { runWalkLinksJob } from "@/worker/jobs/walk-links";

export const jobRegistry: Record<string, JobHandler> = {
  stops: runStopsJob,
  "stop-translations": runStopTranslationsJob,
  "visit-jeju-places": runVisitJejuPlacesJob,
  "routes-html": runRoutesHtmlJob,
  "timetables-xlsx": runTimetablesXlsxJob,
  "vehicle-device-map": runVehicleDeviceMapJob,
  "walk-links": runWalkLinksJob,
};
