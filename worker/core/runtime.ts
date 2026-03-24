import type { PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { appEnv } from "@/lib/env";

export type WorkerRuntime = {
  prisma: PrismaClient;
  triggeredBy: string;
  env: typeof appEnv;
};

export function createWorkerRuntime(options?: {
  prisma?: PrismaClient;
  triggeredBy?: string;
}) {
  return {
    prisma: options?.prisma ?? db,
    triggeredBy: options?.triggeredBy ?? "worker",
    env: appEnv,
  } satisfies WorkerRuntime;
}
