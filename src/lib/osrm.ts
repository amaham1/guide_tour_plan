import {
  DependencyUnavailableError,
  RouteNotFoundError,
} from "@/lib/errors";

type Coordinate = {
  latitude: number;
  longitude: number;
};

type OsrmRouteResponse = {
  code?: string;
  routes?: Array<{
    distance?: number;
    duration?: number;
  }>;
};

export function haversineMeters(from: Coordinate, to: Coordinate) {
  const toRadians = (value: number) => (value * Math.PI) / 180;
  const earthRadius = 6_371_000;
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return Math.round(2 * earthRadius * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function compactErrorDetail(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

export async function getWalkRoute(
  baseUrl: string,
  from: Coordinate,
  to: Coordinate,
): Promise<{ distanceMeters: number; durationMinutes: number }> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/route/v1/foot/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;

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

  const payload = (await response.json()) as OsrmRouteResponse;
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
