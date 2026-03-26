import { fetchJson } from "@/worker/core/fetch";
import type { WorkerRuntime } from "@/worker/core/runtime";

export type BusJejuStationRecord = {
  stationId: string | number;
  stationNm: string;
  localX: string | number;
  localY: string | number;
  stationEngNm?: string | null;
  stationChnNm?: string | null;
  stationJpnNm?: string | null;
  updnDir?: string | null;
  linkOrd?: string | number | null;
};

export type BusJejuLineCandidate = {
  routeId: string | number;
  routeNm: string;
  routeNum: string;
  routeSubNm?: string | null;
  frontRouteNum?: string | null;
  rearRouteNum?: string | null;
  busTypeStr?: string | null;
  orgtNm?: string | null;
  dstNm?: string | null;
  upDnDir?: string | null;
};

export type BusJejuLineInfo = BusJejuLineCandidate & {
  stationInfoList: BusJejuStationRecord[];
};

export type BusJejuLinkPoint = {
  localX: string | number;
  localY: string | number;
};

export type BusJejuRealtimePosition = {
  vhId?: string | number | null;
  plateNo?: string | null;
  currStationId?: string | number | null;
  currStationNm?: string | null;
  localX?: string | number | null;
  localY?: string | number | null;
  lowPlateTp?: string | null;
};

const defaultIslandBounds = {
  southWestLat: "33.05",
  southWestLng: "126.10",
  northEastLat: "33.62",
  northEastLng: "126.98",
} as const;

async function postBusJejuJson<T>(
  runtime: WorkerRuntime,
  pathname: string,
  body: Record<string, string | number>,
) {
  return fetchJson<T>(`${runtime.env.busJejuBaseUrl}${pathname}`, undefined, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
    },
    body: new URLSearchParams(
      Object.entries(body).map(([key, value]) => [key, String(value)]),
    ),
  });
}

export async function fetchBusJejuStations(runtime: WorkerRuntime) {
  return postBusJejuJson<BusJejuStationRecord[]>(
    runtime,
    "/data/search/stationListByBounds",
    defaultIslandBounds,
  );
}

export async function fetchBusJejuLineCandidates(
  runtime: WorkerRuntime,
  routeNumber: string,
) {
  return postBusJejuJson<BusJejuLineCandidate[]>(
    runtime,
    "/data/search/searchSimpleLineListByLineNumAndType",
    {
      keyword: routeNumber,
      type: "2",
    },
  );
}

export async function fetchBusJejuLineInfo(
  runtime: WorkerRuntime,
  lineId: string | number,
) {
  return postBusJejuJson<BusJejuLineInfo>(
    runtime,
    "/data/search/getLineInfoByLineId",
    {
      lineId,
      type: "2",
    },
  );
}

export async function fetchBusJejuLinkInfo(
  runtime: WorkerRuntime,
  lineId: string | number,
) {
  return postBusJejuJson<BusJejuLinkPoint[]>(
    runtime,
    "/data/search/getLinkInfoByLineId",
    {
      lineId,
      type: "2",
    },
  );
}

export async function fetchBusJejuRealtimePositions(
  runtime: WorkerRuntime,
  lineId: string | number,
) {
  return postBusJejuJson<BusJejuRealtimePosition[]>(
    runtime,
    "/data/search/getRealTimeBusPositionByLineId",
    {
      lineId,
      type: "2",
    },
  );
}
