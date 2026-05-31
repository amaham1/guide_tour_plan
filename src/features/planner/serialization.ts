import { Prisma } from "@prisma/client";
import type {
  CandidateLeg,
  CandidateSummary,
  CandidateTimeReliability,
  CandidateWarning,
  PlannerCandidateDto,
  TimeReliabilityMode,
} from "@/features/planner/types";

export function parseJson<T>(value: Prisma.JsonValue): T {
  return value as T;
}

export function isTimeReliabilityMode(value: unknown): value is TimeReliabilityMode {
  return (
    value === "OFFICIAL_ONLY" ||
    value === "INCLUDE_ESTIMATED" ||
    value === "ALLOW_ROUGH"
  );
}

export function isCandidateTimeReliability(
  value: unknown,
): value is CandidateTimeReliability {
  return value === "OFFICIAL" || value === "ESTIMATED" || value === "ROUGH";
}

export function normalizeCandidateLeg(leg: Record<string, unknown>): CandidateLeg {
  const timeReliability = isCandidateTimeReliability(leg.timeReliability)
    ? leg.timeReliability
    : leg.estimated
      ? "ESTIMATED"
      : "OFFICIAL";

  return {
    ...(leg as CandidateLeg),
    timeReliability,
    startWindowAt:
      typeof leg.startWindowAt === "string" ? leg.startWindowAt : null,
    endWindowAt: typeof leg.endWindowAt === "string" ? leg.endWindowAt : null,
  };
}

export function normalizeCandidateSummary(summary: Record<string, unknown>): CandidateSummary {
  const worstTimeReliability = isCandidateTimeReliability(summary.worstTimeReliability)
    ? summary.worstTimeReliability
    : summary.usesEstimatedStopTimes
      ? "ESTIMATED"
      : "OFFICIAL";

  return {
    ...(summary as CandidateSummary),
    worstTimeReliability,
    finalArrivalWindowStartAt:
      typeof summary.finalArrivalWindowStartAt === "string"
        ? summary.finalArrivalWindowStartAt
        : null,
    finalArrivalWindowEndAt:
      typeof summary.finalArrivalWindowEndAt === "string"
        ? summary.finalArrivalWindowEndAt
        : null,
  };
}

export function toPlannerCandidateDto(candidate: {
  id: string;
  kind: "FASTEST" | "LEAST_WALK" | "LEAST_TRANSFER";
  score: number;
  summary: Prisma.JsonValue;
  legs: Prisma.JsonValue;
  warnings: Prisma.JsonValue | null;
}): PlannerCandidateDto {
  const summary = normalizeCandidateSummary(
    parseJson<Record<string, unknown>>(candidate.summary),
  );
  const legs = parseJson<Record<string, unknown>[]>(candidate.legs).map(normalizeCandidateLeg);

  return {
    id: candidate.id,
    kind: candidate.kind,
    score: candidate.score,
    summary,
    legs,
    warnings: candidate.warnings
      ? parseJson<CandidateWarning[]>(candidate.warnings)
      : [],
  };
}
