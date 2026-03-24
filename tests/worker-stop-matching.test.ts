import { describe, expect, it } from "vitest";
import { buildStopNameKeys, scoreStopNameMatch } from "../worker/jobs/helpers";
import { parseScheduleTableRows } from "../worker/jobs/bus-jeju-parser";

describe("stop matching helpers", () => {
  it("matches common short aliases used in schedule tables", () => {
    expect(scoreStopNameMatch("공항", "제주국제공항2(일주동로, 516도로)")).toBeGreaterThanOrEqual(70);
    expect(scoreStopNameMatch("봉개", "봉개환승정류장")).toBeGreaterThanOrEqual(70);
    expect(buildStopNameKeys("성산포항")).toContain("성산항");
  });

  it("drops note and route-label columns from timetable headers", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "제주터미널" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "노선번호" },
      { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "비 고" },
      { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "202-3번 (서귀포버스터미널)" },
      { ROW_SEQ: 0, COLUMN_SEQ: 5, COLUMN_NM: "공항" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "06:00" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 5, COLUMN_NM: "06:20" },
    ]);

    expect(parsed.stopNames).toEqual(["제주터미널", "공항"]);
    expect(parsed.trips[0]?.times).toEqual(["06:00", "06:20"]);
  });
});
