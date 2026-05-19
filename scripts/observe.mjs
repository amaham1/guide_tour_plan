import { spawn } from "node:child_process";
import { once } from "node:events";
import { ensureOsrmReady, repoRoot, stopOsrmService } from "./osrm.mjs";

const restartDelayMs = 5_000;
const shouldSkipOsrm = process.argv.includes("--no-osrm");
const loopJobs = [
  {
    key: "vehicle-device-map",
    args: ["run", "worker", "--", "--job", "vehicle-device-map", "--loop"],
  },
  {
    key: "gnss-history",
    args: ["run", "worker", "--", "--job", "gnss-history", "--loop"],
  },
  {
    key: "segment-profiles",
    args: [
      "run",
      "worker",
      "--",
      "--job",
      "segment-profiles",
      "--loop",
      "--interval-ms",
      "3600000",
    ],
  },
];

let shuttingDown = false;
let osrmStartedByScript = false;
const children = new Map();

function npmCommand(args) {
  return process.platform === "win32"
    ? {
        command: "cmd.exe",
        args: ["/d", "/s", "/c", "npm", ...args],
      }
    : {
        command: "npm",
        args,
      };
}

function prefixStream(stream, prefix, output) {
  let pending = "";
  stream.on("data", (chunk) => {
    pending += String(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";

    for (const line of lines) {
      if (line.length > 0) {
        output.write(`[${prefix}] ${line}\n`);
      }
    }
  });

  stream.on("end", () => {
    if (pending.length > 0) {
      output.write(`[${prefix}] ${pending}\n`);
    }
  });
}

function spawnNpm(label, args) {
  const command = npmCommand(args);
  const child = spawn(command.command, command.args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  prefixStream(child.stdout, label, process.stdout);
  prefixStream(child.stderr, label, process.stderr);
  return child;
}

function startLoop(job) {
  if (shuttingDown) {
    return;
  }

  console.log(`[observe] starting ${job.key}`);
  const child = spawnNpm(job.key, job.args);
  children.set(job.key, child);

  child.on("close", (code) => {
    children.delete(job.key);
    if (shuttingDown) {
      return;
    }

    console.error(
      `[observe] ${job.key} stopped with code ${code ?? "unknown"}; restarting in ${
        restartDelayMs / 1000
      }s`,
    );
    setTimeout(() => startLoop(job), restartDelayMs);
  });
}

async function stopChild(child) {
  if (child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    const taskkill = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
      stdio: "ignore",
    });
    await once(taskkill, "close").catch(() => undefined);
    return;
  }

  child.kill("SIGTERM");
}

async function shutdown() {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  console.log("[observe] stopping collectors");
  await Promise.all([...children.values()].map((child) => stopChild(child)));

  if (osrmStartedByScript) {
    await stopOsrmService();
  }

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown();
});
process.on("SIGTERM", () => {
  void shutdown();
});

async function main() {
  if (!shouldSkipOsrm) {
    const status = await ensureOsrmReady();
    osrmStartedByScript = status.startedByScript;
  } else {
    console.log("[observe] skipping OSRM startup (--no-osrm)");
  }

  for (const job of loopJobs) {
    startLoop(job);
  }

  console.log("[observe] collectors are running. vehicle-device-map may take a while, but GNSS starts immediately. Press Ctrl+C to stop.");
}

await main().catch((error) => {
  console.error(`[observe] failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exit(1);
});
