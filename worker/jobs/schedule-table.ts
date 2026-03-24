import * as XLSX from "xlsx";
import { loadWorkbook } from "@/worker/core/files";
import { fetchJson } from "@/worker/core/fetch";
import type { WorkerRuntime } from "@/worker/core/runtime";
import { normalizeText } from "@/worker/jobs/helpers";
import type { RawScheduleCell } from "@/worker/jobs/bus-jeju-parser";

type TimetableSheetRow = Record<string, unknown>;

export function parseTimetableWorkbook(workbook: XLSX.WorkBook) {
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  return XLSX.utils.sheet_to_json<TimetableSheetRow>(sheet, {
    defval: "",
  });
}

function buildRawRowsFromWorkbookRows(rows: TimetableSheetRow[]): RawScheduleCell[] {
  if (rows.length === 0) {
    return [];
  }

  const headers = Object.keys(rows[0]).filter((key) => key !== "rowLabel");
  const cells: RawScheduleCell[] = headers.map((header, index) => ({
    ROW_SEQ: 0,
    COLUMN_SEQ: index + 1,
    COLUMN_NM: normalizeText(header),
  }));

  rows.forEach((row, rowIndex) => {
    headers.forEach((header, columnIndex) => {
      cells.push({
        ROW_SEQ: rowIndex + 1,
        COLUMN_SEQ: columnIndex + 1,
        COLUMN_NM: normalizeText(row[header]) || null,
      });
    });
  });

  return cells;
}

export async function fetchScheduleTable(runtime: WorkerRuntime, scheduleId: string) {
  const source = runtime.env.routeTimetableBaseUrl;

  if (source && /\.(xlsx|xls)$/i.test(source)) {
    const workbook = await loadWorkbook(source);
    return {
      rows: buildRawRowsFromWorkbookRows(parseTimetableWorkbook(workbook)),
      source,
    };
  }

  const rows = await fetchJson<RawScheduleCell[]>(
    `${runtime.env.busJejuBaseUrl}/data/schedule/getScheduleTableInfo`,
    undefined,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
      },
      body: new URLSearchParams({
        scheduleId,
      }),
    },
  );

  return {
    rows,
    source: source || "bus-jeju-json",
  };
}
