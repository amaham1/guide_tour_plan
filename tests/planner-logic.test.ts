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

function createTrip(
  id: string,
  routePatternId: string,
  routeShortName: string,
  headsign: string,
  stopTimes: Array<{
    stopId: string;
    stopName: string;
    sequence: number;
    arrivalMinutes: number;
    departureMinutes: number;
    isEstimated?: boolean;
  }>,
) {
  const normalizedStopTimes = stopTimes.map((stopTime) => ({
    ...stopTime,
    isEstimated: stopTime.isEstimated ?? false,
  }));

  return {
    id,
    routePatternId,
    routeShortName,
    routeDisplayName: routeShortName,
    headsign,
    stopTimes: normalizedStopTimes,
    stopTimeByStopId: new Map(
      normalizedStopTimes.map((stopTime) => [stopTime.stopId, stopTime] as const),
    ),
  };
}

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

describe("planner engine access stop optimization", () => {
  it("walks through the stop graph before the first boarding when it yields an earlier trip", () => {
    const input: PlannerEngineInput = {
      startAt: "2026-03-24T08:40:00+09:00",
      places: [
        {
          placeId: "place-start",
          dwellMinutes: 10,
        },
        {
          placeId: "place-end",
          dwellMinutes: 30,
        },
      ],
    };

    const context: PlannerGraphContext = {
      places: new Map([
        [
          "place-start",
          {
            id: "place-start",
            displayName: "출발지",
            regionName: "제주시",
            latitude: 33.5,
            longitude: 126.5,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
        [
          "place-end",
          {
            id: "place-end",
            displayName: "도착지",
            regionName: "제주시",
            latitude: 33.52,
            longitude: 126.55,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
      ]),
      stops: new Map([
        [
          "stop-access",
          {
            id: "stop-access",
            displayName: "출발 정류장",
            latitude: 33.5005,
            longitude: 126.5005,
          },
        ],
        [
          "stop-best",
          {
            id: "stop-best",
            displayName: "더 좋은 정류장",
            latitude: 33.501,
            longitude: 126.501,
          },
        ],
        [
          "stop-dest",
          {
            id: "stop-dest",
            displayName: "도착 정류장",
            latitude: 33.52,
            longitude: 126.55,
          },
        ],
      ]),
      accessLinksByPlace: new Map([
        [
          "place-start",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-start",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-access",
              durationMinutes: 7,
              distanceMeters: 550,
              rank: 1,
            },
          ],
        ],
        [
          "place-end",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-end",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-dest",
              durationMinutes: 4,
              distanceMeters: 280,
              rank: 1,
            },
          ],
        ],
      ]),
      egressLinksByPlace: new Map([
        [
          "place-start",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-start",
              fromStopId: "stop-access",
              toStopId: null,
              durationMinutes: 7,
              distanceMeters: 550,
              rank: 1,
            },
          ],
        ],
        [
          "place-end",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-end",
              fromStopId: "stop-dest",
              toStopId: null,
              durationMinutes: 4,
              distanceMeters: 280,
              rank: 1,
            },
          ],
        ],
      ]),
      stopTransfersByOrigin: new Map([
        [
          "stop-access",
          [
            {
              kind: "STOP_STOP",
              fromPlaceId: null,
              toPlaceId: null,
              fromStopId: "stop-access",
              toStopId: "stop-best",
              durationMinutes: 2,
              distanceMeters: 140,
              rank: 1,
            },
          ],
        ],
      ]),
      trips: [
        createTrip("trip-best", "pattern-best", "201", "도착 정류장", [
          {
            stopId: "stop-best",
            stopName: "더 좋은 정류장",
            sequence: 1,
            arrivalMinutes: 545,
            departureMinutes: 545,
          },
          {
            stopId: "stop-dest",
            stopName: "도착 정류장",
            sequence: 2,
            arrivalMinutes: 575,
            departureMinutes: 575,
          },
        ]),
        createTrip("trip-late", "pattern-late", "299", "도착 정류장", [
          {
            stopId: "stop-access",
            stopName: "출발 정류장",
            sequence: 1,
            arrivalMinutes: 560,
            departureMinutes: 560,
          },
          {
            stopId: "stop-dest",
            stopName: "도착 정류장",
            sequence: 2,
            arrivalMinutes: 610,
            departureMinutes: 610,
          },
        ]),
      ],
      realtimePatternIds: new Set(),
    };

    const candidates = buildPlannerCandidates("plan-access-opt", input, context);
    const fastest = candidates.find((candidate) => candidate.kind === "FASTEST");

    expect(fastest).toBeDefined();
    expect(
      fastest?.legs.some(
        (leg) =>
          leg.kind === "walk" &&
          leg.fromStopId === "stop-access" &&
          leg.toStopId === "stop-best",
      ),
    ).toBe(true);
    expect(fastest?.legs.find((leg) => leg.kind === "ride")?.fromStopId).toBe("stop-best");
  });

  it("keeps the nearer boarding stop when the faster journey requires more than one transfer", () => {
    const input: PlannerEngineInput = {
      startAt: "2026-03-24T08:40:00+09:00",
      places: [
        {
          placeId: "place-start",
          dwellMinutes: 10,
        },
        {
          placeId: "place-end",
          dwellMinutes: 30,
        },
      ],
    };

    const context: PlannerGraphContext = {
      places: new Map([
        [
          "place-start",
          {
            id: "place-start",
            displayName: "출발지",
            regionName: "제주시",
            latitude: 33.5,
            longitude: 126.5,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
        [
          "place-end",
          {
            id: "place-end",
            displayName: "도착지",
            regionName: "서귀포시",
            latitude: 33.4,
            longitude: 126.9,
            openingHoursRaw: null,
            openingHoursJson: null,
          },
        ],
      ]),
      stops: new Map([
        [
          "stop-near",
          {
            id: "stop-near",
            displayName: "가까운 정류장",
            latitude: 33.5005,
            longitude: 126.5005,
          },
        ],
        [
          "stop-far",
          {
            id: "stop-far",
            displayName: "먼 정류장",
            latitude: 33.504,
            longitude: 126.504,
          },
        ],
        [
          "stop-x",
          {
            id: "stop-x",
            displayName: "환승 정류장 1",
            latitude: 33.45,
            longitude: 126.65,
          },
        ],
        [
          "stop-y",
          {
            id: "stop-y",
            displayName: "환승 정류장 2",
            latitude: 33.43,
            longitude: 126.8,
          },
        ],
        [
          "stop-target",
          {
            id: "stop-target",
            displayName: "도착 정류장",
            latitude: 33.401,
            longitude: 126.901,
          },
        ],
      ]),
      accessLinksByPlace: new Map([
        [
          "place-start",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-start",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-near",
              durationMinutes: 5,
              distanceMeters: 350,
              rank: 1,
            },
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-start",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-far",
              durationMinutes: 18,
              distanceMeters: 1_350,
              rank: 2,
            },
          ],
        ],
        [
          "place-end",
          [
            {
              kind: "PLACE_STOP",
              fromPlaceId: "place-end",
              toPlaceId: null,
              fromStopId: null,
              toStopId: "stop-target",
              durationMinutes: 4,
              distanceMeters: 260,
              rank: 1,
            },
          ],
        ],
      ]),
      egressLinksByPlace: new Map([
        [
          "place-start",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-start",
              fromStopId: "stop-near",
              toStopId: null,
              durationMinutes: 5,
              distanceMeters: 350,
              rank: 1,
            },
          ],
        ],
        [
          "place-end",
          [
            {
              kind: "STOP_PLACE",
              fromPlaceId: null,
              toPlaceId: "place-end",
              fromStopId: "stop-target",
              toStopId: null,
              durationMinutes: 4,
              distanceMeters: 260,
              rank: 1,
            },
          ],
        ],
      ]),
      stopTransfersByOrigin: new Map(),
      trips: [
        createTrip("trip-far-direct", "pattern-far-direct", "900", "도착 정류장", [
          {
            stopId: "stop-far",
            stopName: "먼 정류장",
            sequence: 1,
            arrivalMinutes: 553,
            departureMinutes: 553,
          },
          {
            stopId: "stop-target",
            stopName: "도착 정류장",
            sequence: 2,
            arrivalMinutes: 625,
            departureMinutes: 625,
          },
        ]),
        createTrip("trip-near-1", "pattern-near-1", "101", "환승 정류장 1", [
          {
            stopId: "stop-near",
            stopName: "가까운 정류장",
            sequence: 1,
            arrivalMinutes: 540,
            departureMinutes: 540,
          },
          {
            stopId: "stop-x",
            stopName: "환승 정류장 1",
            sequence: 2,
            arrivalMinutes: 555,
            departureMinutes: 555,
          },
        ]),
        createTrip("trip-near-2", "pattern-near-2", "202", "환승 정류장 2", [
          {
            stopId: "stop-x",
            stopName: "환승 정류장 1",
            sequence: 1,
            arrivalMinutes: 559,
            departureMinutes: 559,
          },
          {
            stopId: "stop-y",
            stopName: "환승 정류장 2",
            sequence: 2,
            arrivalMinutes: 580,
            departureMinutes: 580,
          },
        ]),
        createTrip("trip-near-3", "pattern-near-3", "303", "도착 정류장", [
          {
            stopId: "stop-y",
            stopName: "환승 정류장 2",
            sequence: 1,
            arrivalMinutes: 584,
            departureMinutes: 584,
          },
          {
            stopId: "stop-target",
            stopName: "도착 정류장",
            sequence: 2,
            arrivalMinutes: 600,
            departureMinutes: 600,
          },
        ]),
      ],
      realtimePatternIds: new Set(),
    };

    const candidates = buildPlannerCandidates("plan-near-stop", input, context);
    const fastest = candidates.find((candidate) => candidate.kind === "FASTEST");

    expect(fastest).toBeDefined();
    expect(fastest?.legs.find((leg) => leg.kind === "ride")?.fromStopId).toBe("stop-near");
    expect(fastest?.legs.filter((leg) => leg.kind === "ride")).toHaveLength(3);
    expect(fastest?.summary.totalDurationMinutes).toBe(114);
  });
});
