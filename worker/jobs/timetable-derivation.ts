import type {
  Route,
  RoutePattern,
  RoutePatternScheduleSource,
  RoutePatternStopProjection,
  Stop,
  StopTimeSourceKind,
  StopTranslation,
} from "@prisma/client";
import type { ParsedScheduleTrip } from "@/worker/jobs/bus-jeju-parser";
import { minutesToClock, parseClockToMinutes } from "@/worker/jobs/helpers";
import type {
  MatchableRoutePattern,
  PatternStopMatch,
} from "@/worker/jobs/schedule-pattern-matching";

const MAX_DERIVED_ANCHOR_STOP_GAP = 8;
const MAX_DERIVED_ANCHOR_DISTANCE_METERS = 12_000;
const MAX_DERIVED_ANCHOR_MINUTES = 45;
const MIN_DERIVED_PROJECTION_CONFIDENCE = 0.55;
const MAX_DERIVED_SNAP_DISTANCE_METERS = 250;
const MAX_ROUGH_ANCHOR_STOP_GAP = 20;
const MAX_ROUGH_ANCHOR_DISTANCE_METERS = 20_000;
const MAX_ROUGH_ANCHOR_MINUTES = 70;
const MAX_ROUGH_HALF_WINDOW_MINUTES = 12;
const MIN_ROUGH_HALF_WINDOW_MINUTES = 4;
const ROUGH_LOW_CONFIDENCE_THRESHOLD = 0.55;
const ROUGH_CONFIDENCE = 0.45;

export type ScheduleSourceContext = RoutePatternScheduleSource & {
  routePattern: RoutePattern & {
    route: Route;
    stopProjections: Array<
      Pick<
        RoutePatternStopProjection,
        "sequence" | "offsetMeters" | "snapDistanceMeters" | "confidence"
      >
    >;
    stops: Array<{
      sequence: number;
      distanceFromStart: number;
      stop: Stop & {
        translations: StopTranslation[];
      };
    }>;
  };
};

type MatchedPatternTimePoint = {
  headerIndex: number;
  patternIndex: number;
  sequence: number;
  stopId: string;
  minutes: number | null;
  isEstimated: boolean;
};

type OfficialPatternTimePoint = {
  stopId: string;
  sequence: number;
  time: string;
};

type DerivedPatternTimePoint = {
  stopId: string;
  sequence: number;
  time: string;
  timeSource: StopTimeSourceKind;
  confidence: number;
  anchorStartSequence: number | null;
  anchorEndSequence: number | null;
  windowStartMinutes: number | null;
  windowEndMinutes: number | null;
};

type OfficialPatternResult = {
  times: OfficialPatternTimePoint[];
  startTime: string;
};

type DerivedPatternResult = {
  times: DerivedPatternTimePoint[];
  derivedStopCount: number;
  anchorPairCount: number;
};

export type DerivationDiagnostics = {
  eligibleAnchorPairs: number;
  skipReasonCounts: Map<string, number>;
};

type PatternProjectionPoint = {
  patternIndex: number;
  stopId: string;
  sequence: number;
  offsetMeters: number;
  snapDistanceMeters: number;
  confidence: number;
};

type PatternProgressPoint = {
  patternIndex: number;
  stopId: string;
  sequence: number;
  meters: number;
  projectionConfidence: number | null;
};

type TripStopProfile = {
  columnIndexes: number[];
  stopNames: string[];
};

export function createDerivationDiagnostics(): DerivationDiagnostics {
  return {
    eligibleAnchorPairs: 0,
    skipReasonCounts: new Map(),
  };
}

function recordDerivationSkipReason(
  diagnostics: DerivationDiagnostics | undefined,
  reason: string,
) {
  if (!diagnostics) {
    return;
  }

  diagnostics.skipReasonCounts.set(reason, (diagnostics.skipReasonCounts.get(reason) ?? 0) + 1);
}

export function mergeReasonBreakdown(target: Map<string, number>, source: Map<string, number>) {
  for (const [reason, count] of source.entries()) {
    target.set(reason, (target.get(reason) ?? 0) + count);
  }
}

export function buildMatchablePattern(source: ScheduleSourceContext): MatchableRoutePattern {
  return {
    id: source.routePattern.id,
    shortName: source.routePattern.route.shortName,
    displayName: source.routePattern.displayName,
    directionLabel: source.routePattern.directionLabel,
    stops: source.routePattern.stops.map((item) => ({
      stopId: item.stop.id,
      sequence: item.sequence,
      displayName: item.stop.displayName,
      translations: item.stop.translations.map((translation) => translation.displayName),
    })),
  };
}

function buildPatternStopIndex(source: ScheduleSourceContext) {
  return new Map(
    source.routePattern.stops.map((item, index) => [`${item.stop.id}:${item.sequence}`, index]),
  );
}

function mapRowToPatternTimePoints(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes = matchedStops.map((_, index) => index),
) {
  const stopIndex = buildPatternStopIndex(source);
  const seenPatternIndexes = new Set<number>();
  const mappedPoints: MatchedPatternTimePoint[] = [];

  for (const [headerIndex, matchedStop] of matchedStops.entries()) {
    const patternIndex = stopIndex.get(`${matchedStop.stopId}:${matchedStop.sequence}`);
    if (patternIndex === undefined) {
      return null;
    }

    if (seenPatternIndexes.has(patternIndex)) {
      return null;
    }

    const columnIndex = columnIndexes[headerIndex] ?? headerIndex;
    mappedPoints.push({
      headerIndex,
      patternIndex,
      sequence: matchedStop.sequence,
      stopId: matchedStop.stopId,
      minutes: parseClockToMinutes(row.times[columnIndex]),
      isEstimated: row.estimatedColumns.includes(columnIndex),
    });
    seenPatternIndexes.add(patternIndex);
  }

  return mappedPoints.sort((left, right) => left.patternIndex - right.patternIndex);
}

function buildProjectionPoints(source: ScheduleSourceContext) {
  const projectionsBySequence = new Map(
    (source.routePattern.stopProjections ?? []).map((projection) => [projection.sequence, projection]),
  );

  return source.routePattern.stops.map((patternStop, patternIndex) => {
    const projection = projectionsBySequence.get(patternStop.sequence);
    if (!projection) {
      return null;
    }

    return {
      patternIndex,
      stopId: patternStop.stop.id,
      sequence: patternStop.sequence,
      offsetMeters: projection.offsetMeters,
      snapDistanceMeters: projection.snapDistanceMeters,
      confidence: projection.confidence,
    } satisfies PatternProjectionPoint;
  });
}

function isUsableProjection(projection: PatternProjectionPoint | null) {
  return Boolean(
    projection &&
      projection.confidence >= MIN_DERIVED_PROJECTION_CONFIDENCE &&
      projection.snapDistanceMeters <= MAX_DERIVED_SNAP_DISTANCE_METERS,
  );
}

function clampRatio(value: number) {
  return Math.max(0, Math.min(1, value));
}

function computeDerivedConfidence(
  segmentProjections: PatternProjectionPoint[],
  interiorStopCount: number,
) {
  const minProjectionConfidence = Math.min(
    ...segmentProjections.map((projection) => projection.confidence),
  );
  const maxSnapDistance = Math.max(
    ...segmentProjections.map((projection) => projection.snapDistanceMeters),
  );
  const stopGapPenalty = Math.max(0.55, 1 - interiorStopCount * 0.08);
  const snapPenalty = Math.max(0.5, 1 - Math.max(0, maxSnapDistance - 60) / 400);

  return Number(
    Math.max(0.35, Math.min(0.95, minProjectionConfidence * stopGapPenalty * snapPenalty)).toFixed(
      2,
    ),
  );
}

function extractOfficialAnchors(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
) {
  const mappedPoints = mapRowToPatternTimePoints(source, matchedStops, row, columnIndexes);
  if (!mappedPoints) {
    return null;
  }

  const officialAnchors = mappedPoints.filter(
    (point) => !point.isEstimated && point.minutes !== null,
  ) as Array<MatchedPatternTimePoint & { minutes: number }>;

  if (officialAnchors.length < 2) {
    return null;
  }

  return officialAnchors;
}

function hasStrictlyIncreasingMeters(points: PatternProgressPoint[]) {
  for (let index = 1; index < points.length; index += 1) {
    if (points[index - 1].meters >= points[index].meters) {
      return false;
    }
  }

  return true;
}

function buildDistanceProgressPoints(
  source: ScheduleSourceContext,
  leftAnchor: MatchedPatternTimePoint & { minutes: number },
  rightAnchor: MatchedPatternTimePoint & { minutes: number },
) {
  const points: PatternProgressPoint[] = [];

  for (let patternIndex = leftAnchor.patternIndex; patternIndex <= rightAnchor.patternIndex; patternIndex += 1) {
    const patternStop = source.routePattern.stops[patternIndex];
    if (!patternStop || !Number.isFinite(patternStop.distanceFromStart)) {
      return null;
    }

    points.push({
      patternIndex,
      stopId: patternStop.stop.id,
      sequence: patternStop.sequence,
      meters: patternStop.distanceFromStart,
      projectionConfidence: null,
    });
  }

  return hasStrictlyIncreasingMeters(points) ? points : null;
}

function buildProjectionProgressPoints(
  projections: Array<PatternProjectionPoint | null>,
  leftAnchor: MatchedPatternTimePoint & { minutes: number },
  rightAnchor: MatchedPatternTimePoint & { minutes: number },
) {
  const segment = projections.slice(leftAnchor.patternIndex, rightAnchor.patternIndex + 1);
  if (segment.some((projection) => projection === null)) {
    return null;
  }

  const normalized = segment as PatternProjectionPoint[];
  if (
    normalized.some(
      (projection) => projection.snapDistanceMeters > MAX_DERIVED_SNAP_DISTANCE_METERS,
    )
  ) {
    return null;
  }

  const points = normalized.map((projection) => ({
    patternIndex: projection.patternIndex,
    stopId: projection.stopId,
    sequence: projection.sequence,
    meters: projection.offsetMeters,
    projectionConfidence: projection.confidence,
  }));

  return hasStrictlyIncreasingMeters(points) ? points : null;
}

function clampMinutes(minutes: number, minMinutes: number, maxMinutes: number) {
  return Math.min(maxMinutes, Math.max(minMinutes, minutes));
}

function buildRoughHalfWindowMinutes(options: {
  interiorStopCount: number;
  spanMeters: number;
  usedProjectionFallback: boolean;
  minProjectionConfidence: number | null;
}) {
  const projectionPenalty = options.usedProjectionFallback ? 2 : 0;
  const lowConfidencePenalty =
    options.usedProjectionFallback &&
    options.minProjectionConfidence !== null &&
    options.minProjectionConfidence < ROUGH_LOW_CONFIDENCE_THRESHOLD
      ? 2
      : 0;

  return clampMinutes(
    4 +
      Math.ceil(options.interiorStopCount / 6) +
      Math.ceil(options.spanMeters / 5_000) +
      projectionPenalty +
      lowConfidencePenalty,
    MIN_ROUGH_HALF_WINDOW_MINUTES,
    MAX_ROUGH_HALF_WINDOW_MINUTES,
  );
}

export function fillPatternTimes(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
) {
  const officialAnchors = extractOfficialAnchors(source, matchedStops, row, columnIndexes);
  if (!officialAnchors) {
    return null;
  }

  return {
    times: officialAnchors.map((anchor) => ({
      stopId: anchor.stopId,
      sequence: anchor.sequence,
      time: minutesToClock(anchor.minutes),
    })),
    startTime: minutesToClock(officialAnchors[0]?.minutes ?? 0),
  } satisfies OfficialPatternResult;
}

export function derivePatternTimesInternal(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
  diagnostics?: DerivationDiagnostics,
) {
  const officialAnchors = extractOfficialAnchors(source, matchedStops, row, columnIndexes);
  if (!officialAnchors) {
    recordDerivationSkipReason(diagnostics, "strict_insufficient_official_anchors");
    return null;
  }

  const projections = buildProjectionPoints(source);
  const derivedRecords: DerivedPatternTimePoint[] = [];

  let derivedStopCount = 0;
  let anchorPairCount = 0;

  for (let anchorIndex = 0; anchorIndex < officialAnchors.length - 1; anchorIndex += 1) {
    const leftAnchor = officialAnchors[anchorIndex];
    const rightAnchor = officialAnchors[anchorIndex + 1];
    const interiorStopCount = rightAnchor.patternIndex - leftAnchor.patternIndex - 1;

    if (interiorStopCount <= 0) {
      continue;
    }

    if (interiorStopCount > MAX_DERIVED_ANCHOR_STOP_GAP) {
      recordDerivationSkipReason(diagnostics, "strict_anchor_stop_gap_exceeded");
      continue;
    }

    diagnostics && (diagnostics.eligibleAnchorPairs += 1);

    const segmentProjections = projections.slice(
      leftAnchor.patternIndex,
      rightAnchor.patternIndex + 1,
    );

    if (segmentProjections.some((projection) => !isUsableProjection(projection))) {
      recordDerivationSkipReason(diagnostics, "strict_unusable_projection");
      continue;
    }

    const normalizedSegmentProjections = segmentProjections as PatternProjectionPoint[];
    const leftProjection = normalizedSegmentProjections[0];
    const rightProjection = normalizedSegmentProjections[normalizedSegmentProjections.length - 1];
    const spanMeters = rightProjection.offsetMeters - leftProjection.offsetMeters;
    const spanMinutes = rightAnchor.minutes - leftAnchor.minutes;

    if (
      spanMeters <= 0 ||
      spanMeters > MAX_DERIVED_ANCHOR_DISTANCE_METERS ||
      spanMinutes <= 0 ||
      spanMinutes > MAX_DERIVED_ANCHOR_MINUTES
    ) {
      recordDerivationSkipReason(diagnostics, "strict_anchor_span_out_of_range");
      continue;
    }

    anchorPairCount += 1;
    const segmentConfidence = computeDerivedConfidence(
      normalizedSegmentProjections,
      interiorStopCount,
    );
    let previousMinutes = leftAnchor.minutes;

    for (
      let patternIndex = leftAnchor.patternIndex + 1;
      patternIndex < rightAnchor.patternIndex;
      patternIndex += 1
    ) {
      const projection = normalizedSegmentProjections[patternIndex - leftAnchor.patternIndex];
      const offsetWithinSegment = projection.offsetMeters - leftProjection.offsetMeters;
      const ratio = clampRatio(offsetWithinSegment / spanMeters);
      const interpolatedMinutes = leftAnchor.minutes + Math.round(spanMinutes * ratio);
      const nextMinutes = Math.min(
        rightAnchor.minutes,
        Math.max(previousMinutes, interpolatedMinutes),
      );
      const patternStop = source.routePattern.stops[patternIndex];

      derivedRecords.push({
        stopId: patternStop.stop.id,
        sequence: patternStop.sequence,
        time: minutesToClock(nextMinutes),
        timeSource: "OFFICIAL_ANCHOR_INTERPOLATED",
        confidence: segmentConfidence,
        anchorStartSequence: leftAnchor.sequence,
        anchorEndSequence: rightAnchor.sequence,
        windowStartMinutes: null,
        windowEndMinutes: null,
      });
      derivedStopCount += 1;
      previousMinutes = nextMinutes;
    }
  }

  if (derivedStopCount === 0) {
    if ((diagnostics?.eligibleAnchorPairs ?? 0) > 0) {
      recordDerivationSkipReason(diagnostics, "strict_no_rows_materialized");
    }
    return null;
  }

  return {
    times: derivedRecords,
    derivedStopCount,
    anchorPairCount,
  } satisfies DerivedPatternResult;
}

export function derivePatternTimes(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
) {
  return derivePatternTimesInternal(source, matchedStops, row, columnIndexes);
}

export function deriveRoughPatternTimesInternal(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
  diagnostics?: DerivationDiagnostics,
) {
  const officialAnchors = extractOfficialAnchors(source, matchedStops, row, columnIndexes);
  if (!officialAnchors) {
    recordDerivationSkipReason(diagnostics, "rough_insufficient_official_anchors");
    return null;
  }

  const projections = buildProjectionPoints(source);
  const derivedRecords: DerivedPatternTimePoint[] = [];
  let derivedStopCount = 0;
  let anchorPairCount = 0;

  for (let anchorIndex = 0; anchorIndex < officialAnchors.length - 1; anchorIndex += 1) {
    const leftAnchor = officialAnchors[anchorIndex];
    const rightAnchor = officialAnchors[anchorIndex + 1];
    const interiorStopCount = rightAnchor.patternIndex - leftAnchor.patternIndex - 1;

    if (interiorStopCount <= 0) {
      continue;
    }

    if (interiorStopCount > MAX_ROUGH_ANCHOR_STOP_GAP) {
      recordDerivationSkipReason(diagnostics, "rough_anchor_stop_gap_exceeded");
      continue;
    }

    diagnostics && (diagnostics.eligibleAnchorPairs += 1);

    const distanceProgress = buildDistanceProgressPoints(source, leftAnchor, rightAnchor);
    const projectionProgress =
      distanceProgress === null
        ? buildProjectionProgressPoints(projections, leftAnchor, rightAnchor)
        : null;
    const progressPoints = distanceProgress ?? projectionProgress;

    if (!progressPoints) {
      recordDerivationSkipReason(diagnostics, "rough_progress_unavailable");
      continue;
    }

    const leftProgress = progressPoints[0];
    const rightProgress = progressPoints[progressPoints.length - 1];
    const spanMeters = rightProgress.meters - leftProgress.meters;
    const spanMinutes = rightAnchor.minutes - leftAnchor.minutes;

    if (
      spanMeters <= 0 ||
      spanMeters > MAX_ROUGH_ANCHOR_DISTANCE_METERS ||
      spanMinutes <= 0 ||
      spanMinutes > MAX_ROUGH_ANCHOR_MINUTES
    ) {
      recordDerivationSkipReason(diagnostics, "rough_anchor_span_out_of_range");
      continue;
    }

    anchorPairCount += 1;
    const usedProjectionFallback = distanceProgress === null;
    const minProjectionConfidence =
      usedProjectionFallback && projectionProgress
        ? Math.min(...projectionProgress.map((point) => point.projectionConfidence ?? 1))
        : null;
    const halfWindowMinutes = buildRoughHalfWindowMinutes({
      interiorStopCount,
      spanMeters,
      usedProjectionFallback,
      minProjectionConfidence,
    });
    let previousMinutes = leftAnchor.minutes;

    for (
      let patternIndex = leftAnchor.patternIndex + 1;
      patternIndex < rightAnchor.patternIndex;
      patternIndex += 1
    ) {
      const progressPoint = progressPoints[patternIndex - leftAnchor.patternIndex];
      const offsetWithinSegment = progressPoint.meters - leftProgress.meters;
      const ratio = clampRatio(offsetWithinSegment / spanMeters);
      const interpolatedMinutes = leftAnchor.minutes + Math.round(spanMinutes * ratio);
      const centerMinutes = Math.min(
        rightAnchor.minutes,
        Math.max(previousMinutes, interpolatedMinutes),
      );

      derivedRecords.push({
        stopId: progressPoint.stopId,
        sequence: progressPoint.sequence,
        time: minutesToClock(centerMinutes),
        timeSource: "DISTANCE_INTERPOLATED",
        confidence: ROUGH_CONFIDENCE,
        anchorStartSequence: leftAnchor.sequence,
        anchorEndSequence: rightAnchor.sequence,
        windowStartMinutes: centerMinutes - halfWindowMinutes,
        windowEndMinutes: centerMinutes + halfWindowMinutes,
      });
      derivedStopCount += 1;
      previousMinutes = centerMinutes;
    }
  }

  if (derivedStopCount === 0) {
    if ((diagnostics?.eligibleAnchorPairs ?? 0) > 0) {
      recordDerivationSkipReason(diagnostics, "rough_no_rows_materialized");
    }
    return null;
  }

  return {
    times: derivedRecords,
    derivedStopCount,
    anchorPairCount,
  } satisfies DerivedPatternResult;
}

export function deriveRoughPatternTimes(
  source: ScheduleSourceContext,
  matchedStops: PatternStopMatch[],
  row: ParsedScheduleTrip,
  columnIndexes?: number[],
) {
  return deriveRoughPatternTimesInternal(source, matchedStops, row, columnIndexes);
}
