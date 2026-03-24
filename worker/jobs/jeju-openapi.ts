import { XMLParser } from "fast-xml-parser";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { fetchPlainText } from "@/worker/core/fetch";
import { fetchBusJejuStations } from "@/worker/jobs/bus-jeju-live";
import { normalizeText } from "@/worker/jobs/helpers";

type QueryValue = string | number | undefined | null;

type JejuOpenApiEnvelope<T> = {
  items: T[];
  totalCount: number;
  resultCode: string;
  resultMsg: string;
  pageNo: number;
  numOfRows: number;
};

export type JejuOpenApiStation2Record = {
  stationId: string | number;
  stationNm: string;
  stationNmEn?: string | null;
  stationNmCh?: string | null;
  stationNmJp?: string | null;
  localX: string | number;
  localY: string | number;
  dirTp?: string | null;
  mobiNum?: string | null;
  upd?: string | null;
  useYn?: string | null;
};

export type JejuOpenApiBusRecord = {
  routeId: string | number;
  routeNm: string;
  routeNum?: string | null;
  routeSubNm?: string | null;
  routeTp?: string | number | null;
  routeColor?: string | null;
  orgtStationId?: string | number | null;
  dstStationId?: string | number | null;
  stationCnt?: string | number | null;
  routeLen?: string | number | null;
  upd?: string | null;
  useYn?: string | null;
};

export type JejuOpenApiStationRouteRecord = {
  routeId: string | number;
  stationId: string | number;
  stationOrd: string | number;
  routeDist?: string | number | null;
  updnDir?: string | number | null;
  waypointOrd?: string | number | null;
  upd?: string | null;
  useYn?: string | null;
};

export type JejuOpenApiBusArriveRecord = {
  arrvVhId?: string | number | null;
  calcDate?: string | null;
  leftStation?: string | number | null;
  predictTravTm?: string | number | null;
  routeId: string | number;
  stationOrd?: string | number | null;
  updnDir?: string | number | null;
};

const parser = new XMLParser({
  ignoreAttributes: false,
  parseTagValue: false,
  trimValues: true,
});

function toNumber(value: unknown, fallback = 0) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return fallback;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function buildEndpointUrl(baseUrl: string, endpoint: string) {
  const normalizedBase = baseUrl.replace(/\/+$/, "");
  return `${normalizedBase}/${endpoint}`;
}

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (value && typeof value === "object") {
    return [value as T];
  }

  return [];
}

async function fetchJejuOpenApiPage<T extends Record<string, unknown>>(
  runtime: WorkerRuntime,
  endpoint: string,
  query: Record<string, QueryValue> = {},
): Promise<JejuOpenApiEnvelope<T>> {
  const text = await fetchPlainText(
    buildEndpointUrl(runtime.env.jejuOpenApiBaseUrl, endpoint),
    {
      ...query,
      ...(runtime.env.jejuOpenApiServiceKey
        ? { ServiceKey: runtime.env.jejuOpenApiServiceKey }
        : {}),
    },
    {
      headers: {
        Accept: "application/xml, text/xml, */*",
      },
    },
  );

  const parsed = parser.parse(text) as Record<string, unknown>;
  const header = (parsed.response as Record<string, unknown> | undefined)?.header as
    | Record<string, unknown>
    | undefined;
  const body = (parsed.response as Record<string, unknown> | undefined)?.body as
    | Record<string, unknown>
    | undefined;
  const resultCode = normalizeText(header?.resultCode);
  const resultMsg = normalizeText(header?.resultMsg);

  if (resultCode && resultCode !== "00") {
    throw new Error(
      `Jeju OpenAPI ${endpoint} failed: ${resultCode} ${resultMsg || "Unknown error"}`,
    );
  }

  const items = toArray<T>((body?.items as Record<string, unknown> | undefined)?.item);
  return {
    items,
    totalCount: toNumber(body?.totalCount),
    resultCode,
    resultMsg,
    pageNo: toNumber(body?.pageNo, 1),
    numOfRows: toNumber(body?.numOfRows, items.length || 1),
  };
}

export async function fetchAllJejuOpenApiItems<T extends Record<string, unknown>>(
  runtime: WorkerRuntime,
  endpoint: string,
  query: Record<string, QueryValue> = {},
  pageSize = 2000,
): Promise<T[]> {
  const items: T[] = [];
  let pageNo = 1;
  let totalCount = Number.POSITIVE_INFINITY;

  while (items.length < totalCount) {
    const page = await fetchJejuOpenApiPage<T>(runtime, endpoint, {
      ...query,
      pageNo,
      numOfRows: pageSize,
    });
    items.push(...page.items);
    totalCount = page.totalCount || items.length;

    if (page.items.length === 0 || page.items.length < pageSize) {
      break;
    }

    pageNo += 1;
  }

  return items;
}

export async function fetchJejuStation2(runtime: WorkerRuntime) {
  const rows = await fetchBusJejuStations(runtime);
  return rows.map<JejuOpenApiStation2Record>((row) => ({
    stationId: row.stationId,
    stationNm: row.stationNm,
    stationNmEn: row.stationEngNm,
    stationNmCh: row.stationChnNm,
    stationNmJp: row.stationJpnNm,
    localX: row.localX,
    localY: row.localY,
    dirTp: row.updnDir,
    mobiNum: null,
    upd: null,
    useYn: "Y",
  }));
}

export async function fetchJejuBuses(runtime: WorkerRuntime) {
  return fetchAllJejuOpenApiItems<JejuOpenApiBusRecord>(runtime, "Bus");
}

export async function fetchJejuStationRoutes(runtime: WorkerRuntime) {
  return fetchAllJejuOpenApiItems<JejuOpenApiStationRouteRecord>(runtime, "StationRoute");
}

export async function fetchJejuStationRoutesByStation(
  runtime: WorkerRuntime,
  stationId: string,
) {
  return fetchAllJejuOpenApiItems<JejuOpenApiStationRouteRecord>(runtime, "StationRoutePs", {
    station: stationId,
  });
}

export async function fetchJejuStationRoutesByRoute(
  runtime: WorkerRuntime,
  routeId: string,
) {
  return fetchAllJejuOpenApiItems<JejuOpenApiStationRouteRecord>(runtime, "StationRoutePr", {
    route: routeId,
  });
}

export async function fetchJejuBusArrivesByStation(
  runtime: WorkerRuntime,
  stationId: string,
) {
  return fetchAllJejuOpenApiItems<JejuOpenApiBusArriveRecord>(runtime, "BusArrives", {
    station: stationId,
  });
}
