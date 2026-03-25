import type { PrismaClient } from "@prisma/client";
import { syncSourceCatalog } from "@/lib/source-catalog";
import { createWorkerRuntime } from "@/worker/core/runtime";
import { jobRegistry } from "@/worker/jobs/registry";

const defaultRunAllOrder = [
  "stops",
  "stop-translations",
  "routes-openapi",
  "route-patterns-openapi",
  "routes-html",
  "route-geometries",
  "timetables-xlsx",
  "walk-links",
  "vehicle-device-map",
  "segment-profiles",
  "osrm-bus-customize",
  "transit-audit",
  "visit-jeju-places",
] as const;

type RunOptions = {
  prisma?: PrismaClient;
  triggeredBy?: string;
};

async function runSingleJob(jobKey: string, options: RunOptions = {}) {
  const runtime = createWorkerRuntime(options);
  await syncSourceCatalog(runtime.prisma);

  const job = await runtime.prisma.ingestJob.findUnique({
    where: { key: jobKey },
  });

  if (!job) {
    throw new Error(`Unknown ingest job: ${jobKey}`);
  }

  const handler = jobRegistry[jobKey];
  if (!handler) {
    throw new Error(`No handler registered for job: ${jobKey}`);
  }

  await runtime.prisma.ingestRun.updateMany({
    where: {
      jobId: job.id,
      status: "RUNNING",
    },
    data: {
      status: "FAILED",
      endedAt: new Date(),
      failureCount: 1,
      errorSummary: "Interrupted by a newer worker run.",
    },
  });

  console.log(`[worker] starting ${jobKey}`);

  const run = await runtime.prisma.ingestRun.create({
    data: {
      jobId: job.id,
      status: "RUNNING",
      triggeredBy: runtime.triggeredBy,
    },
  });

  try {
    const outcome = await handler(runtime);
    const endedAt = new Date();

    await runtime.prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        status: "SUCCESS",
        endedAt,
        processedCount: outcome.processedCount,
        successCount: outcome.successCount,
        failureCount: outcome.failureCount,
        meta: outcome.meta,
      },
    });

    await runtime.prisma.ingestJob.update({
      where: { id: job.id },
      data: {
        lastSuccessfulAt: endedAt,
      },
    });

    console.log(
      `[worker] finished ${jobKey}: processed=${outcome.processedCount}, success=${outcome.successCount}, failure=${outcome.failureCount}`,
    );

    return outcome;
  } catch (error) {
    await runtime.prisma.ingestRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        endedAt: new Date(),
        failureCount: 1,
        errorSummary: error instanceof Error ? error.message : "Unknown ingest error",
      },
    });

    console.error(
      `[worker] failed ${jobKey}: ${error instanceof Error ? error.message : "Unknown error"}`,
    );

    throw error;
  }
}

export async function runJobByKey(jobKey: string, options: RunOptions = {}) {
  return runSingleJob(jobKey, options);
}

export async function runAllJobs(options: RunOptions = {}) {
  const results: Record<string, Awaited<ReturnType<typeof runSingleJob>>> = {};

  for (const jobKey of defaultRunAllOrder) {
    if (!jobRegistry[jobKey]) {
      continue;
    }
    results[jobKey] = await runSingleJob(jobKey, options);
  }

  return results;
}
