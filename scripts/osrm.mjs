import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, rename, rm, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const osrmDir = path.join(repoRoot, "docker", "osrm");
const datasetBaseName = process.env.OSRM_DATASET_BASE ?? "jeju-non-military";
const pbfFileName = `${datasetBaseName}.osm.pbf`;
const pbfPath = path.join(osrmDir, pbfFileName);
const extractUrl =
  process.env.OSRM_EXTRACT_URL ??
  "https://tiles.osm.kr/download/jeju-non-military.osm.pbf";
const dockerImage =
  process.env.OSRM_DOCKER_IMAGE ?? "ghcr.io/project-osrm/osrm-backend:latest";

const profiles = [
  {
    key: "foot",
    serviceName: "osrm-foot",
    datasetName: datasetBaseName,
    extractProfile: "/opt/foot.lua",
    healthcheckUrl:
      process.env.OSRM_FOOT_HEALTHCHECK_URL ??
      "http://localhost:5000/route/v1/foot/126.5312,33.4996;126.5331,33.5007?overview=false",
  },
  {
    key: "bus-distance",
    serviceName: "osrm-bus-distance",
    datasetName: `${datasetBaseName}-bus-distance`,
    templateFile: "bus-distance.lua.tpl",
    renderedFile: "bus-distance.lua",
    extractProfile: "/data/bus-distance.lua",
    healthcheckUrl:
      process.env.OSRM_BUS_DISTANCE_HEALTHCHECK_URL ??
      "http://localhost:5001/route/v1/driving/126.5312,33.4996;126.5331,33.5007?overview=false",
  },
  {
    key: "bus-eta",
    serviceName: "osrm-bus-eta",
    datasetName: `${datasetBaseName}-bus-eta`,
    sharedMemoryDatasetName:
      process.env.OSRM_BUS_ETA_DATASET_NAME ?? "bus-eta",
    templateFile: "bus-eta.lua.tpl",
    renderedFile: "bus-eta.lua",
    extractProfile: "/data/bus-eta.lua",
    healthcheckUrl:
      process.env.OSRM_BUS_ETA_HEALTHCHECK_URL ??
      "http://localhost:5002/route/v1/driving/126.5312,33.4996;126.5331,33.5007?overview=false",
  },
];

const requiredArtifactSuffixes = [
  ".osrm.cells",
  ".osrm.cell_metrics",
  ".osrm.cnbg",
  ".osrm.cnbg_to_ebg",
  ".osrm.datasource_names",
  ".osrm.ebg",
  ".osrm.ebg_nodes",
  ".osrm.edges",
  ".osrm.enw",
  ".osrm.fileIndex",
  ".osrm.geometry",
  ".osrm.icd",
  ".osrm.mldgr",
  ".osrm.names",
  ".osrm.nbg_nodes",
  ".osrm.partition",
  ".osrm.properties",
  ".osrm.ramIndex",
  ".osrm.restrictions",
  ".osrm.timestamp",
  ".osrm.tld",
  ".osrm.tls",
  ".osrm.turn_duration_penalties",
  ".osrm.turn_penalties_index",
  ".osrm.turn_weight_penalties",
];

function dockerPath(value) {
  return value.replace(/\\/g, "/");
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatCause(error) {
  return error instanceof Error ? error.message : "unknown error";
}

function requiredArtifacts(datasetName) {
  return requiredArtifactSuffixes.map((suffix) => `${datasetName}${suffix}`);
}

async function runCommand(command, args, options = {}) {
  const {
    cwd = repoRoot,
    env = process.env,
    captureOutput = false,
  } = options;

  return new Promise((resolve, reject) => {
    const stdout = [];
    const stderr = [];
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: captureOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });

    if (captureOutput) {
      child.stdout.on("data", (chunk) => {
        stdout.push(String(chunk));
      });
      child.stderr.on("data", (chunk) => {
        stderr.push(String(chunk));
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve({
          stdout: stdout.join(""),
          stderr: stderr.join(""),
        });
        return;
      }

      const output = captureOutput ? `${stdout.join("")}${stderr.join("")}`.trim() : "";
      reject(
        new Error(
          `${command} ${args.join(" ")} exited with code ${code}${output ? `\n${output}` : ""}`,
        ),
      );
    });
  });
}

async function fileExistsAndNonEmpty(filePath) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile() && metadata.size > 0;
  } catch {
    return false;
  }
}

async function ensureDockerAvailable() {
  try {
    await runCommand("docker", ["compose", "version"], { captureOutput: true });
  } catch (error) {
    throw new Error(
      `Docker Compose를 사용할 수 없습니다. Docker Desktop이 실행 중인지 확인해 주세요. 원인: ${formatCause(error)}`,
    );
  }
}

async function hasPreparedDataset(datasetName) {
  for (const fileName of requiredArtifacts(datasetName)) {
    if (!(await fileExistsAndNonEmpty(path.join(osrmDir, fileName)))) {
      return false;
    }
  }

  return true;
}

async function downloadExtractIfMissing() {
  if (await fileExistsAndNonEmpty(pbfPath)) {
    return;
  }

  await mkdir(osrmDir, { recursive: true });
  const tempPath = `${pbfPath}.download`;

  console.log(`[osrm] downloading ${extractUrl}`);
  const response = await fetch(extractUrl);
  if (!response.ok || !response.body) {
    throw new Error(
      `OSRM 지도 추출본 다운로드에 실패했습니다 (${response.status} ${response.statusText}).`,
    );
  }

  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath));
    await rename(tempPath, pbfPath);
  } catch (error) {
    await rm(tempPath, { force: true });
    throw error;
  }
}

async function ensureRenderedProfile(profile) {
  if (!profile.templateFile || !profile.renderedFile) {
    return;
  }

  const template = await readFile(path.join(osrmDir, profile.templateFile), "utf8");
  const rendered = template
    .replaceAll("__BUS_HEIGHT__", process.env.BUS_OSRM_VEHICLE_HEIGHT ?? "3.6")
    .replaceAll("__BUS_WIDTH__", process.env.BUS_OSRM_VEHICLE_WIDTH ?? "2.5")
    .replaceAll("__BUS_LENGTH__", process.env.BUS_OSRM_VEHICLE_LENGTH ?? "11.0")
    .replaceAll("__BUS_WEIGHT__", process.env.BUS_OSRM_VEHICLE_WEIGHT ?? "14000");
  await writeFile(path.join(osrmDir, profile.renderedFile), rendered, "utf8");
}

async function ensureProfilePbf(profile) {
  if (profile.datasetName === datasetBaseName) {
    return pbfFileName;
  }

  const profilePbfFileName = `${profile.datasetName}.osm.pbf`;
  const profilePbfPath = path.join(osrmDir, profilePbfFileName);
  if (!(await fileExistsAndNonEmpty(profilePbfPath))) {
    await copyFile(pbfPath, profilePbfPath);
  }

  return profilePbfFileName;
}

async function runOsrmTool(args) {
  const mount = `type=bind,source=${dockerPath(osrmDir)},target=/data`;
  await runCommand("docker", ["run", "--rm", "--mount", mount, dockerImage, ...args]);
}

async function loadSharedMemoryDataset(profile) {
  if (!profile.sharedMemoryDatasetName) {
    return false;
  }

  await runOsrmTool([
    "osrm-datastore",
    "--dataset-name",
    profile.sharedMemoryDatasetName,
    `/data/${profile.datasetName}.osrm`,
  ]);
  return true;
}

async function prepareProfile(profile) {
  await mkdir(osrmDir, { recursive: true });
  if (await hasPreparedDataset(profile.datasetName)) {
    console.log(`[osrm] dataset already prepared for ${profile.key}`);
    return;
  }

  await downloadExtractIfMissing();
  await ensureRenderedProfile(profile);
  const profilePbfFileName = await ensureProfilePbf(profile);

  console.log(`[osrm] running osrm-extract for ${profile.key}`);
  await runOsrmTool([
    "osrm-extract",
    "-p",
    profile.extractProfile,
    `/data/${profilePbfFileName}`,
  ]);

  console.log(`[osrm] running osrm-partition for ${profile.key}`);
  await runOsrmTool(["osrm-partition", `/data/${profile.datasetName}.osrm`]);

  console.log(`[osrm] running osrm-customize for ${profile.key}`);
  await runOsrmTool(["osrm-customize", `/data/${profile.datasetName}.osrm`]);
}

async function prepareOsrmData() {
  for (const profile of profiles) {
    await prepareProfile(profile);
  }
}

export async function isOsrmRunning() {
  const result = await runCommand(
    "docker",
    [
      "compose",
      "ps",
      "--status",
      "running",
      "-q",
      ...profiles.map((profile) => profile.serviceName),
    ],
    { captureOutput: true },
  );
  const runningCount = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;

  return runningCount === profiles.length;
}

export async function startOsrmService() {
  await runCommand("docker", ["compose", "up", "-d", "--force-recreate", "--remove-orphans", ...profiles.map((profile) => profile.serviceName)]);
}

export async function stopOsrmService() {
  try {
    await runCommand("docker", ["compose", "stop", ...profiles.map((profile) => profile.serviceName)]);
  } catch (error) {
    console.warn(`[osrm] stop skipped: ${formatCause(error)}`);
  }
}

export async function waitForOsrmReady(timeoutMs = 180_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const checks = await Promise.all(
      profiles.map(async (profile) => {
        try {
          const response = await fetch(profile.healthcheckUrl, {
            headers: {
              Accept: "application/json",
            },
          });
          return response.ok;
        } catch {
          return false;
        }
      }),
    );

    if (checks.every(Boolean)) {
      return;
    }

    await sleep(1_000);
  }

  throw new Error(
    `OSRM services were not ready within ${Math.round(timeoutMs / 1000)} seconds.`,
  );
}

export async function ensureOsrmReady() {
  await ensureDockerAvailable();
  await prepareOsrmData();

  const alreadyRunning = await isOsrmRunning();
  if (!alreadyRunning) {
    const sharedMemoryProfile = profiles.find(
      (profile) => profile.sharedMemoryDatasetName,
    );
    if (sharedMemoryProfile) {
      console.log(
        `[osrm] loading shared-memory dataset for ${sharedMemoryProfile.key}`,
      );
      await loadSharedMemoryDataset(sharedMemoryProfile);
    }

    console.log("[osrm] starting containers");
    await startOsrmService();
  } else {
    console.log("[osrm] containers already running");
  }

  console.log("[osrm] waiting for routing services");
  await waitForOsrmReady();

  return {
    alreadyRunning,
    startedByScript: !alreadyRunning,
    datasetPaths: profiles.map((profile) => path.join(osrmDir, `${profile.datasetName}.osrm`)),
  };
}

async function main() {
  const command = process.argv[2] ?? "up";

  try {
    if (command === "up") {
      const result = await ensureOsrmReady();
      console.log(
        `[osrm] ready (${result.startedByScript ? "started" : "already running"}) datasets=${result.datasetPaths.join(", ")}`,
      );
      return;
    }

    if (command === "prepare") {
      await ensureDockerAvailable();
      await prepareOsrmData();
      console.log(
        `[osrm] datasets ready: ${profiles.map((profile) => `${profile.datasetName}.osrm`).join(", ")}`,
      );
      return;
    }

    if (command === "stop") {
      await stopOsrmService();
      console.log("[osrm] stopped");
      return;
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    console.error(
      `[osrm] failed: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { repoRoot };
