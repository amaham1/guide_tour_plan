import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { XMLParser } from "fast-xml-parser";
import * as XLSX from "xlsx";
import { fetchBuffer, fetchPlainText, isRemoteSource } from "@/worker/core/fetch";

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  trimValues: true,
});

async function readSourceBuffer(source: string) {
  if (isRemoteSource(source)) {
    return fetchBuffer(source);
  }

  return fs.readFile(path.resolve(source));
}

async function readSourceText(source: string) {
  if (isRemoteSource(source)) {
    return fetchPlainText(source);
  }

  return fs.readFile(path.resolve(source), "utf8");
}

export async function loadJsonSource<T>(source: string) {
  return JSON.parse(await readSourceText(source)) as T;
}

export async function loadCsvSource<T extends Record<string, string>>(source: string) {
  const text = await readSourceText(source);
  return parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    bom: true,
  }) as T[];
}

export async function loadXmlSource<T>(source: string) {
  return xmlParser.parse(await readSourceText(source)) as T;
}

export async function loadHtmlSource(source: string) {
  return readSourceText(source);
}

export async function loadWorkbook(source: string) {
  const buffer = await readSourceBuffer(source);
  return XLSX.read(buffer, { type: "buffer" });
}

export async function loadStructuredSource<T = unknown>(source: string) {
  const normalized = source.toLowerCase();

  if (normalized.endsWith(".json")) {
    return loadJsonSource<T>(source);
  }

  if (normalized.endsWith(".csv")) {
    return loadCsvSource(source);
  }

  if (normalized.endsWith(".xml")) {
    return loadXmlSource<T>(source);
  }

  if (normalized.endsWith(".xlsx") || normalized.endsWith(".xls")) {
    return loadWorkbook(source);
  }

  return loadHtmlSource(source);
}
