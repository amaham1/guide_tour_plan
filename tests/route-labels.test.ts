import { describe, expect, it } from "vitest";
import {
  buildRouteMatchKeys,
  buildRouteLookupKeys,
  extractRouteShortNameTokens,
} from "../worker/jobs/route-labels";

describe("route label helpers", () => {
  it("extracts atomic route numbers from combined labels", () => {
    expect(extractRouteShortNameTokens("121번/122")).toEqual(["121", "122"]);
    expect(extractRouteShortNameTokens("251번/251-1번252번/253번/254")).toEqual([
      "251",
      "251-1",
      "252",
      "253",
      "254",
    ]);
  });

  it("expands shorthand branch labels", () => {
    expect(extractRouteShortNameTokens("704-1,3번(옵서버스)")).toEqual([
      "704-1",
      "704-3",
    ]);
  });

  it("builds exact match keys without broadening to sibling branches", () => {
    expect(buildRouteMatchKeys("500-2")).toEqual(["500-2"]);
    expect(buildRouteMatchKeys("수요맞춤형 111-1")).toEqual([
      "수요맞춤형 111-1",
      "111-1",
    ]);
  });

  it("builds lookup keys with both exact and base tokens for search expansion", () => {
    expect(buildRouteLookupKeys("500-2")).toEqual(["500-2", "500"]);
    expect(buildRouteLookupKeys("수요맞춤형 111-1")).toEqual([
      "수요맞춤형 111-1",
      "111-1",
      "111",
    ]);
  });
});
