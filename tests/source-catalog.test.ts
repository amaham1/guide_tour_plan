import { describe, expect, it } from "vitest";
import { sourceCatalog } from "@/lib/source-catalog";

describe("source catalog GNSS job policy", () => {
  it("keeps gnss-history active while disabling GNSS-derived jobs", () => {
    const gnssHistory = sourceCatalog.find((source) => source.key === "gnss-history");
    const segmentProfiles = sourceCatalog.find((source) => source.key === "segment-profiles");
    const osrmCustomize = sourceCatalog.find((source) => source.key === "osrm-bus-customize");

    expect(gnssHistory?.isActive ?? true).toBe(true);
    expect(segmentProfiles?.isActive).toBe(false);
    expect(segmentProfiles?.scheduleLabel).toBe("Disabled");
    expect(osrmCustomize?.isActive).toBe(false);
    expect(osrmCustomize?.scheduleLabel).toBe("Disabled");
  });
});
