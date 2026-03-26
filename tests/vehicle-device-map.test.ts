import { beforeEach, describe, expect, it, vi } from "vitest";

const { loadStructuredSourceMock, fetchBusJejuRealtimePositionsMock } = vi.hoisted(() => ({
  loadStructuredSourceMock: vi.fn(),
  fetchBusJejuRealtimePositionsMock: vi.fn(),
}));

vi.mock("@/worker/core/files", () => ({
  loadStructuredSource: loadStructuredSourceMock,
}));

vi.mock("@/worker/jobs/bus-jeju-live", () => ({
  fetchBusJejuRealtimePositions: fetchBusJejuRealtimePositionsMock,
}));

import { runVehicleDeviceMapJob } from "@/worker/jobs/vehicle-device-map";

describe("vehicle-device-map job", () => {
  beforeEach(() => {
    loadStructuredSourceMock.mockReset();
    fetchBusJejuRealtimePositionsMock.mockReset();
  });

  it("falls back to Jeju BIS realtime positions when no override source is configured", async () => {
    fetchBusJejuRealtimePositionsMock
      .mockResolvedValueOnce([
        {
          vhId: 7983169,
        },
        {
          vhId: 7983170,
        },
      ])
      .mockResolvedValueOnce([]);

    const upsert = vi.fn();
    const deleteMany = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        vehicleMapSourceUrl: "",
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-202",
              externalRouteId: "405320214",
              route: {
                shortName: "202",
              },
            },
            {
              id: "pattern-111",
              externalRouteId: "405411101",
              route: {
                shortName: "111",
              },
            },
          ]),
        },
        vehicleDeviceMap: {
          upsert,
          deleteMany,
        },
      },
    } as never;

    const outcome = await runVehicleDeviceMapJob(runtime);

    expect(fetchBusJejuRealtimePositionsMock).toHaveBeenCalledTimes(2);
    expect(outcome.successCount).toBe(2);
    expect(outcome.meta).toEqual(
      expect.objectContaining({
        source: "https://bus.jeju.go.kr/data/search/getRealTimeBusPositionByLineId",
        fallbackInspectedPatternCount: 2,
        fallbackFailureCount: 0,
      }),
    );
    expect(upsert).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: {
          routePatternId_deviceId: {
            routePatternId: "pattern-202",
            deviceId: "7983169",
          },
        },
      }),
    );
    expect(deleteMany).toHaveBeenCalledTimes(1);
  });

  it("keeps override source support for curated mapping files", async () => {
    loadStructuredSourceMock.mockResolvedValue([
      {
        routeShortName: "111",
        deviceId: "device-111",
      },
    ]);

    const upsert = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        vehicleMapSourceUrl: "vehicle-map.json",
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-111",
              externalRouteId: "405411101",
              route: {
                shortName: "111",
              },
            },
          ]),
        },
        vehicleDeviceMap: {
          upsert,
          deleteMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runVehicleDeviceMapJob(runtime);

    expect(fetchBusJejuRealtimePositionsMock).not.toHaveBeenCalled();
    expect(outcome.successCount).toBe(1);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          routePatternId_deviceId: {
            routePatternId: "pattern-111",
            deviceId: "device-111",
          },
        },
      }),
    );
  });
});
