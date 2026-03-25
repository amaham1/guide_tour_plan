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
          findMany: vi.fn().mockResolvedValue([
            { id: "406000816", displayName: "성산일출봉입구(동)", translations: [] },
            { id: "406000817", displayName: "성산일출봉입구(서)", translations: [] },
          ]),
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

  it("preserves terminal stops when live pattern sequences collapse multiple stops", async () => {
    fetchBusJejuLineCandidatesMock.mockResolvedValue([
      {
        routeId: "405320204",
        routeNm: "202-4",
        routeNum: "202-4",
        routeSubNm: "한담동",
        upDnDir: "0",
      },
    ]);
    fetchBusJejuLineInfoMock.mockResolvedValue({
      routeId: "405320204",
      routeNm: "202-4",
      routeNum: "202-4",
      routeSubNm: "한담동",
      upDnDir: null,
      orgtNm: "제주버스터미널(가상정류소)",
      dstNm: "한담동",
      busTypeStr: "1",
      stationInfoList: [
        {
          stationId: "405000175",
          stationNm: "동산교",
          localX: "126.5000",
          localY: "33.5000",
          linkOrd: "4",
        },
        {
          stationId: "405000097",
          stationNm: "제주민속오일장[북]",
          localX: "126.5100",
          localY: "33.5100",
          linkOrd: "18",
        },
        {
          stationId: "405001198",
          stationNm: "애월중학교",
          localX: "126.5200",
          localY: "33.5200",
          linkOrd: "66",
        },
        {
          stationId: "405002077",
          stationNm: "애월환승정류장(애월리)",
          localX: "126.5300",
          localY: "33.5300",
          linkOrd: "69",
        },
        {
          stationId: "405001204",
          stationNm: "한담동[서]",
          localX: "126.5310",
          localY: "33.5310",
          linkOrd: "69",
        },
      ],
    });

    const patternStopCreateMany = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
      },
      prisma: {
        route: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "route-202-4",
              shortName: "202-4",
            },
          ]),
        },
        stop: {
          findMany: vi.fn().mockResolvedValue([
            { id: "stop-terminal", displayName: "제주버스터미널(종점)", translations: [] },
            { id: "405000175", displayName: "동산교", translations: [] },
            { id: "405000097", displayName: "제주민속오일장[북]", translations: [] },
            { id: "405001198", displayName: "애월중학교", translations: [] },
            { id: "405002077", displayName: "애월환승정류장(애월리)", translations: [] },
            { id: "405001204", displayName: "한담동[서]", translations: [] },
          ]),
        },
        routePattern: {
          upsert: vi.fn(),
          deleteMany: vi.fn(),
        },
        routePatternStop: {
          deleteMany: vi.fn(),
          createMany: patternStopCreateMany,
        },
      },
    } as never;

    const outcome = await runRoutePatternsOpenApiJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(patternStopCreateMany).toHaveBeenCalledWith({
      data: [
        {
          routePatternId: "pattern-openapi-405320204-0-0",
          stopId: "stop-terminal",
          sequence: 3,
          distanceFromStart: 0,
        },
        {
          routePatternId: "pattern-openapi-405320204-0-0",
          stopId: "405000175",
          sequence: 4,
          distanceFromStart: 1000,
        },
        {
          routePatternId: "pattern-openapi-405320204-0-0",
          stopId: "405000097",
          sequence: 18,
          distanceFromStart: 2000,
        },
        {
          routePatternId: "pattern-openapi-405320204-0-0",
          stopId: "405001198",
          sequence: 66,
          distanceFromStart: 3000,
        },
        {
          routePatternId: "pattern-openapi-405320204-0-0",
          stopId: "405001204",
          sequence: 69,
          distanceFromStart: 4000,
        },
      ],
    });
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

  it("does not skip ordinary routes whose via text mentions village stop names", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2401")) {
        return `
          <table>
            <tr><td class="route-num">355번</td></tr>
            <tr><td class="rotue-via">연동입구-남서광마을-대동마을-제주대학교병원</td></tr>
            <tr><td class="route-waypoint">연동입구 -> 제주대학교병원</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2401">355번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "연동입구" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "제주대학교병원" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "18:13" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "18:39" },
      ],
    });

    const updateMany = vi.fn();
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
              id: "pattern-355",
              displayName: "355 연동입구 제주대학교병원",
              directionLabel: "연동입구 -> 제주대학교병원",
              route: { shortName: "355" },
              stops: [
                {
                  sequence: 1,
                  stop: { id: "s1", displayName: "연동입구", translations: [] },
                },
                {
                  sequence: 2,
                  stop: { id: "s2", displayName: "제주대학교병원", translations: [] },
                },
              ],
            },
          ]),
          update: updatePattern,
        },
        routePatternScheduleSource: {
          updateMany,
          upsert,
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(outcome.meta).toMatchObject({
      skippedSpecialSchedules: [],
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2401",
          routePatternId: "pattern-355",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(1);
  });

  it("deactivates stale schedule sources when a schedule is skipped as special", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2402")) {
        return `
          <table>
            <tr><td class="route-num">우도급행</td></tr>
            <tr><td class="route-waypoint">Terminal -> Udo</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2402">우도급행</a>`;
    });

    const updateMany = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        routeSearchTerms: [],
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([]),
        },
        routePatternScheduleSource: {
          updateMany,
          upsert: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(0);
    expect(outcome.meta).toMatchObject({
      skippedSpecialSchedules: [
        {
          scheduleId: "2402",
          shortName: "우도급행",
          reason: "SPECIAL_ROUTE_EXCLUDED",
        },
      ],
    });
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        scheduleId: "2402",
      },
      data: {
        isActive: false,
      },
    });
    expect(fetchScheduleTableMock).not.toHaveBeenCalled();
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
