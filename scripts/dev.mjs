import { spawn } from "node:child_process";
import { ensureOsrmReady, repoRoot, stopOsrmService } from "./osrm.mjs";

function buildAppArgs() {
  const forwarded = process.argv.slice(2);
  const hasPort = forwarded.includes("--port") || forwarded.includes("-p");

  return [
    "run",
    "dev:app",
    "--",
    ...(hasPort ? [] : ["--port", "5176"]),
    ...forwarded,
  ];
}

async function main() {
  let osrmStartedByScript = false;

  try {
    const status = await ensureOsrmReady();
    osrmStartedByScript = status.startedByScript;
  } catch (error) {
    console.error(
      `[dev] failed to start OSRM: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    process.exit(1);
  }

  console.log("[dev] starting Next.js dev server");
  const child =
    process.platform === "win32"
      ? spawn("cmd.exe", ["/d", "/s", "/c", "npm", ...buildAppArgs()], {
          cwd: repoRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        })
      : spawn("npm", buildAppArgs(), {
          cwd: repoRoot,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });

  const outputChunks = [];
  child.stdout.on("data", (chunk) => {
    outputChunks.push(String(chunk));
    process.stdout.write(chunk);
  });
  child.stderr.on("data", (chunk) => {
    outputChunks.push(String(chunk));
    process.stderr.write(chunk);
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.on("SIGINT", () => {
    forwardSignal("SIGINT");
  });

  process.on("SIGTERM", () => {
    forwardSignal("SIGTERM");
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      resolve(code ?? 0);
    });
  }).catch((error) => {
    console.error(
      `[dev] failed to start Next.js: ${error instanceof Error ? error.message : "unknown error"}`,
    );
    return 1;
  });

  const combinedOutput = outputChunks.join("");
  const alreadyRunningNext =
    combinedOutput.includes("Another next dev server is already running.");
  const portInUse = combinedOutput.includes("EADDRINUSE");

  if (alreadyRunningNext) {
    console.log("[dev] Next.js dev server is already running for this workspace.");
  } else if (portInUse) {
    console.error(
      "[dev] The requested port is already in use. Stop the existing process or run `npm run dev -- --port <other-port>`.",
    );
  }

  if (osrmStartedByScript && !alreadyRunningNext) {
    await stopOsrmService();
  }

  process.exit(alreadyRunningNext ? 0 : exitCode);
}

await main();
