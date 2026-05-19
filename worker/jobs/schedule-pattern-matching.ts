import { buildStopNameKeys, scoreStopNameMatch } from "@/worker/jobs/helpers";
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
  minimumCoverage?: number;
  minimumStopScore?: number;
};

type RankedPatternMatch = PatternMatchResult & {
  matchedPatternIndexes: number[];
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
  minimumStopScore = 70,
): PatternMatchResult {
  const scoreMatrix = stopNames.map((stopName) =>
    pattern.stops.map((stop) => getStopScore(stopName, stop)),
  );
  const memo = new Map<string, RankedPatternMatch>();

  function compareRankedMatches(left: RankedPatternMatch, right: RankedPatternMatch) {
    if (left.matchedStops.length !== right.matchedStops.length) {
      return right.matchedStops.length - left.matchedStops.length;
    }

    if (left.score !== right.score) {
      return right.score - left.score;
    }

    if (left.unmatchedStopNames.length !== right.unmatchedStopNames.length) {
      return left.unmatchedStopNames.length - right.unmatchedStopNames.length;
    }

    for (
      let index = 0;
      index < Math.min(left.matchedPatternIndexes.length, right.matchedPatternIndexes.length);
      index += 1
    ) {
      if (left.matchedPatternIndexes[index] !== right.matchedPatternIndexes[index]) {
        return left.matchedPatternIndexes[index] - right.matchedPatternIndexes[index];
      }
    }

    return 0;
  }

  function search(stopNameIndex: number, cursor: number): RankedPatternMatch {
    const key = `${stopNameIndex}:${cursor}`;
    const cached = memo.get(key);
    if (cached) {
      return cached;
    }

    if (stopNameIndex >= stopNames.length) {
      const empty = {
        patternId: pattern.id,
        matchedStops: [],
        unmatchedStopNames: [],
        score: 0,
        coverageRatio: 0,
        matchedPatternIndexes: [],
      } satisfies RankedPatternMatch;
      memo.set(key, empty);
      return empty;
    }

    const skipResult = search(stopNameIndex + 1, cursor);
    let best = {
      patternId: pattern.id,
      matchedStops: skipResult.matchedStops,
      unmatchedStopNames: [stopNames[stopNameIndex], ...skipResult.unmatchedStopNames],
      score: skipResult.score,
      coverageRatio: 0,
      matchedPatternIndexes: skipResult.matchedPatternIndexes,
    } satisfies RankedPatternMatch;

    for (let patternIndex = cursor; patternIndex < pattern.stops.length; patternIndex += 1) {
      const candidateScore = scoreMatrix[stopNameIndex]?.[patternIndex] ?? 0;
      if (candidateScore < minimumStopScore) {
        continue;
      }

      const next = search(stopNameIndex + 1, patternIndex + 1);
      const candidate = {
        patternId: pattern.id,
        matchedStops: [
          {
            stopId: pattern.stops[patternIndex].stopId,
            sequence: pattern.stops[patternIndex].sequence,
            score: candidateScore,
          },
          ...next.matchedStops,
        ],
        unmatchedStopNames: next.unmatchedStopNames,
        score: candidateScore + next.score,
        coverageRatio: 0,
        matchedPatternIndexes: [patternIndex, ...next.matchedPatternIndexes],
      } satisfies RankedPatternMatch;

      if (compareRankedMatches(candidate, best) < 0) {
        best = candidate;
      }
    }

    best = {
      ...best,
      coverageRatio:
        stopNames.length === 0 ? 0 : best.matchedStops.length / stopNames.length,
    };
    memo.set(key, best);
    return best;
  }

  const best = search(0, 0);

  return {
    patternId: best.patternId,
    matchedStops: best.matchedStops,
    unmatchedStopNames: best.unmatchedStopNames,
    score: best.score,
    coverageRatio: best.coverageRatio,
  };
}

export function chooseBestPatternMatch(input: PatternMatchInput, patterns: MatchableRoutePattern[]) {
  const ranked = patterns
    .map((pattern) => {
      const result = matchStopNamesToPattern(
        input.stopNames,
        pattern,
        input.minimumStopScore ?? 70,
      );
      const variantExact = Boolean(
        input.variantKey && extractRouteShortNameTokens(pattern.shortName).includes(input.variantKey),
      );
      const terminalExactCount = getTerminalExactCount(input.stopNames, pattern);
      const viaMatchedCount = getViaMatchedCount(input.viaStops ?? [], pattern);
      const waypointTerminalMatches = getWaypointTerminalMatches(input.terminalHint, pattern);
      const minimumCoverage =
        input.minimumCoverage ??
        resolveMinimumCoverage(
          input,
          variantExact,
          terminalExactCount,
          waypointTerminalMatches,
          viaMatchedCount,
        );

      return {
        ...result,
        patternId: pattern.id,
        shortName: pattern.shortName,
        variantExact,
        terminalExactCount,
        viaMatchedCount,
        waypointTerminalMatches,
        minimumCoverage,
        displayName: pattern.displayName ?? null,
        directionLabel: pattern.directionLabel ?? null,
        terminalSignature: [
          pattern.stops[0]?.displayName ?? "",
          pattern.stops[pattern.stops.length - 1]?.displayName ?? "",
        ].join("|"),
        matchedStopSignature: result.matchedStops
          .map((stop) => `${stop.stopId}:${stop.sequence}`)
          .join("|"),
        matchedNameSignature: result.matchedStops
          .map((stop) => {
            const matchedPatternStop = pattern.stops.find(
              (candidateStop) =>
                candidateStop.stopId === stop.stopId && candidateStop.sequence === stop.sequence,
            );
            const [primaryKey] = buildStopNameKeys(matchedPatternStop?.displayName ?? "");
            return primaryKey ?? `${stop.sequence}`;
          })
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

      if (left.waypointTerminalMatches !== right.waypointTerminalMatches) {
        return right.waypointTerminalMatches - left.waypointTerminalMatches;
      }

      return left.patternId.localeCompare(right.patternId);
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
    const equivalentDuplicates = tiedResults.every(
      (candidate) =>
        candidate.matchedNameSignature === best.matchedNameSignature &&
        candidate.shortName === best.shortName,
    );

    if (!equivalentDuplicates) {
      return null;
    }
  }

  return {
    patternId: best.patternId,
    matchedStops: best.matchedStops,
    unmatchedStopNames: best.unmatchedStopNames,
    score: best.score,
    coverageRatio: best.coverageRatio,
  };
}
