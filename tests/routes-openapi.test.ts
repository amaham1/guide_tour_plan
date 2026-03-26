import { beforeEach, describe, expect, it, vi } from "vitest";

const { fetchPlainTextMock } = vi.hoisted(() => ({
  fetchPlainTextMock: vi.fn(),
}));

vi.mock("@/worker/core/fetch", () => ({
  fetchPlainText: fetchPlainTextMock,
}));

import { runRoutesOpenApiJob } from "@/worker/jobs/routes-openapi";

describe("routes-openapi job", () => {
  beforeEach(() => {
    fetchPlainTextMock.mockReset();
  });

  it("marks excluded special routes inactive even if they appear in the route catalog", async () => {
    fetchPlainTextMock.mockImplementation(async (url: string) => {
      if (url.includes("detailSchedule?scheduleId=2402")) {
        return `
          <table>
            <tr><td class="route-num">\uC6B0\uB3C4\uAE09\uD589</td></tr>
            <tr><td class="route-waypoint">Terminal -> Udo</td></tr>
          </table>
        `;
      }

      return `<a href="/mobile/schedule/detailSchedule?scheduleId=2402">\uC6B0\uB3C4\uAE09\uD589</a>`;
    });

    const upsert = vi.fn();
    const updateMany = vi.fn();
    const runtime = {
      env: {
        busJejuBaseUrl: "https://bus.jeju.go.kr",
        routeSearchTerms: [],
      },
      prisma: {
        route: {
          upsert,
          updateMany,
        },
      },
    } as never;

    const outcome = await runRoutesOpenApiJob(runtime);

    expect(outcome.processedCount).toBe(1);
    expect(outcome.successCount).toBe(0);
    expect(upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          shortName: "\uC6B0\uB3C4\uAE09\uD589",
          isActive: false,
        }),
        create: expect.objectContaining({
          shortName: "\uC6B0\uB3C4\uAE09\uD589",
          isActive: false,
        }),
      }),
    );
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: {
          notIn: [],
        },
      },
      data: {
        isActive: false,
      },
    });
  });
});
