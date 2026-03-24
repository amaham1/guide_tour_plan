import { scoreStopNameMatch } from "@/worker/jobs/helpers";
import { extractRouteShortNameTokens } from "@/worker/jobs/route-labels";

export type MatchablePatternStop = {
  stopId: string;
  sequence: number;
  displayName: string;
  translations: string[];
};

export type MatchableRoutePattern = {
  id: string;
  shortName: string;
  displayName?: string | null;
  directionLabel?: string | null;
  stops: MatchablePatternStop[];
};

export type PatternStopMatch = {
  stopId: string;
  sequence: number;
  score: number;
};

export type PatternMatchResult = {
  patternId: string;
  matchedStops: PatternStopMatch[];
  unmatchedStopNames: string[];
  score: number;
  coverageRatio: number;
};

export type PatternMatchInput = {
  variantKey?: string | null;
  stopNames: string[];
  terminalHint?: {
    origin: string | null;
    destination: string | null;
  };
  viaStops?: string[];
};

function getStopScore(stopName: string, stop: MatchablePatternStop) {
  return Math.max(
    scoreStopNameMatch(stopName, stop.displayName),
    ...stop.translations.map((translation) => scoreStopNameMatch(stopName, translation)),
  );
}

function getTerminalExactCount(stopNames: string[], pattern: MatchableRoutePattern) {
  if (stopNames.length === 0 || pattern.stops.length === 0) {
    return 0;
  }

  let count = 0;
  if (scoreStopNameMatch(stopNames[0], pattern.stops[0]?.displayName ?? "") === 100) {
    count += 1;
  }

  if (
    stopNames.length > 1 &&
    scoreStopNameMatch(
      stopNames[stopNames.length - 1],
      pattern.stops[pattern.stops.length - 1]?.displayName ?? "",
    ) === 100
  ) {
    count += 1;
  }

  return count;
}

function getWaypointTerminalMatches(
  terminalHint: PatternMatchInput["terminalHint"],
  pattern: MatchableRoutePattern,
) {
  if (!terminalHint || pattern.stops.length === 0) {
    return 0;
  }

  let count = 0;
  if (
    terminalHint.origin &&
    scoreStopNameMatch(terminalHint.origin, pattern.stops[0]?.displayName ?? "") === 100
  ) {
    count += 1;
  }

  if (
    terminalHint.destination &&
    scoreStopNameMatch(
      terminalHint.destination,
      pattern.stops[pattern.stops.length - 1]?.displayName ?? "",
    ) === 100
  ) {
    count += 1;
  }

  return count;
}

function getViaMatchedCount(viaStops: string[], pattern: MatchableRoutePattern) {
  if (viaStops.length === 0) {
    return 0;
  }

  return viaStops.filter((viaStop) =>
    pattern.stops.some((stop) => getStopScore(viaStop, stop) === 100),
  ).length;
}

function resolveMinimumCoverage(
  input: PatternMatchInput,
  variantExact: boolean,
  terminalExactCount: number,
  waypointTerminalMatches: number,
  viaMatchedCount: number,
) {
  if (input.stopNames.length >= 8) {
    return 0.8;
  }

  if (input.stopNames.length >= 5) {
    return variantExact && (terminalExactCount > 0 || waypointTerminalMatches > 0) ? 0.65 : 0.8;
  }

  return waypointTerminalMatches > 0 && viaMatchedCount >= 2 ? 0.5 : 0.8;
}

export function matchStopNamesToPattern(
  stopNames: string[],
  pattern: MatchableRoutePattern,
): PatternMatchResult {
  const matchedStops: PatternStopMatch[] = [];
  const unmatchedStopNames: string[] = [];
  let score = 0;
  let cursor = 0;

  for (const stopName of stopNames) {
    let bestIndex = -1;
    let bestScore = 0;
    let bestStop: MatchablePatternStop | null = null;

    for (let index = cursor; index < pattern.stops.length; index += 1) {
      const candidate = pattern.stops[index];
      const candidateScore = getStopScore(stopName, candidate);
      if (candidateScore > bestScore) {
        bestIndex = index;
        bestScore = candidateScore;
        bestStop = candidate;
      }

      if (candidateScore === 100) {
        break;
      }
    }

    if (!bestStop || bestScore < 70 || bestIndex < cursor) {
      unmatchedStopNames.push(stopName);
      continue;
    }

    matchedStops.push({
      stopId: bestStop.stopId,
      sequence: bestStop.sequence,
      score: bestScore,
    });
    score += bestScore;
    cursor = bestIndex + 1;
  }

  return {
    patternId: pattern.id,
    matchedStops,
    unmatchedStopNames,
    score,
    coverageRatio: stopNames.length === 0 ? 0 : matchedStops.length / stopNames.length,
  };
}

export function chooseBestPatternMatch(input: PatternMatchInput, patterns: MatchableRoutePattern[]) {
  const ranked = patterns
    .map((pattern) => {
      const result = matchStopNamesToPattern(input.stopNames, pattern);
      const variantExact = Boolean(
        input.variantKey && extractRouteShortNameTokens(pattern.shortName).includes(input.variantKey),
      );
      const terminalExactCount = getTerminalExactCount(input.stopNames, pattern);
      const viaMatchedCount = getViaMatchedCount(input.viaStops ?? [], pattern);
      const waypointTerminalMatches = getWaypointTerminalMatches(input.terminalHint, pattern);
      const minimumCoverage = resolveMinimumCoverage(
        input,
        variantExact,
        terminalExactCount,
        waypointTerminalMatches,
        viaMatchedCount,
      );

      return {
        ...result,
        variantExact,
        terminalExactCount,
        viaMatchedCount,
        waypointTerminalMatches,
        minimumCoverage,
        terminalSignature: [
          pattern.stops[0]?.displayName ?? "",
          pattern.stops[pattern.stops.length - 1]?.displayName ?? "",
        ].join("|"),
        matchedStopSignature: result.matchedStops
          .map((stop) => `${stop.stopId}:${stop.sequence}`)
          .join("|"),
      };
    })
    .filter((candidate) => candidate.coverageRatio >= candidate.minimumCoverage)
    .sort((left, right) => {
      if (left.variantExact !== right.variantExact) {
        return Number(right.variantExact) - Number(left.variantExact);
      }

      if (left.terminalExactCount !== right.terminalExactCount) {
        return right.terminalExactCount - left.terminalExactCount;
      }

      if (left.unmatchedStopNames.length !== right.unmatchedStopNames.length) {
        return left.unmatchedStopNames.length - right.unmatchedStopNames.length;
      }

      if (left.coverageRatio !== right.coverageRatio) {
        return right.coverageRatio - left.coverageRatio;
      }

      if (left.score !== right.score) {
        return right.score - left.score;
      }

      if (left.viaMatchedCount !== right.viaMatchedCount) {
        return right.viaMatchedCount - left.viaMatchedCount;
      }

      return right.waypointTerminalMatches - left.waypointTerminalMatches;
    });

  const best = ranked[0];
  if (!best) {
    return null;
  }

  const tiedResults = ranked.filter(
    (candidate) =>
      candidate.variantExact === best.variantExact &&
      candidate.terminalExactCount === best.terminalExactCount &&
      candidate.unmatchedStopNames.length === best.unmatchedStopNames.length &&
      Math.abs(candidate.coverageRatio - best.coverageRatio) < 0.0001 &&
      candidate.score === best.score &&
      candidate.viaMatchedCount === best.viaMatchedCount &&
      candidate.waypointTerminalMatches === best.waypointTerminalMatches,
  );

  if (
    tiedResults.length > 1 &&
    !tiedResults.every((candidate) => candidate.matchedStopSignature === best.matchedStopSignature)
  ) {
    return null;
  }

  return {
    patternId: best.patternId,
    matchedStops: best.matchedStops,
    unmatchedStopNames: best.unmatchedStopNames,
    score: best.score,
    coverageRatio: best.coverageRatio,
  };
}
