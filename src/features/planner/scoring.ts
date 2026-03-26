import { PlanPreference } from "@prisma/client";
import type { CandidateMetrics } from "@/features/planner/types";

function getReliabilityPenalty(metrics: CandidateMetrics) {
  switch (metrics.worstTimeReliability) {
    case "ROUGH":
      return 18 + metrics.roughWindowMinutes;
    case "ESTIMATED":
      return 6;
    case "OFFICIAL":
      return 0;
  }
}

export function scoreCandidate(kind: PlanPreference, metrics: CandidateMetrics) {
  const reliabilityPenalty = getReliabilityPenalty(metrics);

  switch (kind) {
    case "FASTEST":
      return (
        metrics.finalArrivalMinutes +
        metrics.transfers * 12 +
        metrics.totalWalkMinutes * 0.65 +
        metrics.safetyBufferCost +
        reliabilityPenalty
      );
    case "LEAST_WALK":
      return (
        metrics.totalWalkMinutes * 10 +
        metrics.transfers * 9 +
        metrics.finalArrivalMinutes * 0.35 +
        metrics.safetyBufferCost +
        reliabilityPenalty
      );
    case "LEAST_TRANSFER":
      return (
        metrics.transfers * 120 +
        metrics.totalWalkMinutes * 3 +
        metrics.finalArrivalMinutes * 0.5 +
        metrics.safetyBufferCost +
        reliabilityPenalty
      );
  }
}

export function compareMetrics(
  kind: PlanPreference,
  left: CandidateMetrics,
  right: CandidateMetrics,
) {
  const scoreDelta = scoreCandidate(kind, left) - scoreCandidate(kind, right);
  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  if (left.finalArrivalMinutes !== right.finalArrivalMinutes) {
    return left.finalArrivalMinutes - right.finalArrivalMinutes;
  }

  if (left.totalWalkMinutes !== right.totalWalkMinutes) {
    return left.totalWalkMinutes - right.totalWalkMinutes;
  }

  return left.transfers - right.transfers;
}
