import * as cheerio from "cheerio";
import {
  median,
  minutesToClock,
  normalizeText,
  parseClockToMinutes,
  toKoreanDate,
} from "@/worker/jobs/helpers";
import { extractPrimaryRouteShortNameToken, extractRouteShortNameTokens } from "@/worker/jobs/route-labels";

export type RouteSearchItem = {
  scheduleId: string;
  shortName: string;
  label: string;
};

export type RouteDetailVariant = {
  variantKey: string;
  shortName: string;
  viaText: string | null;
  viaStops: string[];
  serviceNote: string | null;
};

export type RouteDetail = {
  scheduleId: string;
  shortName: string;
  viaText: string | null;
  waypointText: string | null;
  serviceNote: string | null;
  effectiveDate: Date | null;
  busType: number | null;
  directionLabel: string;
  displayName: string;
  terminalHint: {
    origin: string | null;
    destination: string | null;
  };
  variants: RouteDetailVariant[];
};

export type RawScheduleCell = {
  ROW_SEQ: number | string;
  COLUMN_SEQ: number | string;
  COLUMN_NM: string | null;
};

export type ParsedScheduleTrip = {
  rowLabel: string;
  rowSequence: number;
  variantKey: string;
  rawVariantLabel: string;
  rawValues: Array<string | null>;
  times: Array<string | null>;
  estimatedColumns: number[];
};

export type ParsedScheduleVariant = {
  variantKey: string;
  rawVariantLabel: string;
  trips: ParsedScheduleTrip[];
};

export type ParsedScheduleTable = {
  stopNames: string[];
  variants: ParsedScheduleVariant[];
};

function parseBusType(html: string) {
  const match = html.match(/switch\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

function isIgnoredScheduleHeader(value: string | null | undefined) {
  const normalized = normalizeText(value).replace(/\s+/g, "");
  return (
    !normalized ||
    normalized === "\uBE44\uACE0" ||
    normalized === "\uB178\uC120\uBC88\uD638" ||
    /^(\d{2,4}(?:-\d+)?)\uBC88?(?:\(.+\))?$/.test(normalized)
  );
}

function normalizeVariantLabel(value: string | null | undefined) {
  return normalizeText(value).replace(/\s+/g, " ").trim();
}

function parseVariantBlocks(value: string | null) {
  const blocks = new Map<string, string>();
  const normalized = normalizeText(value);

  if (!normalized) {
    return blocks;
  }

  const matches = [
    ...normalized.matchAll(/\[(\d{2,4}(?:-\d+)?)\uBC88?\]\s*([\s\S]*?)(?=\[\d{2,4}(?:-\d+)?\uBC88?\]|$)/g),
  ];

  for (const match of matches) {
    const variantKey = match[1];
    const text = normalizeText(match[2]);
    if (variantKey && text) {
      blocks.set(variantKey, text);
    }
  }

  return blocks;
}

export function extractViaStops(value: string | null | undefined) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return [];
  }

  return [
    ...new Set(
      normalized
        .split(/\s*(?:\u2192|->|-)\s*/)
        .map((item) => normalizeText(item))
        .filter((item) => item.length >= 2),
    ),
  ];
}

export function buildTerminalHint(waypointText: string | null | undefined) {
  const normalized = normalizeText(waypointText);
  if (!normalized) {
    return {
      origin: null,
      destination: null,
    };
  }

  const segments = normalized
    .split(/\s*(?:\u2192|->)\s*/)
    .map((item) => normalizeText(item))
    .filter(Boolean);

  if (segments.length < 2) {
    return {
      origin: null,
      destination: null,
    };
  }

  return {
    origin: segments[0] ?? null,
    destination: segments[segments.length - 1] ?? null,
  };
}

function buildRouteVariants(shortName: string, viaText: string | null, serviceNote: string | null) {
  const routeTokens = extractRouteShortNameTokens(shortName);
  const viaBlocks = parseVariantBlocks(viaText);
  const serviceBlocks = parseVariantBlocks(serviceNote);
  const variantKeys = new Set<string>([
    ...routeTokens,
    ...viaBlocks.keys(),
    ...serviceBlocks.keys(),
  ]);

  if (variantKeys.size === 0) {
    return [
      {
        variantKey: "default",
        shortName,
        viaText,
        viaStops: extractViaStops(viaText),
        serviceNote,
      },
    ] satisfies RouteDetailVariant[];
  }

  return [...variantKeys].map((variantKey) => {
    const variantViaText = viaBlocks.get(variantKey) ?? (variantKeys.size === 1 ? viaText : null);
    return {
      variantKey,
      shortName: variantKey,
      viaText: variantViaText,
      viaStops: extractViaStops(variantViaText),
      serviceNote: serviceBlocks.get(variantKey) ?? (variantKeys.size === 1 ? serviceNote : null),
    };
  }) satisfies RouteDetailVariant[];
}

export function parseRouteSearchHtml(html: string) {
  const $ = cheerio.load(html);
  const results = new Map<string, RouteSearchItem>();

  $("a[href*='detailSchedule?scheduleId=']").each((_, element) => {
    const href = $(element).attr("href") ?? "";
    const match = href.match(/scheduleId=(\d+)/);
    if (!match) {
      return;
    }

    const label = normalizeText($(element).text());
    const shortNameMatch = label.match(/(\d{2,4}(?:-\d+)?)/);
    const shortName = shortNameMatch?.[1] ?? match[1];

    results.set(match[1], {
      scheduleId: match[1],
      shortName,
      label,
    });
  });

  return [...results.values()];
}

export function parseRouteDetailHtml(html: string, scheduleId: string): RouteDetail {
  const $ = cheerio.load(html);
  const shortName = normalizeText($(".route-num").first().text());
  const viaText = normalizeText($(".rotue-via").first().text()) || null;
  const waypointText = normalizeText($(".route-waypoint").first().text()) || null;
  const routeDesc = $(".route-desc")
    .toArray()
    .map((element) => normalizeText($(element).text()))
    .filter(Boolean);
  const serviceNote = routeDesc[0] ?? null;
  const effectiveDate =
    routeDesc
      .map((item) => toKoreanDate(item))
      .find((item): item is Date => item instanceof Date) ?? null;

  return {
    scheduleId,
    shortName,
    viaText,
    waypointText,
    serviceNote,
    effectiveDate,
    busType: parseBusType(html),
    directionLabel: waypointText ?? shortName,
    displayName: waypointText ? `${shortName} ${waypointText}` : `${shortName} route`,
    terminalHint: buildTerminalHint(waypointText),
    variants: buildRouteVariants(shortName, viaText, serviceNote),
  };
}

function computeTypicalLegDurations(rows: Array<Array<number | null>>) {
  if (rows.length === 0) {
    return [];
  }

  const durations: number[] = [];

  for (let index = 0; index < rows[0].length - 1; index += 1) {
    const samples: number[] = [];
    for (const row of rows) {
      const current = row[index];
      const next = row[index + 1];
      if (current !== null && next !== null && next >= current) {
        samples.push(next - current);
      }
    }

    durations.push(median(samples) ?? 6);
  }

  return durations;
}

function fillScheduleRow(times: Array<number | null>, typicalDurations: number[]) {
  const filled = [...times];
  const estimated = new Set<number>();

  const knownIndexes = filled
    .map((value, index) => ({ value, index }))
    .filter((item): item is { value: number; index: number } => item.value !== null);

  if (knownIndexes.length === 0) {
    return {
      times: filled.map(() => null),
      estimatedColumns: [],
    };
  }

  const firstKnown = knownIndexes[0];
  for (let index = firstKnown.index - 1; index >= 0; index -= 1) {
    filled[index] = (filled[index + 1] ?? firstKnown.value) - (typicalDurations[index] ?? 6);
    estimated.add(index);
  }

  for (let cursor = 0; cursor < knownIndexes.length - 1; cursor += 1) {
    const start = knownIndexes[cursor];
    const end = knownIndexes[cursor + 1];
    if (end.index - start.index <= 1) {
      continue;
    }

    let totalWeight = 0;
    for (let index = start.index; index < end.index; index += 1) {
      totalWeight += typicalDurations[index] ?? 6;
    }

    let accumulated = 0;
    for (let index = start.index + 1; index < end.index; index += 1) {
      accumulated += typicalDurations[index - 1] ?? 6;
      const ratio = totalWeight === 0 ? 0 : accumulated / totalWeight;
      filled[index] = Math.round(start.value + (end.value - start.value) * ratio);
      estimated.add(index);
    }
  }

  const lastKnown = knownIndexes[knownIndexes.length - 1];
  for (let index = lastKnown.index + 1; index < filled.length; index += 1) {
    filled[index] = (filled[index - 1] ?? lastKnown.value) + (typicalDurations[index - 1] ?? 6);
    estimated.add(index);
  }

  return {
    times: filled,
    estimatedColumns: [...estimated.values()],
  };
}

export function parseScheduleTableRows(rows: RawScheduleCell[]) {
  const grouped = new Map<number, Map<number, string | null>>();

  for (const row of rows) {
    const rowSeq = Number(row.ROW_SEQ);
    const columnSeq = Number(row.COLUMN_SEQ);
    const current = grouped.get(rowSeq) ?? new Map<number, string | null>();
    current.set(columnSeq, normalizeText(row.COLUMN_NM) || null);
    grouped.set(rowSeq, current);
  }

  const header = grouped.get(0);
  if (!header) {
    return {
      stopNames: [],
      variants: [],
    } satisfies ParsedScheduleTable;
  }

  const orderedHeaderColumns = [...header.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([columnSeq, columnName]) => ({
      columnSeq,
      isVariantColumn: isIgnoredScheduleHeader(columnName),
    }));

  const variantColumnSeq =
    orderedHeaderColumns.find((column) => column.isVariantColumn)?.columnSeq ?? null;
  const stopColumns = orderedHeaderColumns
    .filter((column) => !column.isVariantColumn)
    .map((column) => column.columnSeq);
  const stopNames = stopColumns.map((columnSeq) => normalizeText(header.get(columnSeq)));

  const rawRows = [...grouped.entries()]
    .filter(([rowSeq]) => rowSeq > 0)
    .sort((left, right) => left[0] - right[0])
    .map(([rowSeq, cells]) => ({
      rowSequence: rowSeq,
      rawVariantLabel:
        normalizeVariantLabel(variantColumnSeq === null ? null : cells.get(variantColumnSeq)) ||
        "default",
      rawValues: stopColumns.map((columnSeq) => normalizeText(cells.get(columnSeq)) || null),
      times: stopColumns.map((columnSeq) => {
        const value = cells.get(columnSeq);
        return value ? parseClockToMinutes(value) : null;
      }),
    }));

  const typicalDurations = computeTypicalLegDurations(rawRows.map((row) => row.times));
  const variants = new Map<string, ParsedScheduleVariant>();

  for (const row of rawRows) {
    const filled = fillScheduleRow(row.times, typicalDurations);
    const variantKey = extractPrimaryRouteShortNameToken(row.rawVariantLabel) ?? "default";
    const current = variants.get(variantKey) ?? {
      variantKey,
      rawVariantLabel: row.rawVariantLabel,
      trips: [],
    };

    current.trips.push({
      rowLabel: row.rawVariantLabel,
      rowSequence: row.rowSequence,
      variantKey,
      rawVariantLabel: row.rawVariantLabel,
      rawValues: row.rawValues,
      times: filled.times.map((value) => (value === null ? null : minutesToClock(value))),
      estimatedColumns: filled.estimatedColumns,
    });
    variants.set(variantKey, current);
  }

  return {
    stopNames,
    variants: [...variants.values()],
  } satisfies ParsedScheduleTable;
}
