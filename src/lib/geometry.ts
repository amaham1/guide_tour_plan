export type Coordinate = {
  latitude: number;
  longitude: number;
};

export type GeoPoint = [number, number];

const EARTH_RADIUS_METERS = 6_371_000;

function toRadians(value: number) {
  return (value * Math.PI) / 180;
}

function toProjected(point: Coordinate, referenceLatitude: number) {
  const latitudeRadians = toRadians(referenceLatitude);

  return {
    x: toRadians(point.longitude) * EARTH_RADIUS_METERS * Math.cos(latitudeRadians),
    y: toRadians(point.latitude) * EARTH_RADIUS_METERS,
  };
}

export function haversineMeters(from: Coordinate, to: Coordinate) {
  const dLat = toRadians(to.latitude - from.latitude);
  const dLon = toRadians(to.longitude - from.longitude);
  const lat1 = toRadians(from.latitude);
  const lat2 = toRadians(to.latitude);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;

  return Math.round(2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

export function geoPointToCoordinate(point: GeoPoint): Coordinate {
  return {
    longitude: point[0],
    latitude: point[1],
  };
}

export function geometryLengthMeters(points: GeoPoint[]) {
  if (points.length < 2) {
    return 0;
  }

  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += haversineMeters(
      geoPointToCoordinate(points[index - 1]),
      geoPointToCoordinate(points[index]),
    );
  }

  return total;
}

export function projectPointOntoPolyline(point: Coordinate, polyline: GeoPoint[]) {
  if (polyline.length === 0) {
    return null;
  }

  if (polyline.length === 1) {
    return {
      offsetMeters: 0,
      distanceMeters: haversineMeters(point, geoPointToCoordinate(polyline[0])),
      location: polyline[0],
      segmentIndex: 0,
    };
  }

  let traversed = 0;
  let best:
    | {
        offsetMeters: number;
        distanceMeters: number;
        location: GeoPoint;
        segmentIndex: number;
      }
    | null = null;

  for (let index = 1; index < polyline.length; index += 1) {
    const start = geoPointToCoordinate(polyline[index - 1]);
    const end = geoPointToCoordinate(polyline[index]);
    const referenceLatitude = (start.latitude + end.latitude + point.latitude) / 3;
    const projectedStart = toProjected(start, referenceLatitude);
    const projectedEnd = toProjected(end, referenceLatitude);
    const projectedPoint = toProjected(point, referenceLatitude);
    const dx = projectedEnd.x - projectedStart.x;
    const dy = projectedEnd.y - projectedStart.y;
    const segmentLengthSquared = dx ** 2 + dy ** 2;
    const ratio =
      segmentLengthSquared === 0
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              ((projectedPoint.x - projectedStart.x) * dx +
                (projectedPoint.y - projectedStart.y) * dy) /
                segmentLengthSquared,
            ),
          );

    const snappedX = projectedStart.x + dx * ratio;
    const snappedY = projectedStart.y + dy * ratio;
    const distance = Math.hypot(projectedPoint.x - snappedX, projectedPoint.y - snappedY);
    const segmentLength = Math.hypot(dx, dy);
    const snapped: GeoPoint = [
      polyline[index - 1][0] + (polyline[index][0] - polyline[index - 1][0]) * ratio,
      polyline[index - 1][1] + (polyline[index][1] - polyline[index - 1][1]) * ratio,
    ];

    if (!best || distance < best.distanceMeters) {
      best = {
        offsetMeters: Math.round(traversed + segmentLength * ratio),
        distanceMeters: Math.round(distance),
        location: snapped,
        segmentIndex: index - 1,
      };
    }

    traversed += segmentLength;
  }

  return best;
}

export function samplePolyline(points: GeoPoint[], maxPoints: number) {
  if (points.length <= maxPoints) {
    return points;
  }

  const step = Math.max(1, Math.ceil(points.length / maxPoints));
  const sampled = points.filter((_, index) => index === 0 || index === points.length - 1 || index % step === 0);
  if (sampled[sampled.length - 1] !== points[points.length - 1]) {
    sampled.push(points[points.length - 1]);
  }

  return sampled;
}

export function percentile(values: number[], percentileRank: number) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentileRank / 100) * sorted.length) - 1),
  );
  return sorted[index];
}
