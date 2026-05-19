import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  syncSourceCatalogMock,
  createWorkerRuntimeMock,
  stopsHandlerMock,
  routesHtmlHandlerMock,
  routeGeometriesHandlerMock,
  timetablesXlsxHandlerMock,
  observedTimetablesHandlerMock,
} = vi.hoisted(() => ({
  syncSourceCatalogMock: vi.fn(),
  createWorkerRuntimeMock: vi.fn(),
  stopsHandlerMock: vi.fn(),
  routesHtmlHandlerMock: vi.fn(),
  routeGeometriesHandlerMock: vi.fn(),
  timetablesXlsxHandlerMock: vi.fn(),
  observedTimetablesHandlerMock: vi.fn(),
}));

vi.mock("@/lib/source-catalog", () => ({
  syncSourceCatalog: syncSourceCatalogMock,
}));

vi.mock("@/worker/core/runtime", () => ({
  createWorkerRuntime: createWorkerRuntimeMock,
}));

vi.mock("@/worker/jobs/registry", () => ({
  jobRegistry: {
    stops: stopsHandlerMock,
    "routes-html": routesHtmlHandlerMock,
    "route-geometries": routeGeometriesHandlerMock,
    "timetables-xlsx": timetablesXlsxHandlerMock,
    "observed-timetables": observedTimetablesHandlerMock,
  },
}));

function createPrisma() {
  return {
    ingestJob: {
      findUnique: vi.fn().mockImplementation(async ({ where }: { where: { key: string } }) => ({
        id: `job-${where.key}`,
        key: where.key,
        isActive: true,
      })),
      update: vi.fn(),
    },
    ingestRun: {
      updateMany: vi.fn(),
      create: vi.fn().mockImplementation(async ({ data }: { data: { jobId: string } }) => ({
        id: `run-${data.jobId}`,
      })),
      update: vi.fn(),
    },
  };
}

describe("job runner follow-ups", () => {
  beforeEach(() => {
    syncSourceCatalogMock.mockReset();
    createWorkerRuntimeMock.mockReset();
    stopsHandlerMock.mockReset();
    routesHtmlHandlerMock.mockReset();
    routeGeometriesHandlerMock.mockReset();
    timetablesXlsxHandlerMock.mockReset();
    observedTimetablesHandlerMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it("runs timetables-xlsx automatically after a single routes-html run", async () => {
    const prisma = createPrisma();
    const routesHtmlOutcome = {
      processedCount: 3,
      successCount: 3,
      failureCount: 0,
    };
    const timetablesOutcome = {
      processedCount: 12,
      successCount: 12,
      failureCount: 0,
    };
    const observedTimetablesOutcome = {
      processedCount: 12,
      successCount: 4,
      failureCount: 0,
    };

    createWorkerRuntimeMock.mockImplementation((options?: { prisma?: unknown; triggeredBy?: string }) => ({
      prisma: options?.prisma ?? prisma,
      triggeredBy: options?.triggeredBy ?? "cli",
      env: {},
    }));
    routesHtmlHandlerMock.mockResolvedValue(routesHtmlOutcome);
    timetablesXlsxHandlerMock.mockResolvedValue(timetablesOutcome);
    observedTimetablesHandlerMock.mockResolvedValue(observedTimetablesOutcome);

    const { runJobByKey } = await import("@/worker/core/job-runner");
    const results = await runJobByKey("routes-html", {
      prisma: prisma as never,
      triggeredBy: "admin",
    });

    expect(results).toEqual({
      "routes-html": routesHtmlOutcome,
      "timetables-xlsx": timetablesOutcome,
      "observed-timetables": observedTimetablesOutcome,
    });
    expect(routesHtmlHandlerMock).toHaveBeenCalledTimes(1);
    expect(timetablesXlsxHandlerMock).toHaveBeenCalledTimes(1);
    expect(observedTimetablesHandlerMock).toHaveBeenCalledTimes(1);
    expect(routesHtmlHandlerMock.mock.invocationCallOrder[0]).toBeLessThan(
      timetablesXlsxHandlerMock.mock.invocationCallOrder[0],
    );
    expect(timetablesXlsxHandlerMock.mock.invocationCallOrder[0]).toBeLessThan(
      observedTimetablesHandlerMock.mock.invocationCallOrder[0],
    );
    expect(createWorkerRuntimeMock).toHaveBeenNthCalledWith(1, {
      prisma,
      triggeredBy: "admin",
    });
    expect(createWorkerRuntimeMock).toHaveBeenNthCalledWith(2, {
      prisma,
      triggeredBy: "admin:follow-up:routes-html",
    });
    expect(createWorkerRuntimeMock).toHaveBeenNthCalledWith(3, {
      prisma,
      triggeredBy: "admin:follow-up:routes-html:follow-up:timetables-xlsx",
    });
    expect(syncSourceCatalogMock).toHaveBeenCalledTimes(3);
  });

  it("keeps run-all explicit and does not double-run follow-up jobs", async () => {
    const prisma = createPrisma();

    createWorkerRuntimeMock.mockImplementation((options?: { prisma?: unknown; triggeredBy?: string }) => ({
      prisma: options?.prisma ?? prisma,
      triggeredBy: options?.triggeredBy ?? "cli",
      env: {},
    }));
    stopsHandlerMock.mockResolvedValue({
      processedCount: 1,
      successCount: 1,
      failureCount: 0,
    });
    routesHtmlHandlerMock.mockResolvedValue({
      processedCount: 2,
      successCount: 2,
      failureCount: 0,
    });
    routeGeometriesHandlerMock.mockResolvedValue({
      processedCount: 3,
      successCount: 3,
      failureCount: 0,
    });
    timetablesXlsxHandlerMock.mockResolvedValue({
      processedCount: 4,
      successCount: 4,
      failureCount: 0,
    });
    observedTimetablesHandlerMock.mockResolvedValue({
      processedCount: 5,
      successCount: 5,
      failureCount: 0,
    });

    const { runAllJobs } = await import("@/worker/core/job-runner");
    const results = await runAllJobs({
      prisma: prisma as never,
      triggeredBy: "cli",
    });

    expect(Object.keys(results)).toEqual([
      "stops",
      "routes-html",
      "route-geometries",
      "timetables-xlsx",
      "observed-timetables",
    ]);
    expect(timetablesXlsxHandlerMock).toHaveBeenCalledTimes(1);
    expect(observedTimetablesHandlerMock).toHaveBeenCalledTimes(1);
    expect(createWorkerRuntimeMock.mock.calls.map(([options]) => options.triggeredBy)).toEqual([
      "cli",
      "cli",
      "cli",
      "cli",
      "cli",
    ]);
  });
});
