import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("bus OSRM profile templates", () => {
  it("includes bus and psv access overrides", async () => {
    const profile = await fs.readFile(path.join(repoRoot, "docker", "osrm", "bus-distance.lua.tpl"), "utf8");

    expect(profile).toContain('profile.access_tag_whitelist["psv"] = true');
    expect(profile).toContain('profile.access_tag_whitelist["bus"] = true');
    expect(profile).toContain('"bus"');
    expect(profile).toContain('"psv"');
    expect(profile).toContain('highway == "busway"');
    expect(profile).toContain('profile.properties.weight_name = "distance"');
  });

  it("keeps bus eta profile on duration weights", async () => {
    const profile = await fs.readFile(path.join(repoRoot, "docker", "osrm", "bus-eta.lua.tpl"), "utf8");

    expect(profile).toContain('profile.properties.weight_name = "duration"');
    expect(profile).toContain("profile.turn_penalty = 9");
  });
});
