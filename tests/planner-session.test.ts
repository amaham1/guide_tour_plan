import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  dbMock,
  fetchLatestGnssPositionMock,
  estimateDelayMinutesFromGnssMock,
} = vi.hoisted(() => ({
  dbMock: {
    executionSession: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    vehicleDeviceMap: {
      findMany: vi.fn(),
    },
    stop: {
      findUnique: vi.fn(),
    },
  },
  fetchLatestGnssPositionMock: vi.fn(),
  estimateDelayMinutesFromGnssMock: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: dbMock,
}));

vi.mock("@/lib/env", () => ({
  appEnv: {
    dataGoKrServiceKey: "test-key",
  },
}));

vi.mock("@/features/planner/realtime-source", () => ({
  fetchLatestGnssPosition: fetchLatestGnssPositionMock,
  estimateDelayMinutesFromGnss: estimateDelayMinutesFromGnssMock,
}));

import { getExecutionSessionStatus } from "@/features/planner/service";

describe("planner execution session realtime", () => {
  beforeEach(() => {
    vi.useRealTimers();
    dbMock.executionSession.findUnique.mockReset();
    dbMock.executionSession.update.mockReset();
    dbMock.vehicleDeviceMap.findMany.mockReset();
    dbMock.stop.findUnique.mockReset();
    fetchLatestGnssPositionMock.mockReset();
    estimateDelayMinutesFromGnssMock.mockReset();
  });

  it("wires realtime lookup into execution sessions and flags risky downstream transfers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T10:05:00.000Z"));

    dbMock.executionSession.findUnique.mockResolvedValue({
      id: "session-1",
      snapshot: {
        summary: {
          planId: "plan-1",
          title: "테스트 일정",
          narrative: "세션 테스트",
          totalDurationMinutes: 90,
          totalWalkMinutes: 8,
          transfers: 1,
          finalArrivalAt: "2026-03-23T11:00:00.000Z",
          realtimeEligible: true,
          worstTimeReliability: "OFFICIAL",
          finalArrivalWindowStartAt: null,
          finalArrivalWindowEndAt: null,
          safetyBufferCost: 5,
        },
        legs: [
          {
            id: "ride-1",
            kind: "ride",
            title: "111번 탑승",
            startAt: "2026-03-23T10:00:00.000Z",
            endAt: "2026-03-23T10:30:00.000Z",
            durationMinutes: 30,
            routePatternId: "pattern-111",
            fromStopId: "stop-a",
            toStopId: "stop-b",
            timeReliability: "OFFICIAL",
          },
          {
            id: "walk-1",
            kind: "walk",
            title: "환승 이동",
            startAt: "2026-03-23T10:30:00.000Z",
            endAt: "2026-03-23T10:34:00.000Z",
            durationMinutes: 4,
            timeReliability: "OFFICIAL",
          },
          {
            id: "ride-2",
            kind: "ride",
            title: "222번 탑승",
            startAt: "2026-03-23T10:36:00.000Z",
            endAt: "2026-03-23T11:00:00.000Z",
            durationMinutes: 24,
            routePatternId: "pattern-222",
            fromStopId: "stop-c",
            toStopId: "stop-d",
            timeReliability: "OFFICIAL",
          },
        ],
      },
    });
    dbMock.vehicleDeviceMap.findMany.mockResolvedValue([
      {
        routePatternId: "pattern-111",
        deviceId: "device-111",
        externalRouteId: null,
        refreshedAt: new Date("2026-03-23T10:04:00.000Z"),
      },
      {
        routePatternId: "pattern-222",
        deviceId: "device-222",
        externalRouteId: null,
        refreshedAt: new Date("2026-03-23T10:03:00.000Z"),
      },
    ]);
    dbMock.stop.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({
      id: where.id,
      latitude: 33.5,
      longitude: 126.5,
    }));
    fetchLatestGnssPositionMock.mockResolvedValue({
      deviceId: "device-111",
      latitude: 33.5,
      longitude: 126.5,
      time: "2026-03-23T10:04:00.000Z",
    });
    estimateDelayMinutesFromGnssMock.mockReturnValue(5);

    const status = await getExecutionSessionStatus("session-1");

    expect(fetchLatestGnssPositionMock).toHaveBeenCalledWith(
      "test-key",
      "device-111",
      new Date("2026-03-23T10:05:00.000Z"),
    );
    expect(status.realtimeApplied).toBe(true);
    expect(status.delayMinutes).toBe(5);
    expect(status.replacementSuggested).toBe(true);
    expect(status.realtimeReason).toBe("GNSS");
    expect(status.notice).toContain("5분 지연");
    expect(status.nextActionAt).toBe("2026-03-23T10:35:00.000Z");
    expect(dbMock.executionSession.update).toHaveBeenCalledWith({
      where: { id: "session-1" },
      data: {
        currentLegIndex: 0,
        lastRealtimeApplied: true,
        status: "ACTIVE",
      },
    });

    vi.useRealTimers();
  });
});
