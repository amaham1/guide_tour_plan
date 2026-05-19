import { describe, expect, it } from "vitest";
import {
  choosePreferredDerivedStopTimes,
  getAllowedDerivedTimeSources,
} from "@/features/planner/service";

describe("planner derived time source policy", () => {
  it("allows SEGMENT_PROFILE from INCLUDE_ESTIMATED onward", () => {
    expect([...getAllowedDerivedTimeSources("OFFICIAL_ONLY")]).toEqual([]);
    expect([...getAllowedDerivedTimeSources("INCLUDE_ESTIMATED")]).toEqual([
      "SEGMENT_PROFILE",
      "OFFICIAL_ANCHOR_INTERPOLATED",
    ]);
    expect([...getAllowedDerivedTimeSources("ALLOW_ROUGH")]).toEqual([
      "SEGMENT_PROFILE",
      "OFFICIAL_ANCHOR_INTERPOLATED",
      "DISTANCE_INTERPOLATED",
    ]);
  });

  it("prefers observed segment profile rows over other derived rows for a stop sequence", () => {
    const selected = choosePreferredDerivedStopTimes([
      {
        sequence: 2,
        timeSource: "DISTANCE_INTERPOLATED",
        confidence: 0.5,
        label: "rough",
      },
      {
        sequence: 2,
        timeSource: "OFFICIAL_ANCHOR_INTERPOLATED",
        confidence: 0.8,
        label: "strict",
      },
      {
        sequence: 2,
        timeSource: "SEGMENT_PROFILE",
        confidence: 0.7,
        label: "observed",
      },
    ]);

    expect(selected).toEqual([
      expect.objectContaining({
        label: "observed",
      }),
    ]);
  });
});
