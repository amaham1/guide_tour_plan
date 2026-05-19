import { db } from "@/lib/db";
import { syncSourceCatalog } from "@/lib/source-catalog";
import { getDefaultJobIntervalMs } from "@/worker/core/job-schedule";
import { runAllJobs, runJobByKey } from "@/worker/core/job-runner";
import { jobRegistry } from "@/worker/jobs/registry";

function readNumericFlag(name: string) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    return null;
  }

  const value = Number(process.argv[index + 1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

async function runJobLoop(jobKey: string, intervalMs: number) {
  console.log(`[worker] running ${jobKey} every ${Math.round(intervalMs / 1000)}s`);
  while (true) {
    await runJobByKey(jobKey, { triggeredBy: "loop" });
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

async function main() {
  await syncSourceCatalog(db);

  const jobIndex = process.argv.indexOf("--job");
  const jobKey = jobIndex >= 0 ? process.argv[jobIndex + 1] : undefined;
  const shouldRunAll = process.argv.includes("--run-all");
  const shouldLoop = process.argv.includes("--loop");
  const intervalMs = readNumericFlag("--interval-ms");

  if (jobKey) {
    if (shouldLoop) {
      await runJobLoop(jobKey, intervalMs ?? getDefaultJobIntervalMs(jobKey));
      return;
    }

    const results = await runJobByKey(jobKey, { triggeredBy: "cli" });
    console.log(JSON.stringify({ jobKey, results }, null, 2));
    return;
  }

  if (shouldRunAll) {
    const outcome = await runAllJobs({ triggeredBy: "cli" });
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }

  const activeJobs = await db.ingestJob.findMany({
    where: {
      isActive: true,
    },
    orderBy: {
      key: "asc",
    },
    select: {
      key: true,
    },
  });

  console.log("Available worker jobs:");
  for (const job of activeJobs) {
    if (!jobRegistry[job.key]) {
      continue;
    }

    console.log(`- ${job.key}`);
  }
  console.log("");
  console.log("Run `npm run worker -- --job <jobKey>` or `npm run worker:run-all`.");
  console.log("Use `npm run worker -- --job gnss-history --loop` for recurring collectors.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
