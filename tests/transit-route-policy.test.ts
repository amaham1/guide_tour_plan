import { describe, expect, it } from "vitest";
import {
  isExcludedTransitRoute,
  isExcludedTransitRouteLabel,
} from "@/lib/transit-route-policy";

describe("transit route policy", () => {
  it("treats observer, temporary, and village-style routes as excluded", () => {
    expect(
      isExcludedTransitRouteLabel("711-2\uBC88(\uC635\uC11C\uBC84\uC2A4)"),
    ).toBe(true);
    expect(isExcludedTransitRouteLabel("\uC784\uC2DC 202-1")).toBe(true);
    expect(
      isExcludedTransitRouteLabel(
        "921 \uC6B0\uB3C4\uB9C8\uC744\uBC84\uC2A4(\uD574\uC548\uB3C4\uB85C \uC21C\uD658)",
      ),
    ).toBe(true);
    expect(
      isExcludedTransitRouteLabel(
        "\uB3D9\uBCF5\uB9AC\uB9C8\uC744\uBC84\uC2A4(900\uBC88)",
      ),
    ).toBe(true);
    expect(
      isExcludedTransitRoute([
        "771-2",
        "771-2 \uC635\uC11C\uBC84\uC2A4 \uC2DC\uAC04\uD45C",
      ]),
    ).toBe(true);
  });

  it("keeps ordinary numbered routes eligible", () => {
    expect(isExcludedTransitRouteLabel("201")).toBe(false);
    expect(isExcludedTransitRouteLabel("202")).toBe(false);
    expect(isExcludedTransitRoute(["771-2", "771-2"])).toBe(false);
  });
});
