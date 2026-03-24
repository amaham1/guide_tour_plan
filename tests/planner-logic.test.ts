import { describe, expect, it } from "vitest";
import {
  buildPlannerCandidates,
  type PlannerGraphContext,
} from "@/features/planner/engine";
import { compareMetrics, scoreCandidate } from "@/features/planner/scoring";
import { buildExecutionStatus } from "@/features/planner/realtime";
import type {
  CandidateMetrics,
  CandidateSummary,
  PlannerEngineInput,
} from "@/features/planner/types";

describe("planner scoring", () => {
  const fastMetrics: CandidateMetrics = {
    totalDurationMinutes: 180,
    totalWalkMinutes: 18,
    transfers: 0,
    finalArrivalMinutes: 720,
    usesEstimatedStopTimes: false,
    safetyBufferCost: 5,
    realtimeEligible: true,
  };

  const slowMetrics: CandidateMetrics = {
    totalDurationMinutes: 210,
    totalWalkMinutes: 26,
    transfers: 1,
    finalArrivalMinutes: 760,
    usesEstimatedStopTimes: true,
    safetyBufferCost: 15,
    realtimeEligible: false,
  };

  it("favors earlier arrival for fastest candidates", () => {
    expect(scoreCandidate("FASTEST", fastMetrics)).toBeLessThan(
      scoreCandidate("FASTEST", slowMetrics),
    );
    expect(compareMetrics("FASTEST", fastMetrics, slowMetrics)).toBeLessThan(0);
  });

  it("penalizes extra walking for least-walk candidates", () => {
    expect(scoreCandidate("LEAST_WALK", fastMetrics)).toBeLessThan(
      scoreCandidate("LEAST_WALK", {
        ...fastMetrics,
        totalWalkMinutes: 40,
      }),
    );
  });
});

describe("execution realtime fallback", () => {
  const summary: CandidateSummary = {
    planId: "plan-1",
    title: "빠른 도착형",
    narrative: "테스트용 요약입니다.",
    totalDurationMinutes: 120,
    totalWalkMinutes: 16,
    transfers: 0,
    finalArrivalAt: "2026-03-23T11:00:00.000Z",
    realtimeEligible: false,
    usesEstimatedStopTimes: false,
    safetyBufferCost: 5,
  };

  it("returns schedule-only guidance when realtime is unavailable", () => {
    const status = buildExecutionStatus(
      "session-1",
      {
        summary,
        legs: [
          {
            id: "ride-1",
            kind: "ride",
            title: "111번 탑승",
            startAt: "2026-03-23T10:00:00.000Z",
            endAt: "2026-03-23T10:30:00.000Z",
            durationMinutes: 30,
            routePatternId: "pattern-without-map",
          },
        ],
      },
      {},
      new Date("2026-03-23T10:05:00.000Z"),
    );

    expect(status.realtimeApplied).toBe(false);
    expect(status.notice).toContain("시간표 기준");
    expect(status.status).toBe("ACTIVE");
  });
});

describe("planner engine long-distance routing", () => {
  it("keeps cross-island candidates when access walks and transfer windows are longer", () => {
    const input: PlannerEngineInput = {
      startAt: "2026-03-24T08:00:00+09:00",
      places: [
        {
          placeId: "place-dongmun",
          dwellMinutes: 10,
        },
        {
          placeId: "place-seongsan",
          dwellMinutes: 60,
        },
      ],
    };

    const context: PlannerGraphContext = {
      places: new Map([
        [
          "place-dongmun",
          {
            id: "place-dongmun",
            displayName: "동문시장",
            regionName: "제주시",
            latitude: 33.5118,
            longitude: 126.526,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
        [
          "place-seongsan",
          {
            id: "place-seongsan",
            displayName: "성산일출봉",
            regionName: "서귀포시",
            latitude: 33.4588,
            longitude: 126.9425,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
      ]),
      stops: new Map([
        [
          "stop-dongmun",
          {
            id: "stop-dongmun",
            displayName: "동문시장 인근",
            latitude: 33.512,
            longitude: 126.527,
          },
        ],
        [
          "stop-transfer",
          {
            id: "stop-transfer",
            displayName: "제주시청",
            latitude: 33.499,
            longitude: 126.53,
          },
        ],
        [
          "stop-seongsan",
          {
            id: "stop-seongsan",
            displayName: "성산항",
            latitude: 33.462,
            longitude: 126.932,
          },
        ],
      ]),
      accessLinksByPlace: new Map([
        [
          "place-dongmun",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-dongmun",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-dongmun",
              durationMinutes: 20,
              distanceMeters: 1_500,
              rank: 1,
            },
          ],
        ],
        [
          "place-seongsan",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-seongsan",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-seongsan",
              durationMinutes: 23,
              distanceMeters: 1_720,
              rank: 1,
            },
          ],
        ],
      ]),
      egressLinksByPlace: new Map([
        [
          "place-dongmun",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-dongmun",
              fromStopId: "stop-dongmun",
              toStopId: null,
              durationMinutes: 20,
              distanceMeters: 1_500,
              rank: 1,
            },
          ],
        ],
        [
          "place-seongsan",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-seongsan",
              fromStopId: "stop-seongsan",
              toStopId: null,
              durationMinutes: 23,
              distanceMeters: 1_720,
              rank: 1,
            },
          ],
        ],
      ]),
      stopTransfersByOrigin: new Map(),
      trips: [
        {
          id: "trip-city-hop",
          routePatternId: "pattern-city-hop",
          routeShortName: "442",
          routeDisplayName: "442",
          headsign: "제주시청",
          stopTimes: [
            {
              stopId: "stop-dongmun",
              stopName: "동문시장 인근",
              sequence: 1,
              arrivalMinutes: 540,
              departureMinutes: 540,
              isEstimated: false,
            },
            {
              stopId: "stop-transfer",
              stopName: "제주시청",
              sequence: 2,
              arrivalMinutes: 600,
              departureMinutes: 600,
              isEstimated: false,
            },
          ],
          stopTimeByStopId: new Map([
            [
              "stop-dongmun",
              {
                stopId: "stop-dongmun",
                stopName: "동문시장 인근",
                sequence: 1,
                arrivalMinutes: 540,
                departureMinutes: 540,
                isEstimated: false,
              },
            ],
            [
              "stop-transfer",
              {
                stopId: "stop-transfer",
                stopName: "제주시청",
                sequence: 2,
                arrivalMinutes: 600,
                departureMinutes: 600,
                isEstimated: false,
              },
            ],
          ]),
        },
        {
          id: "trip-east-bound",
          routePatternId: "pattern-east-bound",
          routeShortName: "111",
          routeDisplayName: "111",
          headsign: "성산항",
          stopTimes: [
            {
              stopId: "stop-transfer",
              stopName: "제주시청",
              sequence: 1,
              arrivalMinutes: 610,
              departureMinutes: 610,
              isEstimated: false,
            },
            {
              stopId: "stop-seongsan",
              stopName: "성산항",
              sequence: 2,
              arrivalMinutes: 680,
              departureMinutes: 680,
              isEstimated: false,
            },
          ],
          stopTimeByStopId: new Map([
            [
              "stop-transfer",
              {
                stopId: "stop-transfer",
                stopName: "제주시청",
                sequence: 1,
                arrivalMinutes: 610,
                departureMinutes: 610,
                isEstimated: false,
              },
            ],
            [
              "stop-seongsan",
              {
                stopId: "stop-seongsan",
                stopName: "성산항",
                sequence: 2,
                arrivalMinutes: 680,
                departureMinutes: 680,
                isEstimated: false,
              },
            ],
          ]),
        },
      ],
      realtimePatternIds: new Set(),
    };

    const candidates = buildPlannerCandidates("plan-long-hop", input, context);

    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates[0]?.legs.some((leg) => leg.kind === "walk" && leg.durationMinutes === 20)).toBe(
      true,
    );
    expect(candidates[0]?.legs.some((leg) => leg.kind === "ride" && leg.routeShortName === "111")).toBe(
      true,
    );
  });
});
