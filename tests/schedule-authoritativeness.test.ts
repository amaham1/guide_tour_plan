import { describe, expect, it } from "vitest";
import { isAuthoritativeScheduleMatch } from "@/worker/jobs/schedule-authoritativeness";

describe("schedule authoritativeness", () => {
  it("accepts strong full-coverage matches with abbreviated terminals", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Origin", "A", "B", "C", "D", "Waypoint", "Terminal"],
        40,
        {
          patternId: "pattern-1",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 80 },
            { stopId: "b", sequence: 2, score: 90 },
            { stopId: "c", sequence: 3, score: 85 },
            { stopId: "d", sequence: 4, score: 80 },
            { stopId: "e", sequence: 5, score: 82 },
            { stopId: "f", sequence: 6, score: 83 },
            { stopId: "g", sequence: 7, score: 70 },
          ],
          unmatchedStopNames: [],
          score: 570,
          coverageRatio: 1,
        },
      ),
    ).toBe(true);
  });

  it("accepts loop profiles with repeated terminal names", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Loop", "Mid", "Loop"],
        20,
        {
          patternId: "pattern-loop",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 70 },
            { stopId: "b", sequence: 2, score: 78 },
            { stopId: "c", sequence: 3, score: 70 },
          ],
          unmatchedStopNames: [],
          score: 218,
          coverageRatio: 1,
        },
      ),
    ).toBe(true);
  });

  it("rejects weak full-coverage matches with low average quality", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Origin", "Mid", "Terminal"],
        20,
        {
          patternId: "pattern-weak",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 70 },
            { stopId: "b", sequence: 2, score: 70 },
            { stopId: "c", sequence: 3, score: 70 },
          ],
          unmatchedStopNames: [],
          score: 210,
          coverageRatio: 1,
        },
      ),
    ).toBe(false);
  });

  it("rejects partial matches even when the matched stops are strong", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Origin", "Mid", "Terminal"],
        20,
        {
          patternId: "pattern-partial",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "c", sequence: 3, score: 100 },
          ],
          unmatchedStopNames: ["Mid"],
          score: 200,
          coverageRatio: 2 / 3,
        },
      ),
    ).toBe(false);
  });

  it("accepts near-complete matches when exactly one interior stop is missing", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "A", "B", "C", "D", "E", "F", "Goal"],
        30,
        {
          patternId: "pattern-near",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "b", sequence: 2, score: 95 },
            { stopId: "c", sequence: 3, score: 90 },
            { stopId: "d", sequence: 4, score: 90 },
            { stopId: "e", sequence: 5, score: 85 },
            { stopId: "f", sequence: 6, score: 85 },
            { stopId: "g", sequence: 7, score: 80 },
          ],
          unmatchedStopNames: ["C"],
          score: 625,
          coverageRatio: 7 / 8,
        },
      ),
    ).toBe(true);
  });

  it("accepts 6-of-7 near-complete matches when only one stop is missing", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "A", "B", "C", "D", "E", "Goal"],
        24,
        {
          patternId: "pattern-near-seven",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 95 },
            { stopId: "b", sequence: 2, score: 95 },
            { stopId: "c", sequence: 3, score: 90 },
            { stopId: "d", sequence: 4, score: 90 },
            { stopId: "e", sequence: 5, score: 85 },
            { stopId: "f", sequence: 6, score: 80 },
          ],
          unmatchedStopNames: ["C"],
          score: 535,
          coverageRatio: 6 / 7,
        },
      ),
    ).toBe(true);
  });

  it("accepts near-complete matches when one terminal abbreviation scores 70", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "A", "B", "C", "D", "E", "Goal"],
        24,
        {
          patternId: "pattern-near-terminal",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "b", sequence: 2, score: 95 },
            { stopId: "c", sequence: 3, score: 90 },
            { stopId: "d", sequence: 4, score: 90 },
            { stopId: "e", sequence: 5, score: 85 },
            { stopId: "f", sequence: 6, score: 70 },
          ],
          unmatchedStopNames: ["C"],
          score: 530,
          coverageRatio: 6 / 7,
        },
      ),
    ).toBe(true);
  });

  it("accepts short full-coverage matches only when their scores are very strong", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "Mid", "Goal", "Terminal"],
        12,
        {
          patternId: "pattern-short",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 95 },
            { stopId: "b", sequence: 2, score: 90 },
            { stopId: "c", sequence: 3, score: 90 },
            { stopId: "d", sequence: 4, score: 85 },
          ],
          unmatchedStopNames: [],
          score: 360,
          coverageRatio: 1,
        },
      ),
    ).toBe(true);
  });

  it("accepts exact two-stop endpoint schedules when both terminals are unambiguous", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Origin", "Terminal"],
        30,
        {
          patternId: "pattern-two-stop",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "b", sequence: 2, score: 100 },
          ],
          unmatchedStopNames: [],
          score: 200,
          coverageRatio: 1,
        },
      ),
    ).toBe(true);
  });

  it("accepts short four-stop profiles when full coverage is strong but not perfect", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "City Hall", "Transfer", "Airport"],
        24,
        {
          patternId: "pattern-short-strong",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 80 },
            { stopId: "b", sequence: 2, score: 90 },
            { stopId: "c", sequence: 3, score: 90 },
            { stopId: "d", sequence: 4, score: 95 },
          ],
          unmatchedStopNames: [],
          score: 355,
          coverageRatio: 1,
        },
      ),
    ).toBe(true);
  });

  it("accepts strong near-complete matches with two unresolved interior timepoints", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Start", "A", "B", "C", "D", "E", "F", "G", "H", "Goal"],
        40,
        {
          patternId: "pattern-strong-near-complete",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "b", sequence: 2, score: 96 },
            { stopId: "c", sequence: 3, score: 92 },
            { stopId: "d", sequence: 4, score: 90 },
            { stopId: "e", sequence: 5, score: 88 },
            { stopId: "f", sequence: 6, score: 90 },
            { stopId: "g", sequence: 7, score: 95 },
            { stopId: "h", sequence: 8, score: 100 },
          ],
          unmatchedStopNames: ["C", "F"],
          score: 751,
          coverageRatio: 0.8,
        },
      ),
    ).toBe(true);
  });

  it("accepts strong short profiles with one missing stop when the terminals are exact", () => {
    expect(
      isAuthoritativeScheduleMatch(
        ["Origin", "Transfer", "Museum", "Trail", "Mid", "Terminal"],
        28,
        {
          patternId: "pattern-short-near-complete",
          matchedStops: [
            { stopId: "a", sequence: 1, score: 100 },
            { stopId: "b", sequence: 2, score: 95 },
            { stopId: "c", sequence: 3, score: 95 },
            { stopId: "d", sequence: 4, score: 90 },
            { stopId: "e", sequence: 5, score: 100 },
          ],
          unmatchedStopNames: ["Mid"],
          score: 480,
          coverageRatio: 5 / 6,
        },
      ),
    ).toBe(true);
  });
});
