import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
  parseRouteDetailHtml,
  parseRouteSearchHtml,
  parseScheduleTableRows,
} from "../worker/jobs/bus-jeju-parser";
import { parseStopTranslationsWorkbook } from "../worker/jobs/stop-translations";

describe("bus jeju parser", () => {
  it("extracts schedule ids from search html", () => {
    const html = `
      <div>
        <a href="/mobile/schedule/detailSchedule?scheduleId=1975">111번 공항 → 성산항</a>
        <a href="/mobile/schedule/detailSchedule?scheduleId=2050">202번 공항 → 한림</a>
      </div>
    `;

    expect(parseRouteSearchHtml(html)).toEqual([
      {
        scheduleId: "1975",
        shortName: "111",
        label: "111번 공항 → 성산항",
      },
      {
        scheduleId: "2050",
        shortName: "202",
        label: "202번 공항 → 한림",
      },
    ]);
  });

  it("parses route detail header metadata", () => {
    const html = `
      <html>
        <body>
          <table>
            <tr><td class="route-num">111번</td></tr>
            <tr><td class="rotue-via">공항-제주시청-성산항</td></tr>
            <tr><td class="route-waypoint">공항 → 성산항</td></tr>
            <tr><td class="route-desc">첫차 06:10, 막차 21:30</td></tr>
            <tr><td class="route-desc">(시행일 : 2025. 2. 21.)</td></tr>
          </table>
          <script>switch(3)</script>
        </body>
      </html>
    `;

    const parsed = parseRouteDetailHtml(html, "1975");

    expect(parsed.shortName).toBe("111");
    expect(parsed.busType).toBe(3);
    expect(parsed.directionLabel).toBe("공항 → 성산항");
    expect(parsed.serviceNote).toContain("첫차");
    expect(parsed.effectiveDate?.getFullYear()).toBe(2025);
    expect(parsed.effectiveDate?.getMonth()).toBe(1);
    expect(parsed.effectiveDate?.getDate()).toBe(21);
  });

  it("interpolates missing timetable cells and marks them estimated", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "공항" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "제주시청" },
      { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "성산항" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "06:00" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:10" },
      { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:30" },
      { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "X" },
      { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:10" },
      { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "07:30" },
    ]);

    expect(parsed.stopNames).toEqual(["공항", "제주시청", "성산항"]);
    expect(parsed.trips[1]?.times).toEqual(["07:00", "07:10", "07:30"]);
    expect(parsed.trips[1]?.estimatedColumns).toContain(0);
  });

  it("drops blank header columns and parses embedded departure labels", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "Terminal" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "" },
      { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Beach" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "5:50(depart)" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "" },
      { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
    ]);

    expect(parsed.stopNames).toEqual(["Terminal", "Beach"]);
    expect(parsed.trips[0]?.times).toEqual(["05:50", "06:10"]);
  });
});

describe("stop translation parser", () => {
  it("reads translations from workbook rows", () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.json_to_sheet([
      {
        stopId: "stop-airport",
        language: "en",
        displayName: "Jeju Airport",
      },
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");

    expect(parseStopTranslationsWorkbook(workbook)).toEqual([
      {
        stopKey: "stopairport",
        language: "en",
        displayName: "Jeju Airport",
      },
    ]);
  });
});
