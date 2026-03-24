import type { PlaceKind } from "@prisma/client";
import { loadStructuredSource } from "@/worker/core/files";
import type { WorkerRuntime } from "@/worker/core/runtime";
import {
  extractArray,
  normalizeText,
  toNumber,
  toSlug,
} from "@/worker/jobs/helpers";
import type { JobOutcome } from "@/worker/jobs/types";

type RawPlaceRecord = Record<string, unknown>;

type OpeningRule = {
  days: number[];
  open: string;
  close: string;
};

export type NormalizedOpeningHours = {
  alwaysOpen: boolean;
  closedDays: number[];
  rules: OpeningRule[];
  note?: string;
  raw: string;
};

type VisitJejuListResponse = {
  items?: RawPlaceRecord[];
  pageCount?: number;
};

type VisitJejuLiveSource = {
  pageUrl: string;
  cate1cd: string;
  category: PlaceKind;
};

const VISIT_JEJU_API_URL = "https://api.visitjeju.net/api/contents/list";
const PAGE_SIZE = 100;

const LIVE_SOURCES: VisitJejuLiveSource[] = [
  {
    pageUrl:
      "https://www.visitjeju.net/kr/detail/list?menuId=DOM_000001718000000000&cate1cd=cate0000000002",
    cate1cd: "cate0000000002",
    category: "TOUR",
  },
  {
    pageUrl:
      "https://www.visitjeju.net/kr/detail/list?menuId=DOM_000001719000000000&cate1cd=cate0000000005",
    cate1cd: "cate0000000005",
    category: "FOOD",
  },
  {
    pageUrl:
      "https://www.visitjeju.net/kr/detail/list?menuId=DOM_000001707000000000&cate1cd=cate0000000004",
    cate1cd: "cate0000000004",
    category: "STAY",
  },
];

const dayMap: Record<string, number[]> = {
  월: [1],
  화: [2],
  수: [3],
  목: [4],
  금: [5],
  토: [6],
  일: [0],
  평일: [1, 2, 3, 4, 5],
  주말: [0, 6],
  매일: [0, 1, 2, 3, 4, 5, 6],
};

function extractLabel(value: unknown) {
  if (typeof value === "string") {
    return normalizeText(value);
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return normalizeText(record.label ?? record.value);
  }

  return "";
}

function buildVisitJejuSlug(baseDisplayName: string, contentId: string | null) {
  const baseSlug = toSlug(baseDisplayName);
  if (!contentId) {
    return baseSlug;
  }

  return `${baseSlug}-${contentId.toLowerCase()}`;
}

function parseDayToken(raw: string) {
  const normalized = normalizeText(raw);
  if (dayMap[normalized]) {
    return dayMap[normalized];
  }

  const rangeMatch = normalized.match(/^([월화수목금토일])[-~]([월화수목금토일])$/);
  if (!rangeMatch) {
    return [];
  }

  const order = ["일", "월", "화", "수", "목", "금", "토"];
  const start = order.indexOf(rangeMatch[1]);
  const end = order.indexOf(rangeMatch[2]);
  if (start === -1 || end === -1) {
    return [];
  }

  const days: number[] = [];
  let current = start;
  while (true) {
    days.push(current);
    if (current === end) {
      break;
    }
    current = (current + 1) % 7;
  }
  return days;
}

export function parseOpeningHoursRaw(value: string | null | undefined) {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }

  if (/24\s*시간|상시|연중무휴/i.test(raw)) {
    return {
      alwaysOpen: true,
      closedDays: [],
      rules: [],
      raw,
    } satisfies NormalizedOpeningHours;
  }

  const closedDays = raw.includes("휴무")
    ? raw
        .split(/[,\s/]+/)
        .flatMap((token) =>
          token.includes("휴무") ? parseDayToken(token.replace("휴무", "")) : [],
        )
    : [];

  const rules: OpeningRule[] = [];
  const matches = raw.matchAll(
    /([월화수목금토일평일주말매일\-\~/]+)?\s*(\d{1,2}:\d{2})\s*[~-]\s*(\d{1,2}:\d{2})/g,
  );
  for (const match of matches) {
    const days = parseDayToken(match[1] ?? "매일");
    rules.push({
      days: days.length > 0 ? days : dayMap["매일"],
      open: match[2],
      close: match[3],
    });
  }

  return {
    alwaysOpen: false,
    closedDays,
    rules,
    raw,
    note: rules.length === 0 ? raw : undefined,
  } satisfies NormalizedOpeningHours;
}

function inferPlaceKind(record: RawPlaceRecord): PlaceKind {
  const forcedCategory = record.__forcedCategory;
  if (
    forcedCategory === "TOUR" ||
    forcedCategory === "FOOD" ||
    forcedCategory === "STAY"
  ) {
    return forcedCategory;
  }

  const category = normalizeText(
    extractLabel(record.contentscd) ??
      record.contentscdLabel ??
      record.alltag ??
      record.theme,
  ).toLowerCase();

  if (/(맛집|음식|food|restaurant|cafe|cafe)/.test(category)) {
    return "FOOD";
  }

  if (/(숙박|stay|hotel|pension|resort)/.test(category)) {
    return "STAY";
  }

  return "TOUR";
}

function normalizePlaceRecord(record: RawPlaceRecord) {
  const contentId =
    normalizeText(
      record.contentsid ?? record.contentid ?? record.id ?? record.poiId ?? record.cid,
    ) || null;
  const baseDisplayName = normalizeText(
    record.title ?? record.name ?? record.displayName,
  );
  const latitude = toNumber(record.latitude ?? record.lat ?? record.y);
  const longitude = toNumber(record.longitude ?? record.lng ?? record.lon ?? record.x);

  if (!baseDisplayName || latitude === null || longitude === null) {
    return null;
  }

  const openingHoursRaw = normalizeText(
    record.openinghours ??
      record.usagehour ??
      record.openTime ??
      record.businessHours ??
      record.usehour,
  );
  const category = inferPlaceKind(record);
  const slug = buildVisitJejuSlug(baseDisplayName, contentId);

  return {
    id: contentId ? `visit-${contentId}` : `visit-${toSlug(baseDisplayName)}`,
    sourceContentId: contentId,
    slug,
    category,
    baseDisplayName,
    regionName:
      normalizeText(
        extractLabel(record.region1cd) ||
          extractLabel(record.region2cd) ||
          record.address ||
          record.regionName,
      ) || "제주",
    latitude,
    longitude,
    sourceUrl: contentId
      ? `https://www.visitjeju.net/kr/detail/view?contentsid=${contentId}`
      : null,
    openingHoursRaw: openingHoursRaw || null,
    openingHoursJson: parseOpeningHoursRaw(openingHoursRaw),
    summary: normalizeText(
      record.introduction ?? record.sbst ?? record.contentscdLabel ?? record.summary,
    ),
    categoryLabel:
      extractLabel(record.contentscd) ||
      (category === "TOUR" ? "관광지" : category === "FOOD" ? "음식점" : "숙소"),
    themeLabel: normalizeText(record.tag ?? record.theme ?? record.alltag) || null,
  };
}

async function bootstrapVisitJejuCookies(pageUrl: string) {
  const response = await fetch(pageUrl, {
    cache: "no-store",
    headers: {
      Accept: "text/html,application/xhtml+xml",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Codex/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(`Visit Jeju bootstrap failed: ${response.status} ${response.statusText}`);
  }

  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  return (headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .join("; ");
}

async function fetchVisitJejuListPage(
  source: VisitJejuLiveSource,
  page: number,
  cookies: string,
) {
  const requestUrl = new URL(VISIT_JEJU_API_URL);
  requestUrl.searchParams.set("_siteId", "jejuavj");
  requestUrl.searchParams.set("locale", "kr");
  requestUrl.searchParams.set("device", "pc");
  requestUrl.searchParams.set("cate1cd", source.cate1cd);
  requestUrl.searchParams.set("tag", "");
  requestUrl.searchParams.set("sorting", "markcnt desc, title_kr asc");
  requestUrl.searchParams.set("region1cd", "");
  requestUrl.searchParams.set("region2cd", "");
  requestUrl.searchParams.set("pageSize", String(PAGE_SIZE));
  requestUrl.searchParams.set("page", String(page));
  requestUrl.searchParams.set("q", "");

  const response = await fetch(requestUrl, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
      Cookie: cookies,
      Origin: "https://www.visitjeju.net",
      Referer: source.pageUrl,
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Codex/1.0",
    },
  });

  if (!response.ok) {
    throw new Error(
      `Visit Jeju list request failed: ${response.status} ${response.statusText}`,
    );
  }

  return (await response.json()) as VisitJejuListResponse;
}

async function fetchVisitJejuLiveRows(): Promise<RawPlaceRecord[]> {
  const rows: RawPlaceRecord[] = [];

  for (const source of LIVE_SOURCES) {
    const cookies = await bootstrapVisitJejuCookies(source.pageUrl);
    const firstPage = await fetchVisitJejuListPage(source, 1, cookies);
    const pageCount = Math.max(1, Number(firstPage.pageCount ?? 1));

    rows.push(
      ...(firstPage.items ?? []).map((item) => ({
        ...item,
        __forcedCategory: source.category,
      })),
    );

    for (let page = 2; page <= pageCount; page += 1) {
      const nextPage = await fetchVisitJejuListPage(source, page, cookies);
      rows.push(
        ...(nextPage.items ?? []).map((item) => ({
          ...item,
          __forcedCategory: source.category,
        })),
      );
    }
  }

  return rows;
}

async function loadVisitJejuRows(runtime: WorkerRuntime) {
  if (runtime.env.visitJejuBaseUrl) {
    const value = await loadStructuredSource(runtime.env.visitJejuBaseUrl);
    return extractArray<RawPlaceRecord>(value);
  }

  return fetchVisitJejuLiveRows();
}

export async function runVisitJejuPlacesJob(
  runtime: WorkerRuntime,
): Promise<JobOutcome> {
  const rows = await loadVisitJejuRows(runtime);
  const normalized = rows
    .map(normalizePlaceRecord)
    .filter((item): item is NonNullable<typeof item> => item !== null);

  if (normalized.length === 0) {
    throw new Error("No Visit Jeju place rows could be normalized.");
  }

  for (const place of normalized) {
    await runtime.prisma.place.upsert({
      where: { id: place.id },
      update: {
        slug: place.slug,
        category: place.category,
        baseDisplayName: place.baseDisplayName,
        regionName: place.regionName,
        latitude: place.latitude,
        longitude: place.longitude,
        sourceContentId: place.sourceContentId,
        sourceUrl: place.sourceUrl,
        openingHoursRaw: place.openingHoursRaw,
        openingHoursJson: place.openingHoursJson as never,
      },
      create: {
        id: place.id,
        slug: place.slug,
        category: place.category,
        baseDisplayName: place.baseDisplayName,
        regionName: place.regionName,
        latitude: place.latitude,
        longitude: place.longitude,
        sourceContentId: place.sourceContentId,
        sourceUrl: place.sourceUrl,
        openingHoursRaw: place.openingHoursRaw,
        openingHoursJson: place.openingHoursJson as never,
        locales: {
          create: {
            language: "ko",
            displayName: place.baseDisplayName,
            summary: place.summary || null,
            categoryLabel: place.categoryLabel,
          },
        },
      },
    });

    await runtime.prisma.placeLocale.upsert({
      where: {
        placeId_language: {
          placeId: place.id,
          language: "ko",
        },
      },
      update: {
        displayName: place.baseDisplayName,
        summary: place.summary || null,
        categoryLabel: place.categoryLabel,
      },
      create: {
        placeId: place.id,
        language: "ko",
        displayName: place.baseDisplayName,
        summary: place.summary || null,
        categoryLabel: place.categoryLabel,
      },
    });

    if (place.category === "TOUR") {
      await runtime.prisma.placeTourDetail.upsert({
        where: { placeId: place.id },
        update: {
          themeLabel: place.themeLabel,
        },
        create: {
          placeId: place.id,
          themeLabel: place.themeLabel,
        },
      });
    }

    if (place.category === "FOOD") {
      await runtime.prisma.placeFoodDetail.upsert({
        where: { placeId: place.id },
        update: {
          openingNote: place.openingHoursRaw,
        },
        create: {
          placeId: place.id,
          openingNote: place.openingHoursRaw,
        },
      });
    }

    if (place.category === "STAY") {
      await runtime.prisma.placeStayDetail.upsert({
        where: { placeId: place.id },
        update: {},
        create: {
          placeId: place.id,
        },
      });
    }
  }

  return {
    processedCount: normalized.length,
    successCount: normalized.length,
    failureCount: 0,
    meta: {
      source: runtime.env.visitJejuBaseUrl || "visitjeju-live-crawl",
    },
  };
}
