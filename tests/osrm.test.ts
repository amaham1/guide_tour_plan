import { afterEach, describe, expect, it, vi } from "vitest";
import { getWalkRoute } from "@/lib/osrm";

describe("OSRM route errors", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("surfaces the network cause when the OSRM server is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("connect ECONNREFUSED"));

    await expect(
      getWalkRoute(
        "http://localhost:5000",
        { latitude: 33.5, longitude: 126.5 },
        { latitude: 33.51, longitude: 126.51 },
      ),
    ).rejects.toMatchObject({
      status: 503,
      code: "DEPENDENCY_UNAVAILABLE",
    });

    await expect(
      getWalkRoute(
        "http://localhost:5000",
        { latitude: 33.5, longitude: 126.5 },
        { latitude: 33.51, longitude: 126.51 },
      ),
    ).rejects.toThrow("connect ECONNREFUSED");
  });

  it("surfaces the upstream response body when OSRM returns an error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("profile not found", {
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(
      getWalkRoute(
        "http://localhost:5000",
        { latitude: 33.5, longitude: 126.5 },
        { latitude: 33.51, longitude: 126.51 },
      ),
    ).rejects.toThrow("profile not found");
  });

  it("classifies NoRoute payloads as route-not-found errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "NoRoute", routes: [] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

    await expect(
      getWalkRoute(
        "http://localhost:5000",
        { latitude: 33.5, longitude: 126.5 },
        { latitude: 33.51, longitude: 126.51 },
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "ROUTE_NOT_FOUND",
    });
  });

  it("accepts zero-distance responses and normalizes them to at least one minute", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ code: "Ok", routes: [{ distance: 0, duration: 0 }] }), {
        status: 200,
        headers: {
          "Content-Type": "application/json",
        },
      }),
    );

    await expect(
      getWalkRoute(
        "http://localhost:5000",
        { latitude: 33.5, longitude: 126.5 },
        { latitude: 33.5, longitude: 126.5 },
      ),
    ).resolves.toEqual({
      distanceMeters: 0,
      durationMinutes: 1,
    });
  });
});
