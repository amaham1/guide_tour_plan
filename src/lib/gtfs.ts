import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";
import { parse as parseCsv } from "csv-parse/sync";
import { fetchBuffer, isRemoteSource } from "@/worker/core/fetch";

export type GtfsTextSet = {
  source: string;
  routes: string | null;
  trips: string | null;
  stopTimes: string | null;
  stops: string | null;
  shapes: string | null;
};

export type GtfsProbeResult = {
  source: string;
  detectedFormat: "zip" | "directory";
  availableFiles: string[];
  missingFiles: string[];
  counts: {
    routes: number;
    trips: number;
    stopTimes: number;
    stops: number;
    shapes: number;
  } | null;
  sampleRouteShortNames: string[];
};

export function parseGtfsRows<T extends Record<string, string>>(text: string) {
  return parseCsv(text, {
    bom: true,
    columns: true,
    skip_empty_lines: true,
  }) as T[];
}

async function loadZipEntries(source: string) {
  const buffer = isRemoteSource(source)
    ? await fetchBuffer(source)
    : await fs.readFile(path.resolve(source));
  return new AdmZip(buffer);
}

function readZipText(zip: AdmZip, name: string) {
  const entry = zip
    .getEntries()
    .find(
      (item: AdmZip.IZipEntry) =>
        item.entryName.toLowerCase().endsWith(`/${name}`) || item.entryName.toLowerCase() === name,
    );

  if (!entry) {
    return null;
  }

  return entry.getData().toString("utf8");
}

async function readDirectoryText(basePath: string, name: string) {
  const candidates = [
    path.resolve(basePath, name),
    path.resolve(path.dirname(basePath), name),
  ];

  for (const candidate of candidates) {
    try {
      return await fs.readFile(candidate, "utf8");
    } catch {
      continue;
    }
  }

  return null;
}

export async function loadGtfsTextSet(source: string): Promise<GtfsTextSet> {
  if (source.toLowerCase().endsWith(".zip")) {
    const zip = await loadZipEntries(source);
    return {
      source,
      routes: readZipText(zip, "routes.txt"),
      trips: readZipText(zip, "trips.txt"),
      stopTimes: readZipText(zip, "stop_times.txt"),
      stops: readZipText(zip, "stops.txt"),
      shapes: readZipText(zip, "shapes.txt"),
    };
  }

  const routes = await readDirectoryText(source, "routes.txt");
  const trips = await readDirectoryText(source, "trips.txt");
  const stopTimes = await readDirectoryText(source, "stop_times.txt");
  const stops = await readDirectoryText(source, "stops.txt");
  const shapes = await readDirectoryText(source, "shapes.txt");

  return {
    source,
    routes,
    trips,
    stopTimes,
    stops,
    shapes,
  };
}

export async function probeGtfsSource(source: string): Promise<GtfsProbeResult> {
  const textSet = await loadGtfsTextSet(source);
  const fileMap = {
    "routes.txt": textSet.routes,
    "trips.txt": textSet.trips,
    "stop_times.txt": textSet.stopTimes,
    "stops.txt": textSet.stops,
    "shapes.txt": textSet.shapes,
  } as const;

  const availableFiles = Object.entries(fileMap)
    .filter(([, value]) => Boolean(value))
    .map(([name]) => name);
  const missingFiles = Object.entries(fileMap)
    .filter(([, value]) => !value)
    .map(([name]) => name);

  if (missingFiles.length > 0) {
    return {
      source,
      detectedFormat: source.toLowerCase().endsWith(".zip") ? "zip" : "directory",
      availableFiles,
      missingFiles,
      counts: null,
      sampleRouteShortNames: [],
    };
  }

  const routes = parseGtfsRows<Record<string, string>>(textSet.routes ?? "");
  const trips = parseGtfsRows<Record<string, string>>(textSet.trips ?? "");
  const stopTimes = parseGtfsRows<Record<string, string>>(textSet.stopTimes ?? "");
  const stops = parseGtfsRows<Record<string, string>>(textSet.stops ?? "");
  const shapes = parseGtfsRows<Record<string, string>>(textSet.shapes ?? "");

  return {
    source,
    detectedFormat: source.toLowerCase().endsWith(".zip") ? "zip" : "directory",
    availableFiles,
    missingFiles,
    counts: {
      routes: routes.length,
      trips: trips.length,
      stopTimes: stopTimes.length,
      stops: stops.length,
      shapes: shapes.length,
    },
    sampleRouteShortNames: routes
      .map((row) => row.route_short_name?.trim())
      .filter((value): value is string => Boolean(value))
      .slice(0, 10),
  };
}
