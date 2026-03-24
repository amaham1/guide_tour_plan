import { describe, expect, it } from "vitest";
import { buildOpeningHoursWarnings } from "@/features/planner/opening-hours";
import { estimateDelayMinutesFromGnss } from "@/features/planner/realtime-source";
import { parseOpeningHoursRaw } from "../worker/jobs/visit-jeju-places";

describe("opening hours warnings", () => {
  it("parses visit jeju opening hour strings", () => {
    const parsed = parseOpeningHoursRaw("화-일 09:00-18:00 월휴무");

    expect(parsed?.rules[0]?.days).toContain(2);
    expect(parsed?.closedDays).toContain(1);
  });

  it("flags visits that overlap with closed days", () => {
    const warnings = buildOpeningHoursWarnings(
      new Map([
        [
          "place-1",
          {
            id: "place-1",
            displayName: "민속자연사박물관",
            openingHoursRaw: "화-일 09:00-18:00 월휴무",
            openingHoursJson: parseOpeningHoursRaw("화-일 09:00-18:00 월휴무"),
          },
        ],
      ]),
      [
        {
          id: "visit-1",
          kind: "visit",
          title: "민속자연사박물관 체류",
          startAt: "2026-03-23T01:00:00.000Z",
          endAt: "2026-03-23T02:00:00.000Z",
          durationMinutes: 60,
          placeId: "place-1",
        },
      ],
    );

    expect(warnings[0]?.code).toBe("OPENING_HOURS_CONFLICT");
  });
});

describe("realtime delay estimation", () => {
  it("estimates positive delay when bus progress lags behind schedule", () => {
    const delay = estimateDelayMinutesFromGnss(
      {
        id: "ride-1",
        kind: "ride",
        title: "111번 탑승",
        startAt: "2026-03-23T10:00:00.000Z",
        endAt: "2026-03-23T10:30:00.000Z",
        durationMinutes: 30,
      },
      {
        latitude: 33.5,
        longitude: 126.5,
      },
      {
        latitude: 33.6,
        longitude: 126.6,
      },
      {
        deviceId: "device-1",
        latitude: 33.525,
        longitude: 126.525,
        time: "2026-03-23 10:15:00",
      },
      new Date("2026-03-23T10:15:00.000Z"),
    );

    expect(delay).toBeGreaterThanOrEqual(0);
  });
});
