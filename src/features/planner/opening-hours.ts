import type { CandidateLeg, CandidateWarning } from "@/features/planner/types";

type OpeningRule = {
  days: number[];
  open: string;
  close: string;
};

type OpeningHoursJson = {
  alwaysOpen?: boolean;
  closedDays?: number[];
  rules?: OpeningRule[];
  note?: string;
  raw?: string;
};

type PlaceHoursContext = {
  id: string;
  displayName: string;
  openingHoursRaw: string | null;
  openingHoursJson: unknown;
};

function parseClockMinutes(value: string) {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function serviceMinutes(date: Date) {
  return date.getHours() * 60 + date.getMinutes();
}

function isOpeningHoursJson(value: unknown): value is OpeningHoursJson {
  return Boolean(value) && typeof value === "object";
}

export function buildOpeningHoursWarnings(
  places: Map<string, PlaceHoursContext>,
  legs: CandidateLeg[],
): CandidateWarning[] {
  const warnings: CandidateWarning[] = [];

  for (const leg of legs) {
    if (leg.kind !== "visit" || !leg.placeId) {
      continue;
    }

    const place = places.get(leg.placeId);
    if (!place) {
      continue;
    }

    const json = isOpeningHoursJson(place.openingHoursJson) ? place.openingHoursJson : null;
    if (!json || json.alwaysOpen) {
      continue;
    }

    const visitStart = new Date(leg.startAt);
    const visitEnd = new Date(leg.endAt);
    const day = visitStart.getDay();

    if (json.closedDays?.includes(day)) {
      warnings.push({
        code: "OPENING_HOURS_CONFLICT",
        message: `${place.displayName} 방문 시간이 휴무일과 겹칠 수 있습니다.`,
      });
      continue;
    }

    const matchingRule = json.rules?.find((rule) => rule.days.includes(day));
    if (!matchingRule) {
      continue;
    }

    const openMinutes = parseClockMinutes(matchingRule.open);
    const closeMinutes = parseClockMinutes(matchingRule.close);
    if (openMinutes === null || closeMinutes === null) {
      continue;
    }

    const visitStartMinutes = serviceMinutes(visitStart);
    const visitEndMinutes = serviceMinutes(visitEnd);

    if (visitStartMinutes < openMinutes || visitEndMinutes > closeMinutes) {
      const raw = place.openingHoursRaw ? ` (${place.openingHoursRaw})` : "";
      warnings.push({
        code: "OPENING_HOURS_CONFLICT",
        message: `${place.displayName} 체류 시간이 운영시간과 어긋날 수 있습니다${raw}.`,
      });
    }
  }

  return warnings;
}
