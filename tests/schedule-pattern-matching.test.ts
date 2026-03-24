import { describe, expect, it } from "vitest";
import { chooseBestPatternMatch } from "../worker/jobs/schedule-pattern-matching";

describe("schedule pattern matching", () => {
  it("selects the best ordered pattern for a timetable header", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "111",
        stopNames: ["Airport", "City Hall", "Seongsan"],
      },
      [
        {
          id: "pattern-a",
          shortName: "111",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Airport", translations: [] },
            { stopId: "b", sequence: 2, displayName: "Seogwipo", translations: [] },
            { stopId: "c", sequence: 3, displayName: "Seongsan", translations: [] },
          ],
        },
        {
          id: "pattern-b",
          shortName: "111",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Airport", translations: [] },
            { stopId: "b", sequence: 2, displayName: "City Hall", translations: [] },
            { stopId: "c", sequence: 3, displayName: "Seongsan", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-b");
    expect(match?.unmatchedStopNames).toEqual([]);
  });

  it("uses variant, terminal, and via hints for sparse headers", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "122",
        stopNames: ["Airport", "Unknown"],
        terminalHint: {
          origin: "Airport",
          destination: "Folk Village",
        },
        viaStops: ["City Hall", "Hospital"],
      },
      [
        {
          id: "pattern-121",
          shortName: "121",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Airport", translations: [] },
            { stopId: "b", sequence: 2, displayName: "Terminal", translations: [] },
            { stopId: "c", sequence: 3, displayName: "Market", translations: [] },
            { stopId: "d", sequence: 4, displayName: "Folk Village", translations: [] },
          ],
        },
        {
          id: "pattern-122",
          shortName: "122",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Airport", translations: [] },
            { stopId: "b", sequence: 2, displayName: "City Hall", translations: [] },
            { stopId: "c", sequence: 3, displayName: "Hospital", translations: [] },
            { stopId: "d", sequence: 4, displayName: "Folk Village", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-122");
    expect(match?.coverageRatio).toBe(0.5);
  });

  it("resolves ties when the matched stop sequence is effectively identical", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "201",
        stopNames: ["Terminal", "Seongsan"],
      },
      [
        {
          id: "pattern-a",
          shortName: "201",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "x", sequence: 2, displayName: "Hidden", translations: [] },
            { stopId: "b", sequence: 3, displayName: "Seongsan", translations: [] },
          ],
        },
        {
          id: "pattern-b",
          shortName: "201",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "y", sequence: 2, displayName: "Another Hidden", translations: [] },
            { stopId: "b", sequence: 3, displayName: "Seongsan", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-a");
    expect(match?.coverageRatio).toBe(1);
  });

  it("keeps returning null for genuinely ambiguous but different matches", () => {
    const match = chooseBestPatternMatch(
      {
        stopNames: ["Terminal", "Transfer"],
      },
      [
        {
          id: "pattern-a",
          shortName: "201",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "b", sequence: 2, displayName: "Transfer", translations: [] },
          ],
        },
        {
          id: "pattern-b",
          shortName: "201",
          stops: [
            { stopId: "a", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "c", sequence: 2, displayName: "Transfer", translations: [] },
          ],
        },
      ],
    );

    expect(match).toBeNull();
  });
});
