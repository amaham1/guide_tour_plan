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

  it("matches canonical stop abbreviations against formal stop names", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "102",
        stopNames: ["고산", "공항", "제주터미널"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-102",
          shortName: "102",
          stops: [
            {
              stopId: "a",
              sequence: 1,
              displayName: "고산환승정류장(고산1리 고산성당 앞)[동]",
              translations: [],
            },
            {
              stopId: "b",
              sequence: 2,
              displayName: "제주국제공항(하차전용)",
              translations: [],
            },
            {
              stopId: "c",
              sequence: 3,
              displayName: "제주버스터미널(종점)",
              translations: [],
            },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-102");
    expect(match?.coverageRatio).toBe(1);
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100]);
  });

  it("matches common school and route abbreviations used in sparse 제주 headers", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "300",
        stopNames: [
          "\uC0BC\uC591\uCD08\uAD50",
          "\uC678\uB3C4\uCD08\uAD50",
          "\uD558\uADC0\uCD08\uAD50",
        ],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-300",
          shortName: "300",
          stops: [
            {
              stopId: "a",
              sequence: 1,
              displayName: "\uC0BC\uC591\uCD08\uB4F1\uD559\uAD50",
              translations: [],
            },
            {
              stopId: "b",
              sequence: 2,
              displayName: "\uC678\uB3C4\uCD08\uB4F1\uD559\uAD50",
              translations: [],
            },
            {
              stopId: "c",
              sequence: 3,
              displayName: "\uD558\uADC0\uCD08\uB4F1\uD559\uAD50",
              translations: [],
            },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-300");
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100]);
  });

  it("matches route-family aliases like 수망리 and 한림공고 against canonical stop names", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "291",
        stopNames: [
          "\uC218\uB9DD\uB9AC",
          "\uD55C\uB9BC\uACF5\uACE0",
          "\uC81C\uC8FC\uC5EC\uC911\uACE0",
        ],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-291",
          shortName: "291",
          stops: [
            {
              stopId: "a",
              sequence: 1,
              displayName: "\uC218\uB9DD\uAC00\uB984[\uB3D9]",
              translations: [],
            },
            {
              stopId: "b",
              sequence: 2,
              displayName: "\uD55C\uB9BC\uD56D\uACF5\uC6B0\uC8FC\uACE0\uB4F1\uD559\uAD50",
              translations: [],
            },
            {
              stopId: "c",
              sequence: 3,
              displayName: "\uC81C\uC8FC\uC5EC\uC790\uC911\uACE0\uB4F1\uD559\uAD50(\uAD11\uC591\uBC29\uBA74)",
              translations: [],
            },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-291");
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100]);
  });

  it("matches reordered labels and newer 제주 stop aliases used in sparse headers", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "800",
        stopNames: [
          "\uC11C\uADC0\uD3EC\uC2DC\uCCAD 2\uCCAD\uC0AC(\uC11C\uADC0\uD3EC\uC6B0\uCCB4\uAD6D)",
          "\uC81C\uC8FC\uB300\uD559\uBCD1\uC6D0",
          "\uD654\uBD81\uC8FC\uACF5 \uC785\uAD6C",
          "\uB178\uD615\uC624\uAC70\uB9AC",
        ],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-800",
          shortName: "800",
          stops: [
            {
              stopId: "a",
              sequence: 1,
              displayName:
                "\uC11C\uADC0\uD3EC\uC6B0\uCCB4\uAD6D \uC11C\uADC0\uD3EC\uC2DC\uCCAD \uC81C2\uCCAD\uC0AC",
              translations: [],
            },
            {
              stopId: "b",
              sequence: 2,
              displayName: "\uC81C\uC8FC\uB300\uD559\uAD50\uBCD1\uC6D0[\uC11C]",
              translations: [],
            },
            {
              stopId: "c",
              sequence: 3,
              displayName: "\uD654\uBD81\uC8FC\uACF5\uC544\uD30C\uD2B8\uC785\uAD6C[\uB3D9]",
              translations: [],
            },
            {
              stopId: "d",
              sequence: 4,
              displayName: "\uB178\uD615\uC624\uAC70\uB9AC/\uC774\uB9C8\uD2B8[\uB0A8]",
              translations: [],
            },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-800");
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100, 100]);
  });

  it("matches remaining area shorthand aliases like 사대부속 고등학교, 한라대학, and 신화역사공원", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "3006",
        stopNames: [
          "\uC0AC\uB300\uBD80\uC18D \uACE0\uB4F1\uD559\uAD50",
          "\uD55C\uB77C\uB300\uD559",
          "\uC2E0\uD654\uC5ED\uC0AC\uACF5\uC6D0",
        ],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-3006",
          shortName: "3006",
          stops: [
            {
              stopId: "a",
              sequence: 1,
              displayName: "\uC0AC\uB300\uBD80\uACE0[\uB0A8]",
              translations: [],
            },
            {
              stopId: "b",
              sequence: 2,
              displayName: "\uC81C\uC8FC\uD55C\uB77C\uB300\uD559\uAD50[\uB3D9]",
              translations: [],
            },
            {
              stopId: "c",
              sequence: 3,
              displayName: "\uC81C\uC8FC\uC2E0\uD654\uC6D4\uB4DC \uC785\uAD6C",
              translations: [],
            },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-3006");
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100]);
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

  it("chooses deterministically when duplicate patterns have the same labels and matched stop names", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "251",
        stopNames: ["Terminal", "Waypoint", "Harbor"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-b",
          shortName: "251",
          displayName: "251 Terminal Harbor",
          directionLabel: "Terminal -> Harbor",
          stops: [
            { stopId: "a-1", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "b-1", sequence: 2, displayName: "Waypoint", translations: [] },
            { stopId: "c-1", sequence: 3, displayName: "Harbor", translations: [] },
          ],
        },
        {
          id: "pattern-a",
          shortName: "251",
          displayName: "251 Terminal Harbor",
          directionLabel: "Terminal -> Harbor",
          stops: [
            { stopId: "a-2", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "b-2", sequence: 2, displayName: "Waypoint", translations: [] },
            { stopId: "c-2", sequence: 3, displayName: "Harbor", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-a");
    expect(match?.coverageRatio).toBe(1);
  });

  it("chooses deterministically when duplicate sparse signatures share the same short name and terminals", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "292",
        stopNames: ["Terminal", "Transfer", "Harbor"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-b",
          shortName: "291/292/293",
          displayName: "Pattern B",
          directionLabel: "Direction B",
          stops: [
            { stopId: "a-1", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "b-1", sequence: 2, displayName: "Transfer", translations: [] },
            { stopId: "c-1", sequence: 3, displayName: "Harbor", translations: [] },
          ],
        },
        {
          id: "pattern-a",
          shortName: "291/292/293",
          displayName: "Pattern A",
          directionLabel: "Direction A",
          stops: [
            { stopId: "a-2", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "b-2", sequence: 2, displayName: "Transfer", translations: [] },
            { stopId: "c-2", sequence: 3, displayName: "Harbor", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-a");
    expect(match?.coverageRatio).toBe(1);
  });

  it("chooses deterministically when duplicate sparse signatures share the same matched stop names but different terminals", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "346",
        stopNames: ["Terminal", "Transfer", "School", "Goal"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-b",
          shortName: "346",
          displayName: "346 Branch B",
          directionLabel: "Branch B",
          stops: [
            { stopId: "a-1", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "x-1", sequence: 2, displayName: "Transfer", translations: [] },
            { stopId: "y-1", sequence: 3, displayName: "School", translations: [] },
            { stopId: "z-1", sequence: 4, displayName: "Goal", translations: [] },
          ],
        },
        {
          id: "pattern-a",
          shortName: "346",
          displayName: "346 Branch A",
          directionLabel: "Branch A",
          stops: [
            { stopId: "a-2", sequence: 1, displayName: "Terminal", translations: [] },
            { stopId: "x-2", sequence: 2, displayName: "Transfer", translations: [] },
            { stopId: "y-2", sequence: 3, displayName: "School", translations: [] },
            { stopId: "z-2", sequence: 4, displayName: "Goal", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-a");
    expect(match?.coverageRatio).toBe(1);
  });

  it("matches common city-bus shorthand like R and A suffixes plus school abbreviations", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "3001",
        stopNames: ["신제주R", "제원A", "연동대림A", "용문R", "중앙고", "신고", "여고", "여상"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-3001",
          shortName: "3001",
          stops: [
            { stopId: "a", sequence: 1, displayName: "제주도청 신제주로터리", translations: [] },
            { stopId: "b", sequence: 2, displayName: "제원아파트[동]", translations: [] },
            { stopId: "c", sequence: 3, displayName: "연동대림1차아파트", translations: [] },
            { stopId: "d", sequence: 4, displayName: "용문사거리", translations: [] },
            { stopId: "e", sequence: 5, displayName: "제주중앙고등학교", translations: [] },
            { stopId: "f", sequence: 6, displayName: "신성여자중고등학교", translations: [] },
            { stopId: "g", sequence: 7, displayName: "제주여자중고등학교", translations: [] },
            { stopId: "h", sequence: 8, displayName: "제주여자상업고등학교", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-3001");
    expect(match?.coverageRatio).toBe(1);
    expect(match?.matchedStops).toHaveLength(8);
    expect(match?.matchedStops.every((stop) => stop.score >= 70)).toBe(true);
  });

  it("matches seogwipo local shorthand aliases used in sparse timepoint tables", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "651",
        stopNames: ["천지연", "서문로터리", "서귀여중", "토평초교", "회수", "중문 우체국", "법환농협"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-651",
          shortName: "651번 652",
          stops: [
            { stopId: "a", sequence: 1, displayName: "천지연폭포", translations: [] },
            { stopId: "b", sequence: 2, displayName: "서문로터리입구[남]", translations: [] },
            { stopId: "c", sequence: 3, displayName: "서귀포여자중학교[서]", translations: [] },
            { stopId: "d", sequence: 4, displayName: "토평초등학교[남]", translations: [] },
            { stopId: "e", sequence: 5, displayName: "회수마을회관", translations: [] },
            { stopId: "f", sequence: 6, displayName: "중문환승정류장(중문우체국)[남]", translations: [] },
            { stopId: "g", sequence: 7, displayName: "법환초등학교[남]", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-651");
    expect(match?.coverageRatio).toBe(1);
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100, 100, 100, 95, 100]);
  });

  it("matches remaining shorthand aliases used by late-stage seogwipo and airport routes", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "800-1",
        stopNames: ["도립미술관", "회수사거리", "서귀포오일장", "남주고"],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-800-1",
          shortName: "800-1",
          stops: [
            { stopId: "a", sequence: 1, displayName: "제주도립미술관입구", translations: [] },
            { stopId: "b", sequence: 2, displayName: "회수사거리, 연화빌", translations: [] },
            { stopId: "c", sequence: 3, displayName: "서귀포향토오일시장[남]", translations: [] },
            { stopId: "d", sequence: 4, displayName: "남주중고등학교[북]", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-800-1");
    expect(match?.coverageRatio).toBe(1);
    expect(match?.matchedStops.map((stop) => stop.score)).toEqual([100, 100, 100, 100]);
  });

  it("matches demand-response shorthand against long formal stop names", () => {
    const match = chooseBestPatternMatch(
      {
        variantKey: "182-1",
        stopNames: [
          "공항",
          "제주도청(신제주로터리)",
          "동광육거리(동광환승정류장)",
          "서귀포중앙로터리",
          "비석거리",
        ],
        minimumCoverage: 1,
        minimumStopScore: 70,
      },
      [
        {
          id: "pattern-182-1",
          shortName: "수요맞춤형 182-1",
          stops: [
            { stopId: "a", sequence: 1, displayName: "제주국제공항(하차전용)", translations: [] },
            { stopId: "b", sequence: 2, displayName: "제주도청 신제주로터리[서]", translations: [] },
            { stopId: "c", sequence: 3, displayName: "동광환승정류장5(서귀방면)", translations: [] },
            { stopId: "d", sequence: 4, displayName: "중앙로터리/제주권역재활병원[동]", translations: [] },
            { stopId: "e", sequence: 5, displayName: "비석거리(오희준로)", translations: [] },
          ],
        },
      ],
    );

    expect(match?.patternId).toBe("pattern-182-1");
    expect(match?.coverageRatio).toBe(1);
    expect(match?.matchedStops.every((stop) => stop.score === 100)).toBe(true);
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
          shortName: "202",
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
