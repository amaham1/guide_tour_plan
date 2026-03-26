import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { matchTraceGeometryMock, getRouteGeometryMock, fetchBusJejuLinkInfoMock } = vi.hoisted(() => ({
  matchTraceGeometryMock: vi.fn(),
  getRouteGeometryMock: vi.fn(),
  fetchBusJejuLinkInfoMock: vi.fn(),
}));

vi.mock("@/lib/osrm", () => ({
  matchTraceGeometry: matchTraceGeometryMock,
  getRouteGeometry: getRouteGeometryMock,
}));

vi.mock("@/worker/jobs/bus-jeju-live", () => ({
  fetchBusJejuLinkInfo: fetchBusJejuLinkInfoMock,
}));

import { runRouteGeometriesJob } from "../worker/jobs/route-geometries";

describe("route-geometries job", () => {
  let tempDir: string;

  beforeEach(async () => {
    matchTraceGeometryMock.mockReset();
    getRouteGeometryMock.mockReset();
    fetchBusJejuLinkInfoMock.mockReset();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gtfs-"));

    await fs.writeFile(
      path.join(tempDir, "routes.txt"),
      "route_id,route_short_name,route_long_name\nroute-1,111,111 Route\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "trips.txt"),
      "route_id,service_id,trip_id,trip_headsign,direction_id,shape_id\nroute-1,svc,trip-1,Terminal,0,shape-1\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "stop_times.txt"),
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\ntrip-1,08:00:00,08:00:00,gtfs-stop-a,1\ntrip-1,08:10:00,08:10:00,gtfs-stop-b,2\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "stops.txt"),
      "stop_id,stop_name,stop_lat,stop_lon\ngtfs-stop-a,Stop A,33.5000,126.5000\ngtfs-stop-b,Stop B,33.5100,126.5200\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "shapes.txt"),
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\nshape-1,33.5000,126.5000,1\nshape-1,33.5050,126.5100,2\nshape-1,33.5100,126.5200,3\n",
      "utf8",
    );
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("matches GTFS shapes and writes stop projections", async () => {
    fetchBusJejuLinkInfoMock.mockResolvedValue([]);
    matchTraceGeometryMock.mockResolvedValue([]);
    getRouteGeometryMock.mockRejectedValue(new Error("should not fallback"));

    const geometryUpsert = vi.fn();
    const stopProjectionCreateMany = vi.fn();
    const stopUpdateMany = vi.fn();
    const runtime = {
      env: {
        gtfsShapesPath: tempDir,
        gtfsFeedUrl: "",
        osrmBusDistanceBaseUrl: "http://localhost:5001",
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-1",
              externalRouteId: "405411101",
              route: {
                shortName: "111",
              },
              stops: [
                {
                  stopId: "stop-a",
                  sequence: 1,
                  stop: {
                    id: "stop-a",
                    latitude: 33.5,
                    longitude: 126.5,
                    displayName: "Stop A",
                    translations: [],
                  },
                },
                {
                  stopId: "stop-b",
                  sequence: 2,
                  stop: {
                    id: "stop-b",
                    latitude: 33.51,
                    longitude: 126.52,
                    displayName: "Stop B",
                    translations: [],
                  },
                },
              ],
            },
          ]),
        },
        routePatternGeometry: {
          upsert: geometryUpsert,
        },
        routePatternStopProjection: {
          deleteMany: vi.fn(),
          createMany: stopProjectionCreateMany,
        },
        routePatternStop: {
          updateMany: stopUpdateMany,
        },
      },
    } as never;

    const outcome = await runRouteGeometriesJob(runtime);

    expect(outcome.successCount).toBe(1);
    expect(geometryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceKind: "GTFS",
          shapeRef: "shape-1",
        }),
      }),
    );
    expect(stopProjectionCreateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [
          expect.objectContaining({
            routePatternId: "pattern-1",
            sequence: 1,
            offsetMeters: 0,
          }),
          expect.objectContaining({
            routePatternId: "pattern-1",
            sequence: 2,
          }),
        ],
      }),
    );
    expect(stopUpdateMany).toHaveBeenCalledTimes(2);
  });

  it("uses Jeju BIS link geometry before GTFS and OSRM fallbacks", async () => {
    fetchBusJejuLinkInfoMock.mockResolvedValue([
      { localX: "126.5000", localY: "33.5000" },
      { localX: "126.5100", localY: "33.5050" },
      { localX: "126.5200", localY: "33.5100" },
    ]);
    matchTraceGeometryMock.mockResolvedValue([]);
    getRouteGeometryMock.mockRejectedValue(new Error("should not fallback"));

    const geometryUpsert = vi.fn();
    const runtime = {
      env: {
        gtfsShapesPath: tempDir,
        gtfsFeedUrl: "",
        osrmBusDistanceBaseUrl: "http://localhost:5001",
      },
      prisma: {
        routePattern: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "pattern-1",
              externalRouteId: "405320213",
              route: {
                shortName: "202",
              },
              stops: [
                {
                  stopId: "stop-a",
                  sequence: 1,
                  stop: {
                    id: "stop-a",
                    latitude: 33.5,
                    longitude: 126.5,
                    displayName: "Stop A",
                    translations: [],
                  },
                },
                {
                  stopId: "stop-b",
                  sequence: 2,
                  stop: {
                    id: "stop-b",
                    latitude: 33.51,
                    longitude: 126.52,
                    displayName: "Stop B",
                    translations: [],
                  },
                },
              ],
            },
          ]),
        },
        routePatternGeometry: {
          upsert: geometryUpsert,
        },
        routePatternStopProjection: {
          deleteMany: vi.fn(),
          createMany: vi.fn(),
        },
        routePatternStop: {
          updateMany: vi.fn(),
        },
      },
    } as never;

    const outcome = await runRouteGeometriesJob(runtime);

    expect(outcome.meta).toEqual(
      expect.objectContaining({
        busJejuLinkCount: 1,
        gtfsMatchCount: 0,
        fallbackCount: 0,
      }),
    );
    expect(geometryUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          sourceKind: "BUS_JEJU_LINK",
          shapeRef: "405320213",
        }),
      }),
    );
    expect(getRouteGeometryMock).not.toHaveBeenCalled();
  });
});
