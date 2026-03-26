import { normalizeText } from "@/worker/jobs/helpers";
import type { PatternMatchResult } from "@/worker/jobs/schedule-pattern-matching";

export const AUTHORITATIVE_MINIMUM_STOP_SCORE = 70;
export const AUTHORITATIVE_NEAR_COMPLETE_MIN_COVERAGE = 6 / 7;
export const AUTHORITATIVE_MATCH_MINIMUM_COVERAGE = 0.75;

const STRICT_MINIMUM_TERMINAL_SCORE = 90;
const HIGH_CONFIDENCE_MINIMUM_TERMINAL_SCORE = 80;
const STRONG_MINIMUM_TERMINAL_SCORE = 70;
const SPARSE_EXACT_MINIMUM_TERMINAL_SCORE = 95;
const HIGH_CONFIDENCE_MINIMUM_AVERAGE_SCORE = 90;
const STRICT_MINIMUM_AVERAGE_SCORE = 85;
const STRONG_MINIMUM_AVERAGE_SCORE = 75;
const SPARSE_EXACT_MINIMUM_AVERAGE_SCORE = 95;
const SHORT_STRONG_MINIMUM_AVERAGE_SCORE = 85;
const LOOP_MINIMUM_AVERAGE_SCORE = 70;
const SPARSE_EXACT_MAXIMUM_STOP_COUNT = 3;
const SHORT_STRONG_MAXIMUM_STOP_COUNT = 5;
const HIGH_CONFIDENCE_MINIMUM_STOP_COUNT = 4;
const RELAXED_MINIMUM_STOP_COUNT = 6;
const NEAR_COMPLETE_MINIMUM_STOP_COUNT = 7;
const NEAR_COMPLETE_MAX_UNMATCHED_STOPS = 1;
const NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE = 85;
const STRONG_NEAR_COMPLETE_MINIMUM_STOP_COUNT = 8;
const STRONG_NEAR_COMPLETE_MINIMUM_COVERAGE = 0.75;
const STRONG_NEAR_COMPLETE_MAX_UNMATCHED_STOPS = 2;
const STRONG_NEAR_COMPLETE_MINIMUM_TERMINAL_SCORE = 80;
const STRONG_NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE = 88;
const SHORT_NEAR_COMPLETE_MINIMUM_STOP_COUNT = 6;
const SHORT_NEAR_COMPLETE_MINIMUM_COVERAGE = 5 / 6;
const SHORT_NEAR_COMPLETE_MAX_UNMATCHED_STOPS = 1;
const SHORT_NEAR_COMPLETE_MINIMUM_TERMINAL_SCORE = 90;
const SHORT_NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE = 90;

function isLoopProfile(stopNames: string[]) {
  const firstStopName = normalizeText(stopNames[0] ?? "");
  const lastStopName = normalizeText(stopNames[stopNames.length - 1] ?? "");
  return Boolean(firstStopName) && firstStopName === lastStopName;
}

export function isAuthoritativeScheduleMatch(
  stopNames: string[],
  patternStopCount: number,
  match: PatternMatchResult,
) {
  const firstMatchedStop = match.matchedStops[0] ?? null;
  const lastMatchedStop = match.matchedStops[match.matchedStops.length - 1] ?? null;
  const minimumTerminalScore = Math.min(
    firstMatchedStop?.score ?? 0,
    lastMatchedStop?.score ?? 0,
  );
  const averageScore =
    match.matchedStops.length === 0 ? 0 : match.score / match.matchedStops.length;
  const isFullCoverageMatch =
    match.coverageRatio === 1 &&
    match.unmatchedStopNames.length === 0 &&
    match.matchedStops.length === stopNames.length;

  if (
    match.matchedStops.length === 0 ||
    patternStopCount < match.matchedStops.length ||
    !match.matchedStops.every((stop) => stop.score >= AUTHORITATIVE_MINIMUM_STOP_SCORE)
  ) {
    return false;
  }

  if (isFullCoverageMatch && isLoopProfile(stopNames)) {
    return (
      minimumTerminalScore >= AUTHORITATIVE_MINIMUM_STOP_SCORE &&
      averageScore >= LOOP_MINIMUM_AVERAGE_SCORE
    );
  }

  if (
    isFullCoverageMatch &&
    stopNames.length >= HIGH_CONFIDENCE_MINIMUM_STOP_COUNT &&
    minimumTerminalScore >= HIGH_CONFIDENCE_MINIMUM_TERMINAL_SCORE &&
    averageScore >= HIGH_CONFIDENCE_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    isFullCoverageMatch &&
    stopNames.length >= 2 &&
    stopNames.length <= SPARSE_EXACT_MAXIMUM_STOP_COUNT &&
    minimumTerminalScore >= SPARSE_EXACT_MINIMUM_TERMINAL_SCORE &&
    averageScore >= SPARSE_EXACT_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    isFullCoverageMatch &&
    stopNames.length >= HIGH_CONFIDENCE_MINIMUM_STOP_COUNT &&
    stopNames.length <= SHORT_STRONG_MAXIMUM_STOP_COUNT &&
    minimumTerminalScore >= HIGH_CONFIDENCE_MINIMUM_TERMINAL_SCORE &&
    averageScore >= SHORT_STRONG_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    isFullCoverageMatch &&
    minimumTerminalScore >= STRICT_MINIMUM_TERMINAL_SCORE &&
    averageScore >= STRICT_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    isFullCoverageMatch &&
    stopNames.length >= RELAXED_MINIMUM_STOP_COUNT &&
    minimumTerminalScore >= STRONG_MINIMUM_TERMINAL_SCORE &&
    averageScore >= STRONG_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    stopNames.length >= NEAR_COMPLETE_MINIMUM_STOP_COUNT &&
    match.coverageRatio >= AUTHORITATIVE_NEAR_COMPLETE_MIN_COVERAGE &&
    match.unmatchedStopNames.length <= NEAR_COMPLETE_MAX_UNMATCHED_STOPS &&
    minimumTerminalScore >= STRONG_MINIMUM_TERMINAL_SCORE &&
    averageScore >= NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  if (
    stopNames.length >= STRONG_NEAR_COMPLETE_MINIMUM_STOP_COUNT &&
    match.coverageRatio >= STRONG_NEAR_COMPLETE_MINIMUM_COVERAGE &&
    match.unmatchedStopNames.length <= STRONG_NEAR_COMPLETE_MAX_UNMATCHED_STOPS &&
    minimumTerminalScore >= STRONG_NEAR_COMPLETE_MINIMUM_TERMINAL_SCORE &&
    averageScore >= STRONG_NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE
  ) {
    return true;
  }

  return (
    stopNames.length >= SHORT_NEAR_COMPLETE_MINIMUM_STOP_COUNT &&
    match.coverageRatio >= SHORT_NEAR_COMPLETE_MINIMUM_COVERAGE &&
    match.unmatchedStopNames.length <= SHORT_NEAR_COMPLETE_MAX_UNMATCHED_STOPS &&
    minimumTerminalScore >= SHORT_NEAR_COMPLETE_MINIMUM_TERMINAL_SCORE &&
    averageScore >= SHORT_NEAR_COMPLETE_MINIMUM_AVERAGE_SCORE
  );
}
