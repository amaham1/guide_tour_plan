import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { probeGtfsSource } from "@/lib/gtfs";

const tempPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempPaths.splice(0).map(async (targetPath) => {
      await fs.rm(targetPath, {
        recursive: true,
        force: true,
      });
    }),
  );
});

describe("GTFS probe", () => {
  it("reports file coverage and row counts for directory feeds", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "gtfs-probe-"));
    tempPaths.push(tempDir);

    await fs.writeFile(
      path.join(tempDir, "routes.txt"),
      "route_id,route_short_name,route_long_name\nr1,202,Route 202\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "trips.txt"),
      "route_id,service_id,trip_id,shape_id\nr1,svc1,t1,s1\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "stop_times.txt"),
      "trip_id,arrival_time,departure_time,stop_id,stop_sequence\nt1,08:00:00,08:00:00,sA,1\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "stops.txt"),
      "stop_id,stop_name,stop_lat,stop_lon\nsA,Stop A,33.5,126.5\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(tempDir, "shapes.txt"),
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns1,33.5,126.5,1\ns1,33.6,126.6,2\n",
      "utf8",
    );

    const result = await probeGtfsSource(tempDir);

    expect(result.missingFiles).toEqual([]);
    expect(result.counts).toEqual({
      routes: 1,
      trips: 1,
      stopTimes: 1,
      stops: 1,
      shapes: 2,
    });
    expect(result.sampleRouteShortNames).toEqual(["202"]);
  });
});
