import * as cheerio from "cheerio";
import {
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
  hasVariantColumn: boolean;
  concreteVariantRowCount: number;
  inheritedVariantRowCount: number;
  unresolvedVariantRowCount: number;
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

function looksLikeRouteLabel(value: string | null | undefined) {
  const normalized = normalizeVariantLabel(value);
  if (!normalized || parseClockToMinutes(normalized) !== null) {
    return false;
  }

  const compact = normalized.replace(/\s+/g, "");
  return (
    /^\d{2,4}(?:-\d+)?$/.test(compact) ||
    (extractPrimaryRouteShortNameToken(normalized) !== null && /(?:번|노선|\/|,|\[)/.test(normalized))
  );
}

function selectVariantColumnSeq(
  grouped: Map<number, Map<number, string | null>>,
  candidateColumnSeqs: number[],
) {
  let bestColumnSeq: number | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const columnSeq of candidateColumnSeqs) {
    const values = [...grouped.entries()]
      .filter(([rowSeq]) => rowSeq > 0)
      .map(([, cells]) => normalizeVariantLabel(cells.get(columnSeq)))
      .filter(Boolean);

    if (values.length === 0) {
      continue;
    }

    const routeLabelCount = values.filter((value) => looksLikeRouteLabel(value)).length;
    const timeLikeCount = values.filter((value) => parseClockToMinutes(value) !== null).length;

    if (routeLabelCount === 0) {
      continue;
    }

    const score = routeLabelCount * 10 - timeLikeCount * 3;
    if (score > bestScore) {
      bestScore = score;
      bestColumnSeq = columnSeq;
    }
  }

  return bestColumnSeq;
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
      hasVariantColumn: false,
      concreteVariantRowCount: 0,
      inheritedVariantRowCount: 0,
      unresolvedVariantRowCount: 0,
    } satisfies ParsedScheduleTable;
  }

  const orderedHeaderColumns = [...header.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([columnSeq, columnName]) => ({
      columnSeq,
      isVariantColumn: isIgnoredScheduleHeader(columnName),
    }));

  const variantColumnSeq = selectVariantColumnSeq(
    grouped,
    orderedHeaderColumns
      .filter((column) => column.isVariantColumn)
      .map((column) => column.columnSeq),
  );
  const stopColumns = orderedHeaderColumns
    .filter((column) => !column.isVariantColumn)
    .map((column) => column.columnSeq);
  const stopNames = stopColumns.map((columnSeq) => normalizeText(header.get(columnSeq)));
  const hasVariantColumn = variantColumnSeq !== null;
  let previousConcreteVariantKey: string | null = null;
  let concreteVariantRowCount = 0;
  let inheritedVariantRowCount = 0;
  let unresolvedVariantRowCount = 0;

  const rawRows = [...grouped.entries()]
    .filter(([rowSeq]) => rowSeq > 0)
    .sort((left, right) => left[0] - right[0])
    .map(([rowSeq, cells]) => {
      const rawVariantLabel =
        normalizeVariantLabel(variantColumnSeq === null ? null : cells.get(variantColumnSeq)) ||
        "default";
      const explicitVariantKey = hasVariantColumn
        ? extractPrimaryRouteShortNameToken(rawVariantLabel)
        : null;
      const variantKey = explicitVariantKey
        ? explicitVariantKey
        : hasVariantColumn && previousConcreteVariantKey
          ? previousConcreteVariantKey
          : "default";

      if (explicitVariantKey) {
        previousConcreteVariantKey = explicitVariantKey;
        concreteVariantRowCount += 1;
      } else if (hasVariantColumn && previousConcreteVariantKey) {
        inheritedVariantRowCount += 1;
      } else if (hasVariantColumn) {
        unresolvedVariantRowCount += 1;
      }

      return {
        rowSequence: rowSeq,
        variantKey,
        rawVariantLabel,
        rawValues: stopColumns.map((columnSeq) => normalizeText(cells.get(columnSeq)) || null),
        times: stopColumns.map((columnSeq) => {
          const value = cells.get(columnSeq);
          return value ? parseClockToMinutes(value) : null;
        }),
      };
    });
  const variants = new Map<string, ParsedScheduleVariant>();

  for (const row of rawRows) {
    const current = variants.get(row.variantKey) ?? {
      variantKey: row.variantKey,
      rawVariantLabel: row.rawVariantLabel,
      trips: [],
    };

    current.trips.push({
      rowLabel: row.rawVariantLabel,
      rowSequence: row.rowSequence,
      variantKey: row.variantKey,
      rawVariantLabel: row.rawVariantLabel,
      rawValues: row.rawValues,
      times: row.times.map((value) => (value === null ? null : minutesToClock(value))),
      estimatedColumns: [],
    });
    if (current.rawVariantLabel === "default" && row.rawVariantLabel !== "default") {
      current.rawVariantLabel = row.rawVariantLabel;
    }
    variants.set(row.variantKey, current);
  }

  return {
    stopNames,
    variants: [...variants.values()],
    hasVariantColumn,
    concreteVariantRowCount,
    inheritedVariantRowCount,
    unresolvedVariantRowCount,
  } satisfies ParsedScheduleTable;
}
