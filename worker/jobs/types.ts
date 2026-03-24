import type { Prisma } from "@prisma/client";
import type { WorkerRuntime } from "@/worker/core/runtime";

export type JobOutcome = {
  processedCount: number;
  successCount: number;
  failureCount: number;
  meta?: Prisma.InputJsonValue;
};

export type JobHandler = (runtime: WorkerRuntime) => Promise<JobOutcome>;
