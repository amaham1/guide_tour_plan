import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

function formatDate(value) {
  return value instanceof Date ? value.toISOString() : "-";
}

async function main() {
  const [
    vehicleMaps,
    gnss,
    latestGnss,
    passages,
    latestPassage,
    profiles,
    observedDerived,
    latestRuns,
  ] = await Promise.all([
    db.vehicleDeviceMap.count(),
    db.gnssObservation.count(),
    db.gnssObservation.findFirst({ orderBy: { observedAt: "desc" } }),
    db.observedStopPassage.count(),
    db.observedStopPassage.findFirst({ orderBy: { observedAt: "desc" } }),
    db.segmentTravelProfile.count(),
    db.derivedStopTime.count({ where: { timeSource: "SEGMENT_PROFILE" } }),
    db.ingestRun.findMany({
      where: {
        job: {
          key: {
            in: [
              "vehicle-device-map",
              "gnss-history",
              "segment-profiles",
              "observed-timetables",
            ],
          },
        },
      },
      include: {
        job: {
          select: {
            key: true,
          },
        },
      },
      orderBy: {
        startedAt: "desc",
      },
      take: 12,
    }),
  ]);

  console.log("");
  console.log("Observation status");
  console.table({
    vehicleMaps,
    gnss,
    latestGnss: formatDate(latestGnss?.observedAt),
    passages,
    latestPassage: formatDate(latestPassage?.observedAt),
    profiles,
    observedDerived,
  });

  console.log("Recent observation jobs");
  console.table(
    latestRuns.map((run) => ({
      job: run.job.key,
      status: run.status,
      processed: run.processedCount,
      success: run.successCount,
      failure: run.failureCount,
      startedAt: formatDate(run.startedAt),
      endedAt: formatDate(run.endedAt),
    })),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
