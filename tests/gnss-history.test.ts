import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchGnssRecordsMock } = vi.hoisted(() => ({
  fetchGnssRecordsMock: vi.fn(),
}));

vi.mock("@/features/planner/realtime-source", () => ({
  fetchGnssRecords: fetchGnssRecordsMock,
  toTimestamp: (value: string) => new Date(value),
}));

import { runGnssHistoryJob } from "../worker/jobs/gnss-history";

describe("gnss-history job", () => {
  beforeEach(() => {
    fetchGnssRecordsMock.mockReset();
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
});
