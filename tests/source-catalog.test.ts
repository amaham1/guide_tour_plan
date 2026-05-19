import { describe, expect, it } from "vitest";
import { sourceCatalog } from "@/lib/source-catalog";

describe("source catalog GNSS job policy", () => {
  it("enables observation jobs while keeping OSRM graph customization disabled", () => {
    const gnssHistory = sourceCatalog.find((source) => source.key === "gnss-history");
    const segmentProfiles = sourceCatalog.find((source) => source.key === "segment-profiles");
    const observedTimetables = sourceCatalog.find((source) => source.key === "observed-timetables");
    const osrmCustomize = sourceCatalog.find((source) => source.key === "osrm-bus-customize");

    expect(gnssHistory?.isActive ?? true).toBe(true);
    expect(segmentProfiles?.isActive ?? true).toBe(true);
    expect(segmentProfiles?.scheduleLabel).toBe("Hourly");
    expect(observedTimetables?.isActive ?? true).toBe(true);
    expect(observedTimetables?.scheduleLabel).toBe("Hourly");
    expect(osrmCustomize?.isActive).toBe(false);
    expect(osrmCustomize?.scheduleLabel).toBe("Disabled");
  });
});
