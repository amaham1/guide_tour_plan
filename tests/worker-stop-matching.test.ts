import { describe, expect, it } from "vitest";
import { buildStopNameKeys, scoreStopNameMatch } from "../worker/jobs/helpers";
import { parseScheduleTableRows } from "../worker/jobs/bus-jeju-parser";

describe("stop matching helpers", () => {
  it("matches common aliases used in schedule tables", () => {
    expect(scoreStopNameMatch("제주버스터미널", "제주터미널")).toBe(100);
    expect(scoreStopNameMatch("성산포항", "성산항")).toBe(100);
    expect(scoreStopNameMatch("중앙R", "중앙로터리")).toBe(100);
  });

  it("drops note and route-label columns from timetable headers", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "Terminal" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "노선번호" },
      { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "비고" },
      { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "202-3번(Express)" },
      { ROW_SEQ: 0, COLUMN_SEQ: 5, COLUMN_NM: "Airport" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "06:00" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 5, COLUMN_NM: "06:20" },
    ]);

    expect(parsed.stopNames).toEqual(["Terminal", "Airport"]);
    expect(parsed.variants[0]?.trips[0]?.times).toEqual(["06:00", "06:20"]);
  });
});
