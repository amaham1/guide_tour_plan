import {
  DependencyUnavailableError,
  RouteNotFoundError,
} from "@/lib/errors";
import {
  type Coordinate,
  type GeoPoint,
  haversineMeters,
} from "@/lib/geometry";

type OsrmRouteResponse = {
  code?: string;
  waypoints?: Array<{
    location?: [number, number];
    distance?: number;
    name?: string;
    nodes?: number[];
  }>;
  routes?: Array<{
    distance?: number;
    duration?: number;
    geometry?: {
      coordinates?: GeoPoint[];
    };
    legs?: Array<{
      annotation?: {
        nodes?: number[];
        distance?: number[];
        duration?: number[];
      };
    }>;
  }>;
};

type OsrmMatchResponse = {
  code?: string;
  tracepoints?: Array<{
    matchings_index?: number;
    waypoint_index?: number;
    alternatives_count?: number;
    location?: [number, number];
  } | null>;
  matchings?: Array<{
    confidence?: number;
    distance?: number;
    duration?: number;
    geometry?: {
      coordinates?: GeoPoint[];
    };
    legs?: Array<{
      annotation?: {
        nodes?: number[];
        distance?: number[];
        duration?: number[];
      };
    }>;
  }>;
};

function compactErrorDetail(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function buildCoordinateList(points: Coordinate[]) {
  return points.map((point) => `${point.longitude},${point.latitude}`).join(";");
}

async function fetchOsrmPayload<T>(
  url: string,
  normalizedBaseUrl: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : "unknown network error";
    throw new DependencyUnavailableError(
      `OSRM 도보 경로 서버(${normalizedBaseUrl})에 연결하지 못했습니다. 원인: ${cause}`,
    );
  }

  if (!response.ok) {
    const bodyText = compactErrorDetail(await response.text());
    throw new DependencyUnavailableError(
      `OSRM 도보 경로 서버가 ${response.status} ${response.statusText}를 반환했습니다.${bodyText ? ` 원인: ${bodyText}` : ""}`,
    );
  }

  return (await response.json()) as T;
}

export async function getWalkRoute(
  baseUrl: string,
  from: Coordinate,
  to: Coordinate,
): Promise<{ distanceMeters: number; durationMinutes: number }> {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const payload = await fetchOsrmPayload<OsrmRouteResponse>(
    `${normalizedBaseUrl}/route/v1/foot/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`,
    normalizedBaseUrl,
  );
  const route = payload.routes?.[0];

  if (payload.code === "NoRoute") {
    throw new RouteNotFoundError("OSRM이 두 지점 사이의 도보 경로를 찾지 못했습니다.");
  }

  if (route?.distance == null || route.duration == null) {
    throw new DependencyUnavailableError(
      "OSRM 응답에 유효한 도보 경로가 포함되지 않았습니다.",
    );
  }

  return {
    distanceMeters: Math.round(route.distance),
    durationMinutes: Math.max(1, Math.round(route.duration / 60)),
  };
}

export async function getRouteGeometry(
  baseUrl: string,
  profile: "driving" | "foot",
  points: Coordinate[],
) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const payload = await fetchOsrmPayload<OsrmRouteResponse>(
    `${normalizedBaseUrl}/route/v1/${profile}/${buildCoordinateList(points)}?overview=full&geometries=geojson&annotations=distance,duration,nodes&steps=false`,
    normalizedBaseUrl,
  );
  const route = payload.routes?.[0];

  if (payload.code === "NoRoute") {
    throw new RouteNotFoundError("OSRM route service could not build a connected path.");
  }

  if (!route?.geometry?.coordinates || route.distance == null || route.duration == null) {
    throw new DependencyUnavailableError("OSRM route payload did not include geometry.");
  }

  return {
    distanceMeters: Math.round(route.distance),
    durationSeconds: Math.max(1, Math.round(route.duration)),
    durationMinutes: Math.max(1, Math.round(route.duration / 60)),
    geometry: route.geometry.coordinates,
    nodes:
      route.legs?.flatMap((leg) => leg.annotation?.nodes ?? []) ?? [],
  };
}

export async function matchTraceGeometry(
  baseUrl: string,
  profile: "driving" | "foot",
  points: Coordinate[],
  options?: {
    timestamps?: number[];
    radiuses?: number[];
  },
) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const params = new URLSearchParams({
    overview: "full",
    geometries: "geojson",
    annotations: "distance,duration,nodes",
    tidy: "true",
    gaps: "split",
  });

  if (options?.timestamps?.length === points.length) {
    params.set("timestamps", options.timestamps.join(";"));
  }

  if (options?.radiuses?.length === points.length) {
    params.set("radiuses", options.radiuses.join(";"));
  }

  const payload = await fetchOsrmPayload<OsrmMatchResponse>(
    `${normalizedBaseUrl}/match/v1/${profile}/${buildCoordinateList(points)}?${params.toString()}`,
    normalizedBaseUrl,
  );

  if (payload.code === "NoMatch") {
    return [];
  }

  return (payload.matchings ?? [])
    .filter((matching) => matching.geometry?.coordinates && matching.distance != null && matching.duration != null)
    .map((matching) => ({
      confidence: matching.confidence ?? 0,
      distanceMeters: Math.round(matching.distance ?? 0),
      durationSeconds: Math.max(1, Math.round(matching.duration ?? 0)),
      durationMinutes: Math.max(1, Math.round((matching.duration ?? 0) / 60)),
      geometry: matching.geometry?.coordinates ?? [],
      nodes:
        matching.legs?.flatMap((leg) => leg.annotation?.nodes ?? []) ?? [],
    }));
}

export { haversineMeters };
export type { Coordinate, GeoPoint };
