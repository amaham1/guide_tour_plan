import { db } from "@/lib/db";
import { syncSourceCatalog } from "@/lib/source-catalog";
import { runAllJobs, runJobByKey } from "@/worker/core/job-runner";
import { jobRegistry } from "@/worker/jobs/registry";

async function main() {
  await syncSourceCatalog(db);

  const jobIndex = process.argv.indexOf("--job");
  const jobKey = jobIndex >= 0 ? process.argv[jobIndex + 1] : undefined;
  const shouldRunAll = process.argv.includes("--run-all");

  if (jobKey) {
    const outcome = await runJobByKey(jobKey, { triggeredBy: "cli" });
    console.log(JSON.stringify({ jobKey, outcome }, null, 2));
    return;
  }

  if (shouldRunAll) {
    const outcome = await runAllJobs({ triggeredBy: "cli" });
    console.log(JSON.stringify(outcome, null, 2));
    return;
  }

  console.log("Available worker jobs:");
  for (const jobKey of Object.keys(jobRegistry)) {
    console.log(`- ${jobKey}`);
  }
  console.log("");
  console.log("Run `npm run worker -- --job <jobKey>` or `npm run worker:run-all`.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
