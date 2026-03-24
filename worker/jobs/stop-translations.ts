import * as XLSX from "xlsx";
import { loadJsonSource, loadWorkbook } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { normalizeNameKey, normalizeText } from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type NormalizedStopTranslation = {
  stopKey: string;
  language: string;
  displayName: string;
};

export function parseStopTranslationsWorkbook(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
  });

  return rows
    .map((row) => ({
      stopKey: normalizeNameKey(row.stopId ?? row.stopName ?? row.name),
      language: normalizeText(row.language ?? row.lang ?? row.locale).toLowerCase() || "en",
      displayName: normalizeText(row.displayName ?? row.translation ?? row.nameEn),
    }))
    .filter((row): row is NormalizedStopTranslation => Boolean(
      row.stopKey && row.language && row.displayName,
    ));
}

function parseStopTranslationsJson(rows: Record<string, unknown>[]) {
  return rows
    .map((row) => ({
      stopKey: normalizeNameKey(row.stopId ?? row.stopName ?? row.name),
      language: normalizeText(row.language ?? row.lang ?? row.locale).toLowerCase() || "en",
      displayName: normalizeText(row.displayName ?? row.translation ?? row.nameEn),
    }))
    .filter((row): row is NormalizedStopTranslation => Boolean(
      row.stopKey && row.language && row.displayName,
    ));
}

export async function runStopTranslationsJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  if (!runtime.env.stopTranslationsXlsxPath) {
    return {
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      meta: {
        source: "overlay-disabled",
      },
    };
  }

  const source = runtime.env.stopTranslationsXlsxPath;
  const value = await (runtime.env.stopTranslationsXlsxPath.toLowerCase().endsWith(".json")
    ? loadJsonSource<Record<string, unknown>[]>(runtime.env.stopTranslationsXlsxPath)
    : loadWorkbook(runtime.env.stopTranslationsXlsxPath));

  const rows = Array.isArray(value)
    ? parseStopTranslationsJson(value as Record<string, unknown>[])
    : parseStopTranslationsWorkbook(value);

  if (rows.length === 0) {
    return {
      processedCount: 0,
      successCount: 0,
      failureCount: 0,
      meta: {
        source,
      },
    };
  }

  const stops = await runtime.prisma.stop.findMany();
  const stopByKey = new Map(
    stops.flatMap((stop) => [
      [normalizeNameKey(stop.id), stop],
      [normalizeNameKey(stop.displayName), stop],
    ]),
  );

  let successCount = 0;
  let failureCount = 0;

  for (const row of rows) {
    const stop = stopByKey.get(row.stopKey);
    if (!stop) {
      failureCount += 1;
      continue;
    }

    await runtime.prisma.stopTranslation.upsert({
      where: {
        stopId_language: {
          stopId: stop.id,
          language: row.language,
        },
      },
      update: {
        displayName: row.displayName,
      },
      create: {
        stopId: stop.id,
        language: row.language,
        displayName: row.displayName,
      },
    });
    successCount += 1;
  }

  return {
    processedCount: rows.length,
    successCount,
    failureCount,
    meta: {
      source,
    },
  };
}
