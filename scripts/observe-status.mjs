import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PrismaClient } from "@prisma/client";

const execFileAsync = promisify(execFile);
const db = new PrismaClient();
const kstFormatter = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const observationJobKeys = [
  "vehicle-device-map",
  "gnss-history",
  "segment-profiles",
  "observed-timetables",
];

function formatDate(value) {
  return value instanceof Date ? `${kstFormatter.format(value)} KST` : "-";
}

function minutesSince(value) {
  if (!(value instanceof Date)) {
    return null;
  }

  return Math.max(0, Math.round((Date.now() - value.getTime()) / 60_000));
}

function formatAge(value) {
  const minutes = minutesSince(value);
  return minutes === null ? "-" : `${minutes}m`;
}

function normalizeJsonArray(value) {
  if (!value.trim()) {
    return [];
  }

  const parsed = JSON.parse(value);
  if (!parsed) {
    return [];
  }

  return Array.isArray(parsed) ? parsed : [parsed];
}

async function listObservationProcesses() {
  try {
    if (process.platform === "win32") {
      const command = [
        "$ErrorActionPreference='Stop';",
        "Get-CimInstance Win32_Process",
        "| Where-Object { $_.CommandLine -and ($_.CommandLine -match 'scripts[\\\\/]observe\\.mjs|worker[\\\\/]index\\.ts') }",
        "| Select-Object ProcessId,CommandLine",
        "| ConvertTo-Json -Compress",
      ].join(" ");
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", command], {
        windowsHide: true,
      });
      return normalizeJsonArray(stdout)
        .map((row) => ({
          pid: String(row.ProcessId ?? ""),
          commandLine: String(row.CommandLine ?? ""),
        }))
        .filter(
          (row) =>
            !row.commandLine.includes("observe-status.mjs") &&
            !row.commandLine.includes("Get-CimInstance Win32_Process"),
        );
    }

    const { stdout } = await execFileAsync("ps", ["-eo", "pid=,args="]);
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const match = line.match(/^(\d+)\s+(.+)$/);
        return {
          pid: match?.[1] ?? "",
          commandLine: match?.[2] ?? line,
        };
      })
      .filter(
        (row) =>
          !row.commandLine.includes("observe-status.mjs") &&
          (row.commandLine.includes("scripts/observe.mjs") ||
            row.commandLine.includes("worker/index.ts")),
      );
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : "process scan failed",
      processes: [],
    };
  }
}

function processRows(processSnapshot) {
  if (Array.isArray(processSnapshot)) {
    return processSnapshot;
  }

  return processSnapshot.processes;
}

function processScanError(processSnapshot) {
  return Array.isArray(processSnapshot) ? null : processSnapshot.error;
}

function hasActiveProcessForJob(jobKey, processes) {
  return processes.some(
    (row) =>
      row.commandLine.includes(`--job ${jobKey}`) ||
      row.commandLine.includes(`--job=${jobKey}`) ||
      row.commandLine.includes(jobKey),
  );
}

function describeRunStatus(run, processes) {
  if (run.status !== "RUNNING") {
    return run.status;
  }

  if (hasActiveProcessForJob(run.job.key, processes)) {
    return "RUNNING";
  }

  const ageMinutes = minutesSince(run.startedAt);
  if (ageMinutes !== null && ageMinutes >= 15) {
    return "STALE_RUNNING";
  }

  return "RUNNING_UNVERIFIED";
}

function summarizePipeline({ gnss, passages, profiles, observedDerived, latestGnss }) {
  if (gnss === 0) {
    return "No raw GNSS rows yet. Keep npm run observe running and check vehicle-device-map / gnss-history.";
  }

  if (!latestGnss) {
    return "Raw GNSS rows exist, but latest observedAt is missing.";
  }

  if (passages === 0) {
    return "Raw GNSS exists, but stop passages are still empty. Run or wait for segment-profiles.";
  }

  if (profiles === 0) {
    return "Stop passages exist, but segment profiles are still empty. More repeated samples per 15-minute bucket may be needed.";
  }

  if (observedDerived === 0) {
    return "Profiles exist, but no SEGMENT_PROFILE stop times yet. Run or wait for observed-timetables.";
  }

  return "Observation pipeline has raw GNSS, stop passages, segment profiles, and derived stop times.";
}

async function main() {
  const processSnapshot = await listObservationProcesses();
  const processes = processRows(processSnapshot);
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
            in: observationJobKeys,
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
      take: 16,
    }),
  ]);

  console.log("");
  console.log("Observation pipeline");
  console.table({
    vehicleMaps,
    gnssRows: gnss,
    latestGnss: formatDate(latestGnss?.observedAt),
    latestGnssAge: formatAge(latestGnss?.observedAt),
    stopPassages: passages,
    latestPassage: formatDate(latestPassage?.observedAt),
    segmentProfiles: profiles,
    observedDerivedStopTimes: observedDerived,
  });
  console.log(`Status: ${summarizePipeline({ gnss, passages, profiles, observedDerived, latestGnss })}`);

  const scanError = processScanError(processSnapshot);
  if (scanError) {
    console.log(`Process scan: unavailable (${scanError})`);
  } else {
    console.log("");
    console.log("Observation processes");
    console.table(
      processes.map((row) => ({
        pid: row.pid,
        command: row.commandLine.replace(/\s+/g, " ").slice(0, 140),
      })),
    );
  }

  console.log("");
  console.log("Recent observation jobs");
  console.table(
    latestRuns.map((run) => ({
      job: run.job.key,
      status: describeRunStatus(run, processes),
      processed: run.processedCount,
      success: run.successCount,
      failure: run.failureCount,
      age: run.status === "RUNNING" ? formatAge(run.startedAt) : "-",
      startedAt: formatDate(run.startedAt),
      endedAt: formatDate(run.endedAt),
    })),
  );

  const latestSegmentRun = latestRuns.find((run) => run.job.key === "segment-profiles");
  if (latestSegmentRun?.meta && typeof latestSegmentRun.meta === "object") {
    console.log("Latest segment profile diagnostics");
    console.table(latestSegmentRun.meta);
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
