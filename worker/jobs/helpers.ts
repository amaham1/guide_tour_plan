import type { PrismaClient } from "@prisma/client";

export function normalizeText(value: unknown) {
  return String(value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeNameKey(value: unknown) {
  return normalizeText(value)
    .replace(/[()[\]]/g, "")
    .replace(/[\s\-_/]/g, "")
    .toLowerCase();
}

export function toSlug(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractArray<T = Record<string, unknown>>(value: unknown): T[] {
  if (Array.isArray(value)) {
    return value as T[];
  }

  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["items", "item", "data", "rows", "response", "body"]) {
      if (record[key]) {
        const nested = extractArray<T>(record[key]);
        if (nested.length > 0) {
          return nested;
        }
      }
    }
  }

  return [];
}

export function toNumber(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  const normalized = String(value ?? "")
    .replace(/,/g, "")
    .trim();

  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function toKoreanDate(value: string) {
  const match = value.match(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
  if (!match) {
    return null;
  }

  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day));
}

export function parseClockToMinutes(value: string | null | undefined) {
  const normalized = normalizeText(value).replace(/\./g, ":");
  const match = normalized.match(/(\d{1,2}):(\d{2})/);
  if (!match) {
    return null;
  }

  return Number(match[1]) * 60 + Number(match[2]);
}

function stripBracketedQualifiers(value: string) {
  return value
    .replace(/\[[^\]]+\]/g, " ")
    .replace(/\([^)]+\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripStopSuffixes(value: string) {
  return value.replace(
    /(환승정류장|버스정류장|정류장|버스터미널|터미널|회전교차로|종점|입구|경유)$/g,
    "",
  );
}

const stopNameAliasMap = new Map<string, string[]>([
  [normalizeNameKey("공항"), ["제주국제공항", "제주국제공항1", "제주국제공항2"]],
  [normalizeNameKey("성산"), ["성산환승정류장", "성산리", "성산항"]],
  [normalizeNameKey("성산포항"), ["성산항"]],
  [normalizeNameKey("봉개"), ["봉개환승정류장"]],
  [normalizeNameKey("송당"), ["송당환승정류장", "송당리"]],
  [normalizeNameKey("창천"), ["창천리"]],
  [normalizeNameKey("무릉"), ["무릉리"]],
  [normalizeNameKey("사계"), ["사계리"]],
  [normalizeNameKey("모슬"), ["모슬포"]],
  [normalizeNameKey("모슬포"), ["모슬포항"]],
  [normalizeNameKey("삼달"), ["삼달리"]],
]);

for (const [canonical, aliases] of [
  ["\uC81C\uC8FC\uD130\uBBF8\uB110", ["\uC81C\uC8FC\uBC84\uC2A4\uD130\uBBF8\uB110"]],
  ["\uC131\uC0B0\uD56D", ["\uC131\uC0B0\uD3EC\uD56D"]],
  ["\uC911\uC559\uB85C\uD130\uB9AC", ["\uC911\uC559R"]],
  ["\uC81C\uC8FC\uBBFC\uC18D\uCD0C", ["\uD45C\uC120(\uC81C\uC8FC\uBBFC\uC18D\uCD0C)"]],
  ["\uC81C\uC8FC\uB300\uD559\uAD50\uBCD1\uC6D0", ["\uC81C\uB300\uBCD1\uC6D0"]],
] as const) {
  const key = normalizeNameKey(canonical);
  const current = stopNameAliasMap.get(key) ?? [];
  stopNameAliasMap.set(key, [...new Set([...current, ...aliases])]);
}

function expandStopAliases(value: string) {
  const directKey = normalizeNameKey(value);
  const aliases = stopNameAliasMap.get(directKey) ?? [];
  return aliases.map((alias) => normalizeNameKey(alias)).filter(Boolean);
}

export function buildStopNameKeys(value: unknown) {
  const normalized = normalizeText(value).replace(/\//g, " ");

  if (!normalized) {
    return [];
  }

  const bracketless = normalizeText(stripBracketedQualifiers(normalized));
  const simplified = normalizeText(stripStopSuffixes(bracketless));
  const collapsed = normalizeText(simplified.replace(/\s+/g, ""));

  return [
    ...new Set([
      normalizeNameKey(normalized),
      normalizeNameKey(bracketless),
      normalizeNameKey(simplified),
      normalizeNameKey(collapsed),
      ...expandStopAliases(normalized),
      ...expandStopAliases(bracketless),
      ...expandStopAliases(simplified),
      ...expandStopAliases(collapsed),
    ]),
  ].filter(Boolean);
}

export function scoreStopNameMatch(left: unknown, right: unknown) {
  const leftKeys = buildStopNameKeys(left);
  const rightKeys = buildStopNameKeys(right);

  if (leftKeys.length === 0 || rightKeys.length === 0) {
    return 0;
  }

  if (leftKeys.some((key) => rightKeys.includes(key))) {
    return 100;
  }

  let bestPartialScore = 0;

  for (const leftKey of leftKeys) {
    for (const rightKey of rightKeys) {
      const shorter = leftKey.length <= rightKey.length ? leftKey : rightKey;
      const longer = leftKey.length <= rightKey.length ? rightKey : leftKey;

      if (shorter.length >= 2 && longer.includes(shorter)) {
        bestPartialScore = Math.max(
          bestPartialScore,
          Math.min(95, 50 + shorter.length * 10),
        );
      }
    }
  }

  return bestPartialScore;
}

export function minutesToClock(minutes: number) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return `${String(hours).padStart(2, "0")}:${String(mins).padStart(2, "0")}`;
}

export function median(values: number[]) {
  if (values.length === 0) {
    return null;
  }

  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }

  return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

export async function ensureDailyServiceCalendar(prisma: PrismaClient) {
  await prisma.serviceCalendar.upsert({
    where: {
      id: "svc-daily",
    },
    update: {
      label: "매일",
      weekdays: "MON,TUE,WED,THU,FRI,SAT,SUN",
    },
    create: {
      id: "svc-daily",
      label: "매일",
      weekdays: "MON,TUE,WED,THU,FRI,SAT,SUN",
    },
  });
}

export async function loadFirstAvailable<T>(
  sources: string[],
  loader: (source: string) => Promise<T>,
) {
  const errors: string[] = [];

  for (const source of sources) {
    if (!source) {
      continue;
    }

    try {
      const value = await loader(source);
      return { source, value };
    } catch (error) {
      errors.push(`${source}: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  throw new Error(errors.join("\n") || "No source candidate was available.");
}
