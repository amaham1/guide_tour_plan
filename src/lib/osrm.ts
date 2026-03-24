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

export function estimateWalkFromDistance(distanceMeters: number) {
  return Math.max(2, Math.round(distanceMeters / 75));
}

export async function getWalkRoute(
  baseUrl: string,
  from: Coordinate,
  to: Coordinate,
): Promise<{ distanceMeters: number; durationMinutes: number }> {
  const normalizedBaseUrl = baseUrl.replace(/\/+$/, "");
  const url = `${normalizedBaseUrl}/route/v1/foot/${from.longitude},${from.latitude};${to.longitude},${to.latitude}?overview=false`;

  const response = await fetch(url, {
    cache: "no-store",
    headers: {
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    throw new Error(`OSRM request failed: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as OsrmRouteResponse;
  const route = payload.routes?.[0];

  if (!route?.distance || !route.duration) {
    throw new Error("OSRM response did not include a valid route.");
  }

  return {
    distanceMeters: Math.round(route.distance),
    durationMinutes: Math.max(1, Math.round(route.duration / 60)),
  };
}
