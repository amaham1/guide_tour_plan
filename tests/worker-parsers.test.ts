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
        <a href="/mobile/schedule/detailSchedule?scheduleId=1975">111 Airport Seongsan</a>
        <a href="/mobile/schedule/detailSchedule?scheduleId=2050">202 Airport Hallim</a>
        <a href="/mobile/schedule/detailSchedule?scheduleId=2051">500-2 Seongsan Jeju</a>
      </div>
    `;

    expect(parseRouteSearchHtml(html)).toEqual([
      {
        scheduleId: "1975",
        shortName: "111",
        label: "111 Airport Seongsan",
      },
      {
        scheduleId: "2050",
        shortName: "202",
        label: "202 Airport Hallim",
      },
      {
        scheduleId: "2051",
        shortName: "500-2",
        label: "500-2 Seongsan Jeju",
      },
    ]);
  });

  it("parses route detail header metadata and per-variant hints", () => {
    const html = `
      <html>
        <body>
          <table>
            <tr><td class="route-num">121번/122번</td></tr>
            <tr>
              <td class="rotue-via">
                [121번] Airport-Terminal-Folk Village
                [122번] Airport-City Hall-Hospital-Folk Village
              </td>
            </tr>
            <tr><td class="route-waypoint">Airport -> Folk Village</td></tr>
            <tr><td class="route-desc">[121번] first 05:05 [122번] first 09:10</td></tr>
            <tr><td class="route-desc">(시행일 : 2025. 8. 1.)</td></tr>
          </table>
          <script>switch(1)</script>
        </body>
      </html>
    `;

    const parsed = parseRouteDetailHtml(html, "2151");

    expect(parsed.shortName).toBe("121번/122번");
    expect(parsed.busType).toBe(1);
    expect(parsed.directionLabel).toBe("Airport -> Folk Village");
    expect(parsed.terminalHint).toEqual({
      origin: "Airport",
      destination: "Folk Village",
    });
    expect(parsed.variants).toEqual([
      expect.objectContaining({
        variantKey: "121",
        viaStops: ["Airport", "Terminal", "Folk Village"],
      }),
      expect.objectContaining({
        variantKey: "122",
        viaStops: ["Airport", "City Hall", "Hospital", "Folk Village"],
      }),
    ]);
    expect(parsed.effectiveDate?.getFullYear()).toBe(2025);
    expect(parsed.effectiveDate?.getMonth()).toBe(7);
    expect(parsed.effectiveDate?.getDate()).toBe(1);
  });

  it("groups timetable rows by route variant and keeps raw labels", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Airport" },
      { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Terminal" },
      { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Village" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "121번" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
      { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
      { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "06:30" },
      { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "122번" },
      { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
      { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "X" },
      { ROW_SEQ: 2, COLUMN_SEQ: 4, COLUMN_NM: "07:35" },
    ]);

    expect(parsed.stopNames).toEqual(["Airport", "Terminal", "Village"]);
    expect(parsed.variants).toHaveLength(2);
    expect(parsed.variants[0]).toMatchObject({
      variantKey: "121",
      trips: [
        {
          rowLabel: "121번",
          rowSequence: 1,
          rawValues: ["06:00", "06:10", "06:30"],
          times: ["06:00", "06:10", "06:30"],
        },
      ],
    });
    expect(parsed.variants[1]?.trips[0]?.times).toEqual(["07:00", "07:12", "07:35"]);
    expect(parsed.variants[1]?.trips[0]?.estimatedColumns).toContain(1);
  });

  it("falls back to a default variant when there is no route label column", () => {
    const parsed = parseScheduleTableRows([
      { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "Terminal" },
      { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Beach" },
      { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "05:50 (depart)" },
      { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:10" },
    ]);

    expect(parsed.stopNames).toEqual(["Terminal", "Beach"]);
    expect(parsed.variants).toEqual([
      {
        variantKey: "default",
        rawVariantLabel: "default",
        trips: [
          {
            rowLabel: "default",
            rowSequence: 1,
            variantKey: "default",
            rawVariantLabel: "default",
            rawValues: ["05:50 (depart)", "06:10"],
            times: ["05:50", "06:10"],
            estimatedColumns: [],
          },
        ],
      },
    ]);
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
