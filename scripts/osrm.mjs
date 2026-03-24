import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
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
const osrmPath = path.join(osrmDir, `${datasetBaseName}.osrm`);
const extractUrl =
  process.env.OSRM_EXTRACT_URL ??
  "https://tiles.osm.kr/download/jeju-non-military.osm.pbf";
const healthcheckUrl =
  process.env.OSRM_HEALTHCHECK_URL ??
  "http://localhost:5000/route/v1/foot/126.5312,33.4996;126.5331,33.5007?overview=false";
const dockerImage =
  process.env.OSRM_DOCKER_IMAGE ?? "ghcr.io/project-osrm/osrm-backend:latest";
const requiredArtifacts = [
  `${datasetBaseName}.osrm.cells`,
  `${datasetBaseName}.osrm.cell_metrics`,
  `${datasetBaseName}.osrm.cnbg`,
  `${datasetBaseName}.osrm.cnbg_to_ebg`,
  `${datasetBaseName}.osrm.datasource_names`,
  `${datasetBaseName}.osrm.ebg`,
  `${datasetBaseName}.osrm.ebg_nodes`,
  `${datasetBaseName}.osrm.edges`,
  `${datasetBaseName}.osrm.enw`,
  `${datasetBaseName}.osrm.fileIndex`,
  `${datasetBaseName}.osrm.geometry`,
  `${datasetBaseName}.osrm.icd`,
  `${datasetBaseName}.osrm.mldgr`,
  `${datasetBaseName}.osrm.names`,
  `${datasetBaseName}.osrm.nbg_nodes`,
  `${datasetBaseName}.osrm.partition`,
  `${datasetBaseName}.osrm.properties`,
  `${datasetBaseName}.osrm.ramIndex`,
  `${datasetBaseName}.osrm.restrictions`,
  `${datasetBaseName}.osrm.timestamp`,
  `${datasetBaseName}.osrm.tld`,
  `${datasetBaseName}.osrm.tls`,
  `${datasetBaseName}.osrm.turn_duration_penalties`,
  `${datasetBaseName}.osrm.turn_penalties_index`,
  `${datasetBaseName}.osrm.turn_weight_penalties`,
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

      const output = captureOutput
        ? `${stdout.join("")}${stderr.join("")}`.trim()
        : "";
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

async function hasPreparedDataset() {
  for (const fileName of requiredArtifacts) {
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
      `OSRM 지도 원본 다운로드에 실패했습니다 (${response.status} ${response.statusText}).`,
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

async function runOsrmTool(args) {
  const mount = `type=bind,source=${dockerPath(osrmDir)},target=/data`;
  await runCommand("docker", ["run", "--rm", "--mount", mount, dockerImage, ...args]);
}

async function prepareOsrmData() {
  await mkdir(osrmDir, { recursive: true });
  if (await hasPreparedDataset()) {
    console.log("[osrm] dataset already prepared");
    return;
  }

  await downloadExtractIfMissing();

  console.log("[osrm] running osrm-extract");
  await runOsrmTool([
    "osrm-extract",
    "-p",
    "/opt/foot.lua",
    `/data/${pbfFileName}`,
  ]);

  console.log("[osrm] running osrm-partition");
  await runOsrmTool(["osrm-partition", `/data/${datasetBaseName}.osrm`]);

  console.log("[osrm] running osrm-customize");
  await runOsrmTool(["osrm-customize", `/data/${datasetBaseName}.osrm`]);
}

export async function isOsrmRunning() {
  const result = await runCommand(
    "docker",
    ["compose", "ps", "--status", "running", "-q", "osrm"],
    { captureOutput: true },
  );
  return result.stdout.trim().length > 0;
}

export async function startOsrmService() {
  await runCommand("docker", ["compose", "up", "-d", "osrm"]);
}

export async function stopOsrmService() {
  try {
    await runCommand("docker", ["compose", "stop", "osrm"]);
  } catch (error) {
    console.warn(`[osrm] stop skipped: ${formatCause(error)}`);
  }
}

export async function waitForOsrmReady(timeoutMs = 180_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthcheckUrl, {
        headers: {
          Accept: "application/json",
        },
      });

      if (response.ok) {
        return;
      }
    } catch {
      // Ignore until timeout because the container may still be booting.
    }

    await sleep(1_000);
  }

  throw new Error(
    `OSRM 서버가 ${Math.round(timeoutMs / 1000)}초 안에 준비되지 않았습니다. healthcheck=${healthcheckUrl}`,
  );
}

export async function ensureOsrmReady() {
  await ensureDockerAvailable();
  await prepareOsrmData();

  const alreadyRunning = await isOsrmRunning();
  if (!alreadyRunning) {
    console.log("[osrm] starting container");
    await startOsrmService();
  } else {
    console.log("[osrm] container already running");
  }

  console.log("[osrm] waiting for routing service");
  await waitForOsrmReady();

  return {
    alreadyRunning,
    startedByScript: !alreadyRunning,
    datasetPath: osrmPath,
  };
}

async function main() {
  const command = process.argv[2] ?? "up";

  try {
    if (command === "up") {
      const result = await ensureOsrmReady();
      console.log(
        `[osrm] ready (${result.startedByScript ? "started" : "already running"}) dataset=${result.datasetPath}`,
      );
      return;
    }

    if (command === "prepare") {
      await ensureDockerAvailable();
      await prepareOsrmData();
      console.log(`[osrm] dataset ready: ${osrmPath}`);
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
