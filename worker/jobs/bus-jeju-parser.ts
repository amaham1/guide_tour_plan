import * as cheerio from "cheerio";
import {
  median,
  minutesToClock,
  normalizeText,
  parseClockToMinutes,
  toKoreanDate,
} from "@/worker/jobs/helpers";

export type RouteSearchItem = {
  scheduleId: string;
  shortName: string;
  label: string;
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
};

export type RawScheduleCell = {
  ROW_SEQ: number | string;
  COLUMN_SEQ: number | string;
  COLUMN_NM: string | null;
};

export type ParsedScheduleTable = {
  stopNames: string[];
  trips: Array<{
    rowLabel: string;
    times: Array<string | null>;
    estimatedColumns: number[];
  }>;
};

function parseBusType(html: string) {
  const match = html.match(/switch\((\d+)\)/);
  return match ? Number(match[1]) : null;
}

function isIgnoredScheduleHeader(value: string | null | undefined) {
  const normalized = normalizeText(value).replace(/\s+/g, "");
  return (
    !normalized ||
    normalized === "비고" ||
    normalized === "노선번호" ||
    /^(\d{2,4}(?:-\d+)?)번/.test(normalized)
  );
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
    const shortNameMatch = label.match(/(\d{2,4})/);
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
  const shortName = normalizeText($(".route-num").first().text()).replace(/번$/, "");
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
    displayName: waypointText ? `${shortName} ${waypointText}` : `${shortName} 노선`,
  };
}

function computeTypicalLegDurations(rows: Array<Array<number | null>>) {
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
    filled[index] = (filled[index + 1] ?? firstKnown.value) - typicalDurations[index];
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
      totalWeight += typicalDurations[index];
    }

    let accumulated = 0;
    for (let index = start.index + 1; index < end.index; index += 1) {
      accumulated += typicalDurations[index - 1];
      const ratio = totalWeight === 0 ? 0 : accumulated / totalWeight;
      filled[index] = Math.round(start.value + (end.value - start.value) * ratio);
      estimated.add(index);
    }
  }

  const lastKnown = knownIndexes[knownIndexes.length - 1];
  for (let index = lastKnown.index + 1; index < filled.length; index += 1) {
    filled[index] = (filled[index - 1] ?? lastKnown.value) + typicalDurations[index - 1];
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
      trips: [],
    } satisfies ParsedScheduleTable;
  }

  const validColumns = [...header.entries()]
    .sort((left, right) => left[0] - right[0])
    .filter(([, columnName]) => !isIgnoredScheduleHeader(columnName))
    .map(([columnSeq]) => columnSeq);

  const stopNames = validColumns.map((columnSeq) => normalizeText(header.get(columnSeq)));

  const rawTimes = [...grouped.entries()]
    .filter(([rowSeq]) => rowSeq > 0)
    .sort((left, right) => left[0] - right[0])
    .map(([rowSeq, cells]) => ({
      rowLabel: String(rowSeq),
      times: validColumns.map((columnSeq) => {
        const value = cells.get(columnSeq);
        return value ? parseClockToMinutes(value) : null;
      }),
    }));

  const typicalDurations = computeTypicalLegDurations(rawTimes.map((row) => row.times));

  return {
    stopNames,
    trips: rawTimes.map((row) => {
      const filled = fillScheduleRow(row.times, typicalDurations);
      return {
        rowLabel: row.rowLabel,
        times: filled.times.map((value) => (value === null ? null : minutesToClock(value))),
        estimatedColumns: filled.estimatedColumns,
      };
    }),
  } satisfies ParsedScheduleTable;
}
