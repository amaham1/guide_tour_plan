import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { ServiceDayClass } from "@prisma/client";
import type { WorkerRuntime } from "@/worker/core/runtime";
import type { JobOutcome } from "@/worker/jobs/types";

const MIN_SEGMENT_SAMPLE_COUNT = 20;
const MIN_TURN_SAMPLE_COUNT = 30;
const OSRM_DOCKER_IMAGE =
  process.env.OSRM_DOCKER_IMAGE ?? "ghcr.io/project-osrm/osrm-backend:latest";

function formatCsvLine(values: Array<string | number>) {
  return `${values.join(",")}\n`;
}

function parseGeometryPayload(value: unknown) {
  if (!value || typeof value !== "object") {
    return {
      nodes: [] as number[],
      lengthMeters: 0,
    };
  }

  const record = value as {
    nodes?: unknown;
  };

  return {
    nodes: Array.isArray(record.nodes)
      ? record.nodes.filter((item): item is number => typeof item === "number")
      : [],
  };
}

function currentServiceDayClass(now: Date) {
  const day = now.getDay();
  if (day === 6) {
    return ServiceDayClass.SATURDAY;
  }

  if (day === 0) {
    return ServiceDayClass.SUNDAY_HOLIDAY;
  }

  return ServiceDayClass.WEEKDAY;
}

function currentBucketStartMinute(now: Date) {
  const totalMinutes = now.getHours() * 60 + now.getMinutes();
  return Math.floor(totalMinutes / 15) * 15;
}

function runCommand(command: string, args: string[], cwd: string) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "pipe",
    });

    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `${command} ${args.join(" ")} failed with code ${code}`));
    });
  });
}

export async function runOsrmBusCustomizeJob(runtime: WorkerRuntime): Promise<JobOutcome> {
  const now = new Date();
  const serviceDayClass = currentServiceDayClass(now);
  const bucketStartMinute = currentBucketStartMinute(now);
  const profiles = await runtime.prisma.segmentTravelProfile.findMany({
    where: {
      serviceDayClass,
      bucketStartMinute,
      sampleCount: {
        gte: MIN_SEGMENT_SAMPLE_COUNT,
      },
    },
  });
  const turnProfiles = await runtime.prisma.turnDelayProfile.findMany({
    where: {
      serviceDayClass,
      bucketStartMinute,
      sampleCount: {
        gte: MIN_TURN_SAMPLE_COUNT,
      },
    },
  });

  const routePatternIds = [...new Set(profiles.map((profile) => profile.routePatternId))];
  const geometries = await runtime.prisma.routePatternGeometry.findMany({
    where: {
      routePatternId: {
        in: routePatternIds,
      },
    },
  });
  const projections = await runtime.prisma.routePatternStopProjection.findMany({
    where: {
      routePatternId: {
        in: routePatternIds,
      },
    },
    orderBy: {
      sequence: "asc",
    },
  });

  const geometryByRoutePatternId = new Map(
    geometries.map((geometry) => [geometry.routePatternId, geometry]),
  );
  const projectionsByRoutePatternId = new Map<string, typeof projections>();
  for (const projection of projections) {
    const next = projectionsByRoutePatternId.get(projection.routePatternId) ?? [];
    next.push(projection);
    projectionsByRoutePatternId.set(projection.routePatternId, next);
  }

  const segmentLines = new Map<string, string>();
  for (const profile of profiles) {
    const geometry = geometryByRoutePatternId.get(profile.routePatternId);
    const routeProjections = projectionsByRoutePatternId.get(profile.routePatternId) ?? [];
    const fromProjection = routeProjections.find((item) => item.sequence === profile.fromSequence);
    const toProjection = routeProjections.find((item) => item.sequence === profile.toSequence);
    if (!geometry || !fromProjection || !toProjection) {
      continue;
    }

    const payload = parseGeometryPayload(geometry.geometry);
    if (payload.nodes.length < 2 || geometry.lengthMeters <= 0) {
      continue;
    }

    const maxIndex = payload.nodes.length - 1;
    const startIndex = Math.max(
      0,
      Math.min(maxIndex - 1, Math.floor((fromProjection.offsetMeters / geometry.lengthMeters) * maxIndex)),
    );
    const endIndex = Math.max(
      startIndex + 1,
      Math.min(maxIndex, Math.ceil((toProjection.offsetMeters / geometry.lengthMeters) * maxIndex)),
    );

    for (let index = startIndex; index < endIndex; index += 1) {
      const fromNode = payload.nodes[index];
      const toNode = payload.nodes[index + 1];
      if (!Number.isFinite(fromNode) || !Number.isFinite(toNode)) {
        continue;
      }

      const key = `${fromNode},${toNode}`;
      segmentLines.set(
        key,
        formatCsvLine([fromNode, toNode, Number(profile.medianSpeedKph.toFixed(3))]),
      );
    }
  }

  const turnLines = new Map<string, string>();
  for (const profile of turnProfiles) {
    const key = `${profile.fromOsmNodeId},${profile.viaOsmNodeId},${profile.toOsmNodeId}`;
    turnLines.set(key, formatCsvLine([profile.fromOsmNodeId, profile.viaOsmNodeId, profile.toOsmNodeId, profile.penaltySec]));
  }

  const repoRoot = process.cwd();
  const osrmDir = path.resolve(repoRoot, "docker", "osrm");
  const updateDir = path.resolve(osrmDir, "bus-eta-updates");
  await fs.mkdir(updateDir, { recursive: true });

  const segmentSpeedFile = path.resolve(updateDir, "segment-speeds.csv");
  const turnPenaltyFile = path.resolve(updateDir, "turn-penalties.csv");
  await fs.writeFile(segmentSpeedFile, [...segmentLines.values()].join(""), "utf8");
  await fs.writeFile(turnPenaltyFile, [...turnLines.values()].join(""), "utf8");

  const datasetBase = process.env.OSRM_DATASET_BASE ?? "jeju-non-military";
  const busEtaBaseName = `${datasetBase}-bus-eta`;
  const busEtaDatasetName = runtime.env.osrmBusEtaDatasetName;

  let customizeApplied = false;
  let datastoreApplied = false;
  let reloadApplied = false;
  let customizeError: string | null = null;
  let reloadWarning: string | null = null;

  try {
    await runCommand(
      "docker",
      [
        "run",
        "--rm",
        "--mount",
        `type=bind,source=${osrmDir.replace(/\\/g, "/")},target=/data`,
        OSRM_DOCKER_IMAGE,
        "osrm-customize",
        `/data/${busEtaBaseName}.osrm`,
        "--segment-speed-file",
        `/data/bus-eta-updates/${path.basename(segmentSpeedFile)}`,
        "--turn-penalty-file",
        `/data/bus-eta-updates/${path.basename(turnPenaltyFile)}`,
      ],
      repoRoot,
    );
    customizeApplied = true;

    try {
      await runCommand(
        "docker",
        [
          "run",
          "--rm",
          "--mount",
          `type=bind,source=${osrmDir.replace(/\\/g, "/")},target=/data`,
          OSRM_DOCKER_IMAGE,
          "osrm-datastore",
          "--dataset-name",
          busEtaDatasetName,
          `/data/${busEtaBaseName}.osrm`,
        ],
        repoRoot,
      );
      datastoreApplied = true;
      reloadApplied = true;
    } catch (error) {
      reloadWarning =
        error instanceof Error ? error.message : "Failed to load shared-memory dataset.";

      try {
        await runCommand("docker", ["compose", "restart", "osrm-bus-eta"], repoRoot);
        reloadApplied = true;
      } catch (restartError) {
        customizeError =
          restartError instanceof Error
            ? restartError.message
            : "Failed to restart osrm-bus-eta.";
      }
    }
  } catch (error) {
    customizeError = error instanceof Error ? error.message : "Failed to apply osrm-customize.";
  }

  return {
    processedCount: profiles.length + turnProfiles.length,
    successCount: segmentLines.size + turnLines.size,
    failureCount: customizeError ? 1 : 0,
    meta: {
      serviceDayClass,
      bucketStartMinute,
      segmentProfileCount: profiles.length,
      turnProfileCount: turnProfiles.length,
      segmentSpeedRowCount: segmentLines.size,
      turnPenaltyRowCount: turnLines.size,
      customizeApplied,
      datastoreApplied,
      reloadApplied,
      segmentSpeedFile,
      turnPenaltyFile,
      customizeError,
      reloadWarning,
    },
  };
}
