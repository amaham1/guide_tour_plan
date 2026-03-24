import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  fetchJejuStation2Mock,
  fetchBusJejuLineCandidatesMock,
  fetchBusJejuLineInfoMock,
  fetchScheduleTableMock,
  fetchPlainTextMock,
} = vi.hoisted(() => ({
  fetchJejuStation2Mock: vi.fn(),
  fetchBusJejuLineCandidatesMock: vi.fn(),
  fetchBusJejuLineInfoMock: vi.fn(),
  fetchScheduleTableMock: vi.fn(),
  fetchPlainTextMock: vi.fn(),
}));

vi.mock("@/worker/jobs/jeju-openapi", () => ({
  fetchJejuStation2: fetchJejuStation2Mock,
}));

vi.mock("@/worker/jobs/bus-jeju-live", () => ({
  fetchBusJejuLineCandidates: fetchBusJejuLineCandidatesMock,
  fetchBusJejuLineInfo: fetchBusJejuLineInfoMock,
}));

vi.mock("@/worker/jobs/schedule-table", () => ({
  fetchScheduleTable: fetchScheduleTableMock,
}));

vi.mock("@/worker/core/fetch", () => ({
  fetchPlainText: fetchPlainTextMock,
}));

import { runRoutePatternsOpenApiJob } from "../worker/jobs/route-patterns-openapi";
import { runRoutesHtmlJob } from "../worker/jobs/routes-html";
import { runStopsJob } from "../worker/jobs/stops";
import { runTimetablesXlsxJob } from "../worker/jobs/timetables-xlsx";

describe("transit worker jobs", () => {
  beforeEach(() => {
    fetchJejuStation2Mock.mockReset();
    fetchBusJejuLineCandidatesMock.mockReset();
    fetchBusJejuLineInfoMock.mockReset();
    fetchScheduleTableMock.mockReset();
    fetchPlainTextMock.mockReset();
  });

  it("creates stop translations from Station2 data", async () => {
    fetchJejuStation2Mock.mockResolvedValue([
      {
        stationId: "406000817",
        stationNm: "성산일출봉입구(서)",
        stationNmEn: "Seongsan Ilchulbong Entrance West",
        stationNmCh: "城山日出峰入口(西)",
        stationNmJp: "城山日出峰入口(西)",
        localX: "126.9350",
        localY: "33.4580",
      },
    ]);

    const stopUpsert = vi.fn();
    const translationUpsert = vi.fn();
    const runtime = {
      env: {
        busStopsSourceUrl: "",
        jejuOpenApiBaseUrl: "http://example.test/api",
      },
      prisma: {
        stop: { upsert: stopUpsert },
        stopTranslation: { upsert: translationUpsert },
      },
    } as never;

    const outcome = await runStopsJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(stopUpsert).toHaveBeenCalledTimes(1);
    expect(translationUpsert).toHaveBeenCalledTimes(4);
    expect(translationUpsert.mock.calls[1][0].create).toMatchObject({
      language: "en",
      displayName: "Seongsan Ilchulbong Entrance West",
    });
  });

  it("builds authoritative route patterns from Bus and StationRoute data", async () => {
    fetchBusJejuLineCandidatesMock.mockResolvedValue([
      {
        routeId: "405320111",
        routeNm: "111-1",
        routeNum: "111",
        routeSubNm: "1",
        upDnDir: "2",
      },
    ]);
    fetchBusJejuLineInfoMock.mockResolvedValue({
      routeId: "405320111",
      routeNm: "111-1",
      routeNum: "111",
      routeSubNm: "1",
      upDnDir: "2",
      stationInfoList: [
        {
          stationId: "406000816",
          stationNm: "성산일출봉입구(동)",
          localX: "126.9345",
          localY: "33.4582",
          linkOrd: "1",
        },
        {
          stationId: "406000817",
          stationNm: "성산일출봉입구(서)",
          localX: "126.9350",
          localY: "33.4580",
          linkOrd: "2",
        },
      ],
    });

    const patternUpsert = vi.fn();
    const patternStopDeleteMany = vi.fn();
    const patternStopCreateMany = vi.fn();
    const patternDeleteMany = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
      },
      prisma: {
        route: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "route-111",
              shortName: "111",
            },
          ]),
        },
        stop: {
          findMany: vi.fn().mockResolvedValue([{ id: "406000816" }, { id: "406000817" }]),
        },
        routePattern: {
          upsert: patternUpsert,
          deleteMany: patternDeleteMany,
        },
        routePatternStop: {
          deleteMany: patternStopDeleteMany,
          createMany: patternStopCreateMany,
        },
      },
    } as never;

    const outcome = await runRoutePatternsOpenApiJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(patternUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          externalRouteId: "405320111",
          directionCode: "2",
          waypointOrder: 0,
        }),
      }),
    );
    expect(patternStopCreateMany).toHaveBeenCalledWith({
      data: [
        {
          routePatternId: "pattern-openapi-405320111-2-0",
          stopId: "406000816",
          sequence: 1,
          distanceFromStart: 0,
        },
        {
          routePatternId: "pattern-openapi-405320111-2-0",
          stopId: "406000817",
          sequence: 2,
          distanceFromStart: 1000,
        },
      ],
    });
    expect(patternDeleteMany).toHaveBeenCalled();
  });

  it("creates multiple schedule sources from a single multi-variant page", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2301")) {
        return `
          <table>
            <tr><td class="route-num">211번/212번</td></tr>
            <tr><td class="rotue-via">[211번] Seongsan Port-Goseong-Bus Terminal [212번] Seongsan Port-Gyorae-Bus Terminal</td></tr>
            <tr><td class="route-waypoint">Seongsan Port -> Bus Terminal</td></tr>
            <tr><td class="route-desc">[211번] every 60 min [212번] every 70 min</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2301">211번/212번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Seongsan Port" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Midpoint" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Bus Terminal" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "211번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:20" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "06:40" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "212번" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "06:10" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "06:35" },
        { ROW_SEQ: 2, COLUMN_SEQ: 4, COLUMN_NM: "06:55" },
      ],
    });

    const upsert = vi.fn();
    const updatePattern = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        routeSearchTerms: [],
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-211",
              displayName: "211 Seongsan Port Bus Terminal",
              directionLabel: "Seongsan Port -> Bus Terminal",
              route: { shortName: "211" },
              stops: [
                {
                  sequence: 1,
                  stop: { id: "s1", displayName: "Seongsan Port", translations: [] },
                },
                {
                  sequence: 2,
                  stop: { id: "s2", displayName: "Midpoint", translations: [] },
                },
                {
                  sequence: 3,
                  stop: { id: "s3", displayName: "Bus Terminal", translations: [] },
                },
              ],
            },
            {
              id: "pattern-212",
              displayName: "212 Seongsan Port Bus Terminal",
              directionLabel: "Seongsan Port -> Bus Terminal",
              route: { shortName: "212" },
              stops: [
                {
                  sequence: 1,
                  stop: { id: "s1", displayName: "Seongsan Port", translations: [] },
                },
                {
                  sequence: 2,
                  stop: { id: "s4", displayName: "Gyorae", translations: [] },
                },
                {
                  sequence: 3,
                  stop: { id: "s3", displayName: "Bus Terminal", translations: [] },
                },
              ],
            },
          ]),
          update: updatePattern,
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2301",
          variantKey: "211",
          routePatternId: "pattern-211",
        }),
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2301",
          variantKey: "212",
          routePatternId: "pattern-212",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(2);
  });

  it("expands only the selected variant rows onto the authoritative stop sequence", async () => {
    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Transfer" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "211번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "212번" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "06:30" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "06:42" },
        { ROW_SEQ: 2, COLUMN_SEQ: 4, COLUMN_NM: "06:55" },
      ],
    });

    const tripCreate = vi.fn().mockImplementation(async ({ data }) => ({ id: data.id }));
    const stopTimeCreateMany = vi.fn();
    const runtime = {
      prisma: {
        serviceCalendar: {
          upsert: vi.fn(),
        },
        routePatternScheduleSource: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "schedule-source-1",
              scheduleId: "2301",
              variantKey: "212",
              routePatternId: "pattern-212",
              isActive: true,
              routePattern: {
                id: "pattern-212",
                directionLabel: "Origin -> Destination",
                displayName: "212 Origin Destination",
                waypointText: "Origin -> Destination",
                viaText: "Origin-Transfer-Destination",
                route: {
                  id: "route-212",
                  shortName: "212",
                  displayName: "212",
                  isActive: true,
                  createdAt: new Date(),
                },
                stops: [
                  {
                    sequence: 1,
                    stop: {
                      id: "stop-a",
                      displayName: "Origin",
                      translations: [],
                    },
                  },
                  {
                    sequence: 2,
                    stop: {
                      id: "stop-b",
                      displayName: "Transfer",
                      translations: [],
                    },
                  },
                  {
                    sequence: 3,
                    stop: {
                      id: "stop-c",
                      displayName: "Destination",
                      translations: [],
                    },
                  },
                ],
              },
            },
          ]),
        },
        trip: {
          deleteMany: vi.fn(),
          create: tripCreate,
        },
        stopTime: {
          createMany: stopTimeCreateMany,
        },
      },
      env: {},
    } as never;

    const outcome = await runTimetablesXlsxJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(tripCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduleSourceId: "schedule-source-1",
          rowLabel: "212번",
        }),
      }),
    );
    expect(stopTimeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stopId: "stop-a",
          arrivalMinutes: 390,
          isEstimated: false,
        }),
        expect.objectContaining({
          stopId: "stop-b",
          arrivalMinutes: 402,
          isEstimated: false,
        }),
        expect.objectContaining({
          stopId: "stop-c",
          arrivalMinutes: 415,
          isEstimated: false,
        }),
      ],
    });
  });
});
