import { projectPointOntoPolyline, type GeoPoint } from "@/lib/geometry";

const OSRM_TRACE_GAP_MS = 90_000;
export const LOW_FREQUENCY_TRACE_GAP_MS = 15 * 60_000;
const MAX_OBSERVATION_SNAP_DISTANCE_METERS = 250;
export const MAX_SEGMENT_SPEED_KPH = 90;
const BACKWARD_OFFSET_TOLERANCE_METERS = 30;

export type TraceObservation = {
  observedAt: Date;
  latitude: number;
  longitude: number;
};

export type ProjectedTraceObservation = {
  observedAt: Date;
  offsetMeters: number;
};

export type SegmentProfileDiagnostics = {
  rawObservationCount: number;
  traceCount: number;
  traceGapSplitCount: number;
  discardedSingleObservationTraceCount: number;
  projectedTraceCount: number;
  projectedObservationCount: number;
  snapRejectedObservationCount: number;
  nonMonotonicObservationCount: number;
  speedRejectedObservationCount: number;
  osrmMatchedTraceCount: number;
  osrmSkippedLowFrequencyTraceCount: number;
  osrmMatchFailureCount: number;
  osrmLowConfidenceCount: number;
  stopPassageCandidateCount: number;
  segmentSampleCount: number;
  segmentBucketBelowSampleCount: number;
};

export function createDiagnostics(): SegmentProfileDiagnostics {
  return {
    rawObservationCount: 0,
    traceCount: 0,
    traceGapSplitCount: 0,
    discardedSingleObservationTraceCount: 0,
    projectedTraceCount: 0,
    projectedObservationCount: 0,
    snapRejectedObservationCount: 0,
    nonMonotonicObservationCount: 0,
    speedRejectedObservationCount: 0,
    osrmMatchedTraceCount: 0,
    osrmSkippedLowFrequencyTraceCount: 0,
    osrmMatchFailureCount: 0,
    osrmLowConfidenceCount: 0,
    stopPassageCandidateCount: 0,
    segmentSampleCount: 0,
    segmentBucketBelowSampleCount: 0,
  };
}

function pushTraceIfReady(
  traces: TraceObservation[][],
  current: TraceObservation[],
  diagnostics: SegmentProfileDiagnostics,
) {
  if (current.length >= 2) {
    traces.push(current);
    return;
  }

  if (current.length === 1) {
    diagnostics.discardedSingleObservationTraceCount += 1;
  }
}

export function splitObservations(rows: TraceObservation[], diagnostics: SegmentProfileDiagnostics) {
  const traces: TraceObservation[][] = [];
  let current: TraceObservation[] = [];

  for (const row of rows) {
    const previous = current[current.length - 1];
    if (
      previous &&
      row.observedAt.getTime() - previous.observedAt.getTime() > LOW_FREQUENCY_TRACE_GAP_MS
    ) {
      diagnostics.traceGapSplitCount += 1;
      pushTraceIfReady(traces, current, diagnostics);
      current = [];
    }

    current.push(row);
  }

  pushTraceIfReady(traces, current, diagnostics);
  diagnostics.traceCount += traces.length;

  return traces;
}

function pushProjectedTraceIfReady(
  traces: ProjectedTraceObservation[][],
  current: ProjectedTraceObservation[],
  diagnostics: SegmentProfileDiagnostics,
) {
  if (current.length >= 2) {
    traces.push(current);
    diagnostics.projectedTraceCount += 1;
  }
}

export function buildProjectedTraces(
  trace: TraceObservation[],
  geometry: GeoPoint[],
  diagnostics: SegmentProfileDiagnostics,
) {
  const projectedTraces: ProjectedTraceObservation[][] = [];
  let current: ProjectedTraceObservation[] = [];

  for (const row of trace) {
    const projection = projectPointOntoPolyline(
      {
        latitude: row.latitude,
        longitude: row.longitude,
      },
      geometry,
    );

    if (!projection || projection.distanceMeters > MAX_OBSERVATION_SNAP_DISTANCE_METERS) {
      diagnostics.snapRejectedObservationCount += 1;
      pushProjectedTraceIfReady(projectedTraces, current, diagnostics);
      current = [];
      continue;
    }

    const projected = {
      observedAt: row.observedAt,
      offsetMeters: projection.offsetMeters,
    };
    diagnostics.projectedObservationCount += 1;

    const previous = current[current.length - 1];
    if (!previous) {
      current.push(projected);
      continue;
    }

    const elapsedSec = (projected.observedAt.getTime() - previous.observedAt.getTime()) / 1000;
    if (elapsedSec <= 0) {
      diagnostics.nonMonotonicObservationCount += 1;
      continue;
    }

    if (projected.offsetMeters + BACKWARD_OFFSET_TOLERANCE_METERS < previous.offsetMeters) {
      diagnostics.nonMonotonicObservationCount += 1;
      pushProjectedTraceIfReady(projectedTraces, current, diagnostics);
      current = [projected];
      continue;
    }

    if (projected.offsetMeters < previous.offsetMeters) {
      diagnostics.nonMonotonicObservationCount += 1;
      continue;
    }

    const speedKph = ((projected.offsetMeters - previous.offsetMeters) / elapsedSec) * 3.6;
    if (Number.isFinite(speedKph) && speedKph > MAX_SEGMENT_SPEED_KPH) {
      diagnostics.speedRejectedObservationCount += 1;
      pushProjectedTraceIfReady(projectedTraces, current, diagnostics);
      current = [projected];
      continue;
    }

    current.push(projected);
  }

  pushProjectedTraceIfReady(projectedTraces, current, diagnostics);
  return projectedTraces;
}

export function isHighFrequencyTrace(trace: TraceObservation[]) {
  for (let index = 1; index < trace.length; index += 1) {
    if (
      trace[index].observedAt.getTime() - trace[index - 1].observedAt.getTime() >
      OSRM_TRACE_GAP_MS
    ) {
      return false;
    }
  }

  return true;
}
