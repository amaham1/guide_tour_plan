import { describe, expect, it } from "vitest";
import { collectTurnTriples } from "@/worker/jobs/segment-profiles";

describe("segment profile helpers", () => {
  it("extracts unique turn triples from matched OSRM node lists", () => {
    expect(collectTurnTriples([10, 11, 12, 13])).toEqual([
      {
        fromOsmNodeId: "10",
        viaOsmNodeId: "11",
        toOsmNodeId: "12",
      },
      {
        fromOsmNodeId: "11",
        viaOsmNodeId: "12",
        toOsmNodeId: "13",
      },
    ]);
  });

  it("collapses consecutive duplicate nodes before building turn triples", () => {
    expect(collectTurnTriples([10, 10, 11, 12, 12, 13, 13])).toEqual([
      {
        fromOsmNodeId: "10",
        viaOsmNodeId: "11",
        toOsmNodeId: "12",
      },
      {
        fromOsmNodeId: "11",
        viaOsmNodeId: "12",
        toOsmNodeId: "13",
      },
    ]);
  });
});
