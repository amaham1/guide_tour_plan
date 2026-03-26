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
        stationNm: "?깆궛?쇱텧遊됱엯援???",
        stationNmEn: "Seongsan Ilchulbong Entrance West",
        stationNmCh: "?롥굇?ε눣約겼뀯??蜈?",
        stationNmJp: "?롥굇?ε눣約겼뀯??蜈?",
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
          stationNm: "?깆궛?쇱텧遊됱엯援???",
          localX: "126.9345",
          localY: "33.4582",
          linkOrd: "1",
        },
        {
          stationId: "406000817",
          stationNm: "?깆궛?쇱텧遊됱엯援???",
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
            { id: "406000816", displayName: "?깆궛?쇱텧遊됱엯援???", translations: [] },
            { id: "406000817", displayName: "?깆궛?쇱텧遊됱엯援???", translations: [] },
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
        routeSubNm: "Terminal",
        upDnDir: "0",
      },
    ]);
    fetchBusJejuLineInfoMock.mockResolvedValue({
      routeId: "405320204",
      routeNm: "202-4",
      routeNum: "202-4",
      routeSubNm: "Terminal",
      upDnDir: null,
      orgtNm: "Terminal",
      dstNm: "Terminal",
      busTypeStr: "1",
      stationInfoList: [
        {
          stationId: "405000175",
          stationNm: "Dongsan-gu",
          localX: "126.5000",
          localY: "33.5000",
          linkOrd: "4",
        },
        {
          stationId: "405000097",
          stationNm: "?쒖＜誘쇱냽?ㅼ씪??遺?",
          localX: "126.5100",
          localY: "33.5100",
          linkOrd: "18",
        },
        {
          stationId: "405001198",
          stationNm: "Jungang School",
          localX: "126.5200",
          localY: "33.5200",
          linkOrd: "66",
        },
        {
          stationId: "405002077",
          stationNm: "?좎썡?섏듅?뺣쪟???좎썡由?",
          localX: "126.5300",
          localY: "33.5300",
          linkOrd: "69",
        },
        {
          stationId: "405001204",
          stationNm: "?쒕떞????",
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
            { id: "stop-terminal", displayName: "Terminal", translations: [] },
            { id: "405000175", displayName: "Dongsan-gu", translations: [] },
            { id: "405000097", displayName: "?쒖＜誘쇱냽?ㅼ씪??遺?", translations: [] },
            { id: "405001198", displayName: "Jungang School", translations: [] },
            { id: "405002077", displayName: "?좎썡?섏듅?뺣쪟???좎썡由?", translations: [] },
            { id: "405001204", displayName: "?쒕떞????", translations: [] },
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

  it("keeps only fully authoritative schedule sources from a multi-variant page", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2301")) {
        return `
          <table>
            <tr><td class="route-num">211번 212번</td></tr>
            <tr><td class="rotue-via">[211번] Seongsan Port-Goseong-Bus Terminal [212번] Seongsan Port-Gyorae-Bus Terminal</td></tr>
            <tr><td class="route-waypoint">Seongsan Port -> Bus Terminal</td></tr>
            <tr><td class="route-desc">[211번] every 60 min [212번] every 70 min</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2301">211번 212번</a>`;
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
    const tripDeleteMany = vi.fn();
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
        trip: {
          deleteMany: tripDeleteMany,
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2301",
          variantKey: "211",
          routePatternId: "pattern-211",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(1);
    expect(outcome.meta).toMatchObject({
      unmatchedVariants: [
        expect.objectContaining({
          scheduleId: "2301",
          variantKey: "212",
          reason: "NON_AUTHORITATIVE_PATTERN_MATCH",
        }),
      ],
    });
  });

  it("does not skip ordinary routes whose via text mentions village stop names", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2401")) {
        return `
          <table>
            <tr><td class="route-num">355번</td></tr>
            <tr><td class="rotue-via">?곕룞?낃뎄-?⑥꽌愿묐쭏????숇쭏???쒖＜??숆탳蹂묒썝</td></tr>
            <tr><td class="route-waypoint">?곕룞?낃뎄 -> ?쒖＜??숆탳蹂묒썝</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2401">355踰?/a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "?곕룞?낃뎄" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "?쒖＜??숆탳蹂묒썝" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "18:13" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "18:39" },
      ],
    });

    const updateMany = vi.fn();
    const upsert = vi.fn();
    const updatePattern = vi.fn();
    const tripDeleteMany = vi.fn();
    const derivedTripDeleteMany = vi.fn();
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
              displayName: "355 ?곕룞?낃뎄 ?쒖＜??숆탳蹂묒썝",
              directionLabel: "?곕룞?낃뎄 -> ?쒖＜??숆탳蹂묒썝",
              route: { shortName: "355" },
              stops: [
                {
                  sequence: 1,
                  stop: { id: "s1", displayName: "?곕룞?낃뎄", translations: [] },
                },
                {
                  sequence: 2,
                  stop: { id: "s2", displayName: "?쒖＜??숆탳蹂묒썝", translations: [] },
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
        trip: {
          deleteMany: tripDeleteMany,
        },
        derivedTrip: {
          deleteMany: derivedTripDeleteMany,
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

  it("keeps mixed variant schedules when blank route labels inherit the previous variant", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2450")) {
        return `
          <table>
            <tr><td class="route-num">211번 212번</td></tr>
            <tr><td class="route-waypoint">Origin -> Destination</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2450">211번 212번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "211번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "07:20" },
        { ROW_SEQ: 3, COLUMN_SEQ: 1, COLUMN_NM: "212번" },
        { ROW_SEQ: 3, COLUMN_SEQ: 2, COLUMN_NM: "08:00" },
        { ROW_SEQ: 3, COLUMN_SEQ: 3, COLUMN_NM: "08:20" },
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
              displayName: "211 Origin Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "211" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "Destination", translations: [] } },
              ],
            },
            {
              id: "pattern-212",
              displayName: "212 Origin Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "212" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "Destination", translations: [] } },
              ],
            },
          ]),
          update: updatePattern,
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(2);
    expect(outcome.failureCount).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(outcome.meta).toMatchObject({
      resolvedMixedVariantSchedules: [
        {
          scheduleId: "2450",
          inheritedVariantRowCount: 1,
        },
      ],
      unresolvedMixedVariantSchedules: [],
    });
    expect(updatePattern).toHaveBeenCalledTimes(2);
  });

  it("keeps unstable mixed variant schedules skipped when leading blank rows remain unresolved", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2451")) {
        return `
          <table>
            <tr><td class="route-num">211번 212번</td></tr>
            <tr><td class="route-waypoint">Origin -> Destination</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2451">211번 212번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "211번" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "07:20" },
      ],
    });

    const upsert = vi.fn();
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
              displayName: "211 Origin Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "211" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "Destination", translations: [] } },
              ],
            },
          ]),
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(0);
    expect(outcome.failureCount).toBe(0);
    expect(upsert).not.toHaveBeenCalled();
    expect(outcome.meta).toMatchObject({
      skippedSpecialSchedules: [
        {
          scheduleId: "2451",
          reason: "UNSTABLE_VARIANT_KEY",
        },
      ],
      unresolvedMixedVariantSchedules: [
        {
          scheduleId: "2451",
          unresolvedVariantRowCount: 1,
        },
      ],
    });
  });

  it("keeps schedule sources that are an exact stop subset of the matched pattern", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2403")) {
        return `
          <table>
            <tr><td class="route-num">212번</td></tr>
            <tr><td class="route-waypoint">Origin -> Destination</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2403">212번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "212번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:30" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:55" },
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
              id: "pattern-212",
              displayName: "212 Origin Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "212" },
              stops: [
                {
                  sequence: 1,
                  stop: { id: "s1", displayName: "Origin", translations: [] },
                },
                {
                  sequence: 2,
                  stop: { id: "s2", displayName: "Transfer", translations: [] },
                },
                {
                  sequence: 3,
                  stop: { id: "s3", displayName: "Destination", translations: [] },
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
        trip: {
          deleteMany: vi.fn(),
        },
        derivedTrip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2403",
          variantKey: "212",
          routePatternId: "pattern-212",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(1);
  });

  it("accepts authoritative schedule headers that use common stop abbreviations", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=1889")) {
        return `
          <table>
            <tr><td class="route-num">102번</td></tr>
            <tr><td class="route-waypoint">고산 -> 제주터미널</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=1889">102번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "고산" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "공항" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "제주터미널" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "07:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "07:30" },
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
              id: "pattern-102",
              displayName: "102 고산 제주터미널",
              directionLabel: "고산 -> 제주터미널",
              route: { shortName: "102" },
              stops: [
                {
                  sequence: 1,
                  stop: {
                    id: "s1",
                    displayName: "고산환승정류장(고산1리 고산성당 앞)[동]",
                    translations: [],
                  },
                },
                {
                  sequence: 2,
                  stop: {
                    id: "s2",
                    displayName: "제주국제공항(하차전용)",
                    translations: [],
                  },
                },
                {
                  sequence: 3,
                  stop: {
                    id: "s3",
                    displayName: "제주버스터미널(종점)",
                    translations: [],
                  },
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
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "1889",
          routePatternId: "pattern-102",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(1);
  });

  it("creates separate schedule sources when one variant mixes branch-specific stop columns", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2500")) {
        return `
          <table>
            <tr><td class="route-num">102번</td></tr>
            <tr><td class="route-waypoint">Origin -> Destination</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2500">102번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Branch A" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Branch B" },
        { ROW_SEQ: 0, COLUMN_SEQ: 5, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: null },
        { ROW_SEQ: 1, COLUMN_SEQ: 5, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: null },
        { ROW_SEQ: 2, COLUMN_SEQ: 4, COLUMN_NM: "07:12" },
        { ROW_SEQ: 2, COLUMN_SEQ: 5, COLUMN_NM: "07:25" },
        { ROW_SEQ: 3, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 3, COLUMN_SEQ: 2, COLUMN_NM: "08:00" },
        { ROW_SEQ: 3, COLUMN_SEQ: 3, COLUMN_NM: null },
        { ROW_SEQ: 3, COLUMN_SEQ: 4, COLUMN_NM: null },
        { ROW_SEQ: 3, COLUMN_SEQ: 5, COLUMN_NM: "08:20" },
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
              id: "pattern-a",
              displayName: "102 Origin Branch A Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "102" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "Branch A", translations: [] } },
                { sequence: 3, stop: { id: "s3", displayName: "Destination", translations: [] } },
              ],
            },
            {
              id: "pattern-b",
              displayName: "102 Origin Branch B Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "102" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s4", displayName: "Branch B", translations: [] } },
                { sequence: 3, stop: { id: "s3", displayName: "Destination", translations: [] } },
              ],
            },
          ]),
          update: updatePattern,
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(2);
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2500",
          routePatternId: "pattern-a",
        }),
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        create: expect.objectContaining({
          scheduleId: "2500",
          routePatternId: "pattern-b",
        }),
      }),
    );
    expect(updatePattern).toHaveBeenCalledTimes(2);
  });

  it("accepts loop profiles when first and last timepoints use the same stop name", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2700")) {
        return `
          <table>
            <tr><td class="route-num">794-1번</td></tr>
            <tr><td class="route-waypoint">애월 -> 애월</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2700">794-1번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "애월" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "봉성" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "애월" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "794-1번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:20" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "06:40" },
      ],
    });

    const upsert = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        routeSearchTerms: [],
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-794-1",
              displayName: "794-1 애월 순환",
              directionLabel: "애월 -> 애월",
              route: { shortName: "794-1" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "애월환승정류장", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "봉성리", translations: [] } },
                { sequence: 3, stop: { id: "s3", displayName: "애월환승정류장", translations: [] } },
              ],
            },
          ]),
          update: vi.fn(),
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(outcome.failureCount).toBe(0);
    expect(upsert).toHaveBeenCalledTimes(1);
  });

  it("records near-miss diagnostics for unmatched schedule families", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2600")) {
        return `
          <table>
            <tr><td class="route-num">131번</td></tr>
            <tr><td class="route-waypoint">Origin -> Destination</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2600">131번</a>`;
    });

    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Midpoint Alias" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "131번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "06:20" },
      ],
    });

    const upsert = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        routeSearchTerms: [],
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-131",
              displayName: "131 Origin Destination",
              directionLabel: "Origin -> Destination",
              route: { shortName: "131" },
              stops: [
                { sequence: 1, stop: { id: "s1", displayName: "Origin", translations: [] } },
                { sequence: 2, stop: { id: "s2", displayName: "Midpoint Official", translations: [] } },
                { sequence: 3, stop: { id: "s3", displayName: "Destination", translations: [] } },
              ],
            },
          ]),
          update: vi.fn(),
        },
        routePatternScheduleSource: {
          updateMany: vi.fn(),
          upsert,
        },
        trip: {
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRoutesHtmlJob(runtime);

    expect(outcome.successCount).toBe(0);
    expect(outcome.failureCount).toBe(1);
    expect(upsert).not.toHaveBeenCalled();
    expect(outcome.meta).toMatchObject({
      unmatchedRouteLabels: [
        {
          shortName: "131",
          count: 1,
          reasons: [
            {
              reason: "NON_AUTHORITATIVE_PATTERN_MATCH",
              count: 1,
            },
          ],
        },
      ],
      nearMisses: [
        {
          scheduleId: "2600",
          variantKey: "131",
          shortName: "131",
          tripCount: 1,
          bestCandidate: {
            routePatternId: "pattern-131",
            shortName: "131",
            matchedStopCount: 2,
          },
        },
      ],
    });
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
    const tripDeleteMany = vi.fn();
    const derivedTripDeleteMany = vi.fn();
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
        trip: {
          deleteMany: tripDeleteMany,
        },
        derivedTrip: {
          deleteMany: derivedTripDeleteMany,
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
    expect(tripDeleteMany).toHaveBeenCalledWith({
      where: {
        scheduleSource: {
          is: {
            scheduleId: "2402",
          },
        },
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
    const derivedTripDeleteMany = vi.fn();
    const derivedStopTimeCreateMany = vi.fn();
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
                stopProjections: [],
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
        derivedTrip: {
          deleteMany: derivedTripDeleteMany,
          create: vi.fn(),
        },
        stopTime: {
          createMany: stopTimeCreateMany,
        },
        derivedStopTime: {
          createMany: derivedStopTimeCreateMany,
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
    expect(derivedStopTimeCreateMany).not.toHaveBeenCalled();
  });

  it("reuses inherited variant rows when expanding timetable sources", async () => {
    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "211번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: "07:20" },
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
              id: "schedule-source-inherited",
              scheduleId: "2450",
              variantKey: "211",
              routePatternId: "pattern-211",
              isActive: true,
              routePattern: {
                id: "pattern-211",
                directionLabel: "Origin -> Destination",
                displayName: "211 Origin Destination",
                waypointText: "Origin -> Destination",
                viaText: "Origin-Destination",
                route: {
                  id: "route-211",
                  shortName: "211",
                  displayName: "211",
                  isActive: true,
                  createdAt: new Date(),
                },
                stopProjections: [],
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
        derivedTrip: {
          deleteMany: vi.fn(),
          create: vi.fn(),
        },
        stopTime: {
          createMany: stopTimeCreateMany,
        },
        derivedStopTime: {
          createMany: vi.fn(),
        },
      },
      env: {},
    } as never;

    const outcome = await runTimetablesXlsxJob(runtime);

    expect(outcome.successCount).toBe(2);
    expect(outcome.failureCount).toBe(0);
    expect(tripCreate).toHaveBeenCalledTimes(2);
    expect(stopTimeCreateMany).toHaveBeenCalledTimes(2);
    expect(outcome.meta).toMatchObject({
      unmatchedSources: [],
    });
  });

  it("stores anchor-bounded derived stop times when the official table skips intermediate stops", async () => {
    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "212번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:30" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:55" },
      ],
    });

    const tripCreate = vi.fn().mockImplementation(async ({ data }) => ({ id: data.id }));
    const stopTimeCreateMany = vi.fn();
    const derivedStopTimeCreateMany = vi.fn();
    const runtime = {
      prisma: {
        serviceCalendar: {
          upsert: vi.fn(),
        },
        routePatternScheduleSource: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "schedule-source-2",
              scheduleId: "2302",
              variantKey: "default",
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
                stopProjections: [
                  {
                    sequence: 1,
                    offsetMeters: 0,
                    snapDistanceMeters: 20,
                    confidence: 0.92,
                  },
                  {
                    sequence: 2,
                    offsetMeters: 700,
                    snapDistanceMeters: 25,
                    confidence: 0.9,
                  },
                  {
                    sequence: 3,
                    offsetMeters: 2000,
                    snapDistanceMeters: 20,
                    confidence: 0.94,
                  },
                ],
                stops: [
                  {
                    sequence: 1,
                    distanceFromStart: 0,
                    stop: {
                      id: "stop-a",
                      displayName: "Origin",
                      translations: [],
                    },
                  },
                  {
                    sequence: 2,
                    distanceFromStart: 100,
                    stop: {
                      id: "stop-b",
                      displayName: "Transfer",
                      translations: [],
                    },
                  },
                  {
                    sequence: 3,
                    distanceFromStart: 200,
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
        derivedStopTime: {
          createMany: derivedStopTimeCreateMany,
        },
      },
      env: {},
    } as never;

    const outcome = await runTimetablesXlsxJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(tripCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scheduleSourceId: "schedule-source-2",
          rowLabel: "212번",
        }),
      }),
    );
    expect(stopTimeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stopId: "stop-a",
          arrivalMinutes: 390,
          timeSource: "OFFICIAL",
        }),
        expect.objectContaining({
          stopId: "stop-c",
          arrivalMinutes: 415,
          timeSource: "OFFICIAL",
        }),
      ],
    });
    expect(derivedStopTimeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stopId: "stop-b",
          arrivalMinutes: 399,
          timeSource: "OFFICIAL_ANCHOR_INTERPOLATED",
          anchorStartSequence: 1,
          anchorEndSequence: 3,
        }),
      ],
    });
    expect(outcome.meta).toMatchObject({
      trips: 1,
      derivedStopTimes: 1,
    });
  });

  it("loads sparse official rows even when the timetable header uses stop abbreviations", async () => {
    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "고산" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "공항" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "제주터미널" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "07:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: "07:30" },
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
              id: "schedule-source-3",
              scheduleId: "1889",
              variantKey: "default",
              routePatternId: "pattern-102",
              isActive: true,
              routePattern: {
                id: "pattern-102",
                directionLabel: "고산 -> 제주터미널",
                displayName: "102 고산 제주터미널",
                waypointText: "고산 -> 제주터미널",
                viaText: null,
                route: {
                  id: "route-102",
                  shortName: "102",
                  displayName: "102",
                  isActive: true,
                  createdAt: new Date(),
                },
                stopProjections: [],
                stops: [
                  {
                    sequence: 1,
                    distanceFromStart: 0,
                    stop: {
                      id: "stop-a",
                      displayName: "고산환승정류장(고산1리 고산성당 앞)[동]",
                      translations: [],
                    },
                  },
                  {
                    sequence: 2,
                    distanceFromStart: 1000,
                    stop: {
                      id: "stop-b",
                      displayName: "제주국제공항(하차전용)",
                      translations: [],
                    },
                  },
                  {
                    sequence: 3,
                    distanceFromStart: 2000,
                    stop: {
                      id: "stop-c",
                      displayName: "제주버스터미널(종점)",
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
        derivedStopTime: {
          createMany: vi.fn(),
        },
      },
      env: {},
    } as never;

    const outcome = await runTimetablesXlsxJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(stopTimeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          stopId: "stop-a",
          arrivalMinutes: 360,
          timeSource: "OFFICIAL",
        }),
        expect.objectContaining({
          stopId: "stop-b",
          arrivalMinutes: 430,
          timeSource: "OFFICIAL",
        }),
        expect.objectContaining({
          stopId: "stop-c",
          arrivalMinutes: 450,
          timeSource: "OFFICIAL",
        }),
      ],
    });
  });

  it("loads only the rows that match a source pattern when one variant mixes branches", async () => {
    fetchScheduleTableMock.mockResolvedValue({
      rows: [
        { ROW_SEQ: 0, COLUMN_SEQ: 1, COLUMN_NM: "노선번호" },
        { ROW_SEQ: 0, COLUMN_SEQ: 2, COLUMN_NM: "Origin" },
        { ROW_SEQ: 0, COLUMN_SEQ: 3, COLUMN_NM: "Branch A" },
        { ROW_SEQ: 0, COLUMN_SEQ: 4, COLUMN_NM: "Branch B" },
        { ROW_SEQ: 0, COLUMN_SEQ: 5, COLUMN_NM: "Destination" },
        { ROW_SEQ: 1, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 1, COLUMN_SEQ: 2, COLUMN_NM: "06:00" },
        { ROW_SEQ: 1, COLUMN_SEQ: 3, COLUMN_NM: "06:10" },
        { ROW_SEQ: 1, COLUMN_SEQ: 4, COLUMN_NM: null },
        { ROW_SEQ: 1, COLUMN_SEQ: 5, COLUMN_NM: "06:20" },
        { ROW_SEQ: 2, COLUMN_SEQ: 1, COLUMN_NM: "102번" },
        { ROW_SEQ: 2, COLUMN_SEQ: 2, COLUMN_NM: "07:00" },
        { ROW_SEQ: 2, COLUMN_SEQ: 3, COLUMN_NM: null },
        { ROW_SEQ: 2, COLUMN_SEQ: 4, COLUMN_NM: "07:12" },
        { ROW_SEQ: 2, COLUMN_SEQ: 5, COLUMN_NM: "07:25" },
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
              id: "schedule-source-branch-a",
              scheduleId: "2500",
              variantKey: "default",
              routePatternId: "pattern-a",
              isActive: true,
              routePattern: {
                id: "pattern-a",
                directionLabel: "Origin -> Destination",
                displayName: "102 Origin Branch A Destination",
                waypointText: "Origin -> Destination",
                viaText: null,
                route: {
                  id: "route-102",
                  shortName: "102",
                  displayName: "102",
                  isActive: true,
                  createdAt: new Date(),
                },
                stopProjections: [],
                stops: [
                  {
                    sequence: 1,
                    distanceFromStart: 0,
                    stop: {
                      id: "stop-a",
                      displayName: "Origin",
                      translations: [],
                    },
                  },
                  {
                    sequence: 2,
                    distanceFromStart: 1000,
                    stop: {
                      id: "stop-b",
                      displayName: "Branch A",
                      translations: [],
                    },
                  },
                  {
                    sequence: 3,
                    distanceFromStart: 2000,
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
        derivedStopTime: {
          createMany: vi.fn(),
        },
      },
      env: {},
    } as never;

    const outcome = await runTimetablesXlsxJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(outcome.failureCount).toBe(0);
    expect(tripCreate).toHaveBeenCalledTimes(1);
    expect(stopTimeCreateMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ stopId: "stop-a", arrivalMinutes: 360 }),
        expect.objectContaining({ stopId: "stop-b", arrivalMinutes: 370 }),
        expect.objectContaining({ stopId: "stop-c", arrivalMinutes: 380 }),
      ],
    });
  });
});

