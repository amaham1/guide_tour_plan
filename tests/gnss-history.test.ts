import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGnssRecordsMock } = vi.hoisted(() => ({
  fetchGnssRecordsMock: vi.fn(),
}));

const { fetchBusJejuRealtimePositionsMock } = vi.hoisted(() => ({
  fetchBusJejuRealtimePositionsMock: vi.fn(),
}));

vi.mock("@/features/planner/realtime-source", () => ({
  fetchGnssRecords: fetchGnssRecordsMock,
  toTimestamp: (value: string) => new Date(value),
}));

vi.mock("@/worker/jobs/bus-jeju-live", () => ({
  fetchBusJejuRealtimePositions: fetchBusJejuRealtimePositionsMock,
}));

import { runGnssHistoryJob } from "../worker/jobs/gnss-history";

describe("gnss-history job", () => {
  beforeEach(() => {
    fetchGnssRecordsMock.mockReset();
    fetchBusJejuRealtimePositionsMock.mockReset();
  });

  it("stores only rows that are not already present", async () => {
    fetchGnssRecordsMock.mockResolvedValue([
      {
        deviceId: "bus-1",
        latitude: 33.5,
        longitude: 126.5,
        time: "2026-03-24T08:00:00+09:00",
      },
      {
        deviceId: "bus-1",
        latitude: 33.51,
        longitude: 126.51,
        time: "2026-03-24T08:01:00+09:00",
      },
    ]);

    const createMany = vi.fn();
    const runtime = {
      env: {
        dataGoKrServiceKey: "service-key",
      },
      prisma: {
        gnssObservation: {
          findMany: vi.fn().mockResolvedValue([
            {
              deviceId: "bus-1",
              observedAt: new Date("2026-03-24T08:00:00+09:00"),
              latitude: 33.5,
              longitude: 126.5,
            },
          ]),
          createMany,
        },
      },
    } as never;

    const outcome = await runGnssHistoryJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          deviceId: "bus-1",
          latitude: 33.51,
          longitude: 126.51,
        }),
      ],
    });
  });

  it("falls back to Jeju BIS realtime positions when data.go GNSS is unavailable", async () => {
    fetchGnssRecordsMock.mockRejectedValue(new Error("GNSS API request failed: 401"));
    fetchBusJejuRealtimePositionsMock.mockResolvedValue([
      {
        vhId: 7983169,
        localX: 126.5,
        localY: 33.5,
      },
    ]);

    const createMany = vi.fn();
    const runtime = {
      env: {
        dataGoKrServiceKey: "service-key",
      },
      prisma: {
        vehicleDeviceMap: {
          findMany: vi.fn().mockResolvedValue([
            {
              externalRouteId: "405320214",
            },
          ]),
        },
        gnssObservation: {
          findMany: vi.fn().mockResolvedValue([]),
          createMany,
        },
      },
    } as never;

    const outcome = await runGnssHistoryJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(outcome.meta).toEqual(
      expect.objectContaining({
        source: "BUS_JEJU_REALTIME",
        fallbackReason: "GNSS API request failed: 401",
        fallbackExternalRouteCount: 1,
      }),
    );
    expect(fetchBusJejuRealtimePositionsMock).toHaveBeenCalledWith(runtime, "405320214");
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({
          deviceId: "7983169",
          latitude: 33.5,
          longitude: 126.5,
        }),
      ],
    });
  });
});
