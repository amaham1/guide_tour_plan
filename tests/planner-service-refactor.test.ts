import { describe, expect, it } from "vitest";
import {
  normalizeCandidateLeg,
  normalizeCandidateSummary,
  toPlannerCandidateDto,
} from "@/features/planner/serialization";
import {
  nextHigherTimeReliabilityMode,
  nextSuggestedModeFromStatus,
  statusFromNextSuggestedMode,
} from "@/features/planner/reliability-policy";

describe("planner service refactor seams", () => {
  it("keeps legacy candidate JSON compatible with current reliability fields", () => {
    const summary = normalizeCandidateSummary({
      planId: "plan-1",
      title: "legacy",
      narrative: "legacy summary",
      totalDurationMinutes: 30,
      totalWalkMinutes: 4,
      transfers: 0,
      finalArrivalAt: "2026-03-24T01:00:00.000Z",
      realtimeEligible: true,
      usesEstimatedStopTimes: true,
      safetyBufferCost: 0,
    });
    const leg = normalizeCandidateLeg({
      id: "leg-1",
      kind: "ride",
      title: "legacy ride",
      startAt: "2026-03-24T00:30:00.000Z",
      endAt: "2026-03-24T01:00:00.000Z",
      durationMinutes: 30,
      estimated: true,
    });

    expect(summary.worstTimeReliability).toBe("ESTIMATED");
    expect(summary.finalArrivalWindowStartAt).toBeNull();
    expect(summary.finalArrivalWindowEndAt).toBeNull();
    expect(leg.timeReliability).toBe("ESTIMATED");
    expect(leg.startWindowAt).toBeNull();
    expect(leg.endWindowAt).toBeNull();
  });

  it("keeps persisted candidate DTO normalization behavior", () => {
    const candidate = toPlannerCandidateDto({
      id: "candidate-1",
      kind: "FASTEST",
      score: 10,
      summary: {
        planId: "plan-1",
        title: "legacy",
        narrative: "legacy summary",
        totalDurationMinutes: 30,
        totalWalkMinutes: 4,
        transfers: 0,
        finalArrivalAt: "2026-03-24T01:00:00.000Z",
        realtimeEligible: true,
        worstTimeReliability: "ROUGH",
        safetyBufferCost: 12,
      },
      legs: [
        {
          id: "leg-1",
          kind: "ride",
          title: "rough ride",
          startAt: "2026-03-24T00:30:00.000Z",
          endAt: "2026-03-24T01:00:00.000Z",
          durationMinutes: 30,
          timeReliability: "ROUGH",
          startWindowAt: "2026-03-24T00:24:00.000Z",
          endWindowAt: "2026-03-24T01:06:00.000Z",
        },
      ],
      warnings: null,
    });

    expect(candidate.summary.worstTimeReliability).toBe("ROUGH");
    expect(candidate.legs[0]?.timeReliability).toBe("ROUGH");
    expect(candidate.legs[0]?.startWindowAt).toBe("2026-03-24T00:24:00.000Z");
    expect(candidate.warnings).toEqual([]);
  });

  it("keeps reliability fallback status transitions stable", () => {
    expect(nextHigherTimeReliabilityMode("OFFICIAL_ONLY")).toBe("INCLUDE_ESTIMATED");
    expect(nextHigherTimeReliabilityMode("INCLUDE_ESTIMATED")).toBe("ALLOW_ROUGH");
    expect(nextHigherTimeReliabilityMode("ALLOW_ROUGH")).toBeNull();

    expect(statusFromNextSuggestedMode("INCLUDE_ESTIMATED")).toBe(
      "NO_ROUTE_ESTIMATED_AVAILABLE",
    );
    expect(statusFromNextSuggestedMode("ALLOW_ROUGH")).toBe("NO_ROUTE_ROUGH_AVAILABLE");
    expect(statusFromNextSuggestedMode(null)).toBe("NO_ROUTE");

    expect(nextSuggestedModeFromStatus("NO_ROUTE_GENERATED_AVAILABLE")).toBe(
      "INCLUDE_ESTIMATED",
    );
    expect(nextSuggestedModeFromStatus("NO_ROUTE_ROUGH_AVAILABLE")).toBe("ALLOW_ROUGH");
    expect(nextSuggestedModeFromStatus("COMPUTED")).toBeUndefined();
  });
});
