import type { PrismaClient } from "@prisma/client";
import { syncSourceCatalog } from "@/lib/source-catalog";
import { createWorkerRuntime } from "@/worker/core/runtime";
import { jobRegistry } from "@/worker/jobs/registry";
import type { JobOutcome } from "@/worker/jobs/types";

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
  "transit-audit",
  "visit-jeju-places",
] as const;

const followUpJobsByKey: Record<string, readonly string[]> = {
  "routes-html": ["timetables-xlsx"],
};

type RunOptions = {
  prisma?: PrismaClient;
  triggeredBy?: string;
};

export type JobRunResults = Record<string, JobOutcome>;

async function runSingleJob(jobKey: string, options: RunOptions = {}) {
  const runtime = createWorkerRuntime(options);
  await syncSourceCatalog(runtime.prisma);

  const job = await runtime.prisma.ingestJob.findUnique({
    where: { key: jobKey },
  });

  if (!job) {
    throw new Error(`Unknown ingest job: ${jobKey}`);
  }

  if (!job.isActive) {
    throw new Error(`Disabled ingest job: ${jobKey}`);
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
  const results: JobRunResults = {};
  const queue: Array<{
    jobKey: string;
    triggeredBy?: string;
    parentJobKey?: string;
  }> = [{ jobKey, triggeredBy: options.triggeredBy }];
  const executedJobs = new Set<string>();

  while (queue.length > 0) {
    const nextJob = queue.shift();
    if (!nextJob || executedJobs.has(nextJob.jobKey)) {
      continue;
    }

    if (nextJob.parentJobKey) {
      console.log(
        `[worker] scheduling follow-up ${nextJob.jobKey} after ${nextJob.parentJobKey}`,
      );
    }

    results[nextJob.jobKey] = await runSingleJob(nextJob.jobKey, {
      ...options,
      triggeredBy: nextJob.triggeredBy,
    });
    executedJobs.add(nextJob.jobKey);

    for (const followUpJobKey of followUpJobsByKey[nextJob.jobKey] ?? []) {
      if (executedJobs.has(followUpJobKey)) {
        continue;
      }

      queue.push({
        jobKey: followUpJobKey,
        triggeredBy: buildFollowUpTriggeredBy(nextJob.triggeredBy, nextJob.jobKey),
        parentJobKey: nextJob.jobKey,
      });
    }
  }

  return results;
}

export async function runAllJobs(options: RunOptions = {}) {
  const results: JobRunResults = {};

  for (const jobKey of defaultRunAllOrder) {
    if (!jobRegistry[jobKey]) {
      continue;
    }
    results[jobKey] = await runSingleJob(jobKey, options);
  }

  return results;
}

function buildFollowUpTriggeredBy(triggeredBy: string | undefined, parentJobKey: string) {
  const base = triggeredBy?.trim() ? triggeredBy.trim() : "worker";
  return `${base}:follow-up:${parentJobKey}`;
}
