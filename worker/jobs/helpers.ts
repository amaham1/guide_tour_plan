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
    .replace(/\uB85C\uD0C0\uB9AC/g, "\uB85C\uD130\uB9AC")
    .replace(/[()[\]]/g, "")
    .replace(/[\s\-_/]/g, "")
    .toLowerCase();
}

export function toSlug(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\u3131-\u318E\uAC00-\uD7A3]+/g, "-")
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
  return value
    .replace(
      /(?:\uD658\uC2B9\uC815\uB958\uC7A5|\uBC84\uC2A4\uC815\uB958\uC7A5|\uC815\uB958\uC7A5|\uC815\uB958\uC18C|\uC885\uC810|\uACBD\uC720|\uC2B9\uCC28\uC7A5)$/g,
      "",
    )
    .trim();
}

function normalizeTokenKey(value: string) {
  return normalizeNameKey(value).replace(/^제(?=\d)/, "");
}

function buildTokenSetKeys(value: string) {
  const tokenSource = normalizeText(value)
    .replace(/[()[\]]/g, " ")
    .replace(/\//g, " ");
  const tokens = tokenSource
    .split(/\s+/)
    .map((token) => stripStopSuffixes(token))
    .map((token) => normalizeTokenKey(token))
    .filter((token) => token.length >= 2);

  if (tokens.length < 2) {
    return [];
  }

  return [[...new Set(tokens)].sort().join("|")];
}

function buildCommonShorthandKeys(value: string) {
  const normalized = normalizeText(value);

  if (!normalized) {
    return [];
  }

  const keys = new Set<string>();
  const normalizedKey = normalizeNameKey(normalized);
  const variants = [
    normalized.replace(/초교\b/gu, "초등학교"),
    normalized.replace(/케이트볼장/gu, "게이트볼장"),
  ];

  if (normalizedKey.endsWith("a") && normalizedKey.length > 1) {
    keys.add(`${normalizedKey.slice(0, -1)}아파트`);
  }

  if (normalizedKey.endsWith("r") && normalizedKey.length > 1) {
    keys.add(`${normalizedKey.slice(0, -1)}로터리`);
    keys.add(`${normalizedKey.slice(0, -1)}사거리`);
  }

  for (const variant of variants) {
    const next = normalizeText(variant);
    if (!next || next === normalized) {
      continue;
    }

    keys.add(normalizeNameKey(next));
    for (const tokenKey of buildTokenSetKeys(next)) {
      keys.add(tokenKey);
    }
  }

  return [...keys].filter(Boolean);
}

const stopNameAliasMap = new Map<string, string[]>();

function registerStopAliases(
  canonical: string,
  aliases: readonly string[],
  options: { bidirectional?: boolean } = {},
) {
  const canonicalKey = normalizeNameKey(canonical);
  const current = stopNameAliasMap.get(canonicalKey) ?? [];
  stopNameAliasMap.set(canonicalKey, [...new Set([...current, ...aliases])]);

  if (!options.bidirectional) {
    return;
  }

  for (const alias of aliases) {
    const aliasKey = normalizeNameKey(alias);
    const next = stopNameAliasMap.get(aliasKey) ?? [];
    stopNameAliasMap.set(aliasKey, [...new Set([...next, canonical])]);
  }
}

for (const [canonical, aliases] of [
  [
    "\uACF5\uD56D",
    [
      "\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D",
      "\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D1",
      "\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D2",
    ],
  ],
  [
    "\uC131\uC0B0",
    [
      "\uC131\uC0B0\uD658\uC2B9\uC815\uB958\uC7A5",
      "\uC131\uC0B0\uB9AC",
    ],
  ],
  ["\uC131\uC0B0\uD3EC\uD56D", ["\uC131\uC0B0\uD56D"]],
  [
    "\uD568\uB355",
    [
      "\uD568\uB355\uD658\uC2B9\uC815\uB958\uC7A5",
      "\uD568\uB355\uB9AC",
    ],
  ],
  ["\uCC3D\uCC9C", ["\uCC3D\uCC9C\uB9AC"]],
  ["\uBB34\uB989", ["\uBB34\uB989\uB9AC"]],
  ["\uAD6C\uC88C", ["\uAD6C\uC88C\uB9AC"]],
  ["\uBAA8\uC2AC\uD3EC\uD56D", ["\uBAA8\uC2AC\uD3EC\uB0A8\uD56D"]],
  ["\uC6D4\uC815", ["\uC6D4\uC815\uB9AC"]],
  ["\uC1A1\uB2F9", ["\uC1A1\uB2F9\uB85C\uD0C0\uB9AC"]],
  ["\uBD09\uAC1C", ["\uBD09\uAC1C\uB3D9"]],
  ["\uAD50\uB798", ["\uAD50\uB798\uC0AC\uAC70\uB9AC"]],
  ["\uB300\uCC9C\uB3D9", ["\uB300\uCC9C\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uD45C\uC120", ["\uD45C\uC120\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uC131\uC74D1\uB9AC", ["\uC131\uC74D\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uD558\uADC0", ["\uD558\uADC0\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uD558\uADC0\uD558\uB098\uB85C\uB9C8\uD2B8", ["\uD558\uADC0\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uC624\uC77C\uC2DC\uC7A5", ["\uC81C\uC8FC\uBBFC\uC18D\uC624\uC77C\uC7A5"]],
  ["\uC11C\uADC0\uD3EC\uC911\uC559\uB85C\uD130\uB9AC", ["\uC911\uC559\uB85C\uD130\uB9AC"]],
  ["\uC81C\uC8FC\uD130\uBBF8\uB110", ["\uC81C\uC8FC\uBC84\uC2A4\uD130\uBBF8\uB110"]],
  ["\uC131\uC0B0\uD56D", ["\uC131\uC0B0\uD3EC\uD56D"]],
  ["\uC911\uC559\uB85C\uD130\uB9AC", ["\uC911\uC559R"]],
  [
    "\uC81C\uC8FC\uBBFC\uC18D\uCD0C",
    ["\uD45C\uC120(\uC81C\uC8FC\uBBFC\uC18D\uCD0C)"],
  ],
  [
    "\uC81C\uC8FC\uB300\uD559\uAD50\uBCD1\uC6D0",
    ["\uC81C\uB300\uBCD1\uC6D0", "\uC81C\uC8FC\uB300\uD559\uBCD1\uC6D0"],
  ],
  ["\uC218\uB9DD\uB9AC", ["\uC218\uB9DD\uAC00\uB984"]],
  ["\uD55C\uB9BC\uACF5\uACE0", ["\uD55C\uB9BC\uD56D\uACF5\uC6B0\uC8FC\uACE0\uB4F1\uD559\uAD50"]],
  ["\uC81C\uC8FC\uC5EC\uC911\uACE0", ["\uC81C\uC8FC\uC5EC\uC790\uC911\uACE0\uB4F1\uD559\uAD50"]],
  ["\uC0BC\uC591\uCD08\uAD50", ["\uC0BC\uC591\uCD08\uB4F1\uD559\uAD50"]],
  ["\uC678\uB3C4\uCD08\uAD50", ["\uC678\uB3C4\uCD08\uB4F1\uD559\uAD50"]],
  ["\uD558\uADC0\uCD08\uAD50", ["\uD558\uADC0\uCD08\uB4F1\uD559\uAD50"]],
  ["\uC81C\uC8FC\uACF5\uD56D", ["\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D", "\uACF5\uD56D"]],
  [
    "\uC11C\uADC0\uD3EC\uC2DC\uCCAD 2\uCCAD\uC0AC(\uC11C\uADC0\uD3EC\uC6B0\uCCB4\uAD6D)",
    ["\uC11C\uADC0\uD3EC\uC6B0\uCCB4\uAD6D \uC11C\uADC0\uD3EC\uC2DC\uCCAD \uC81C2\uCCAD\uC0AC"],
  ],
  ["\uD654\uBD81\uC8FC\uACF5 \uC785\uAD6C", ["\uD654\uBD81\uC8FC\uACF5\uC544\uD30C\uD2B8\uC785\uAD6C"]],
  ["\uB178\uD615\uC624\uAC70\uB9AC", ["\uB178\uD615\uC624\uAC70\uB9AC/\uC774\uB9C8\uD2B8"]],
  ["\uC81C\uC8FC \uBCC4\uBE5B\uB204\uB9AC\uACF5\uC6D0", ["\uBCC4\uBE5B\uB204\uB9AC\uACF5\uC6D0/\uB09C\uD0C0\uACF5\uC5F0\uC7A5"]],
  [
    "\uC11C\uADC0\uD3EC\uD130\uBBF8\uB110 \uC55E(\uC6D4\uB4DC\uCEF5\uACBD\uAE30\uC7A5)",
    ["\uC81C\uC8FC\uC6D4\uB4DC\uCEF5\uACBD\uAE30\uC7A5 \uC11C\uADC0\uD3EC\uBC84\uC2A4\uD130\uBBF8\uB110"],
  ],
  [
    "\uC81C\uC8FC\uC5EC\uACE0(\uC815\uBB38)",
    [
      "\uC81C\uC8FC\uC5EC\uC790\uC911\uACE0\uB4F1\uD559\uAD50",
      "\uC81C\uC8FC\uC5EC\uC790\uC911\uACE0\uB4F1\uD559\uAD50/\uC81C\uC8FC\uC9C0\uBC29\uD574\uC591\uACBD\uCC30\uCCAD",
    ],
  ],
  [
    "\uD558\uADC0\uD734\uBA3C\uC2DC\uC544 \uC544\uD30C\uD2B8",
    [
      "\uD558\uADC0\uD734\uBA3C\uC2DC\uC544\uC785\uAD6C",
      "\uD558\uADC0\uD734\uBA3C\uC2DC\uC544 2\uB2E8\uC9C0 \uC55E",
      "\uD558\uADC0\uD734\uBA3C\uC2DC\uC544 1\uB2E8\uC9C0",
    ],
  ],
  [
    "\uC774\uB3C4 \uC8FC\uACF5\uC544\uD30C\uD2B8",
    [
      "\uC774\uB3C4\uCD08\uB4F1\uD559\uAD50",
      "\uC774\uB3C4\uADFC\uB9B0\uACF5\uC6D0",
      "\uD61C\uC131\uBB34\uC9C0\uAC1C\uD0C0\uC6B4",
    ],
  ],
  ["\uB300\uC720\uB300\uB9BC", ["\uB300\uC720\uB300\uB9BC\uC544\uD30C\uD2B8", "\uB300\uB9BC\uC544\uD30C\uD2B8"]],
  ["\uC624\uD604\uACE0", ["\uC624\uD604\uC911\uACE0\uB4F1\uD559\uAD50"]],
  ["\uC0AC\uB300\uBD80\uC18D \uACE0\uB4F1\uD559\uAD50", ["\uC0AC\uB300\uBD80\uACE0"]],
  ["\uD55C\uB77C\uB300\uD559", ["\uC81C\uC8FC\uD55C\uB77C\uB300\uD559\uAD50", "\uD55C\uB77C\uB300"]],
  ["\uC778\uC81C", ["\uC778\uC81C(\uCC9C\uC218\uB3D9)"]],
  ["\uC2E0\uC0B0\uB9AC", ["\uC2E0\uC0B0\uD401\uB0AD\uAC70\uB9AC"]],
  ["\uC0BC\uB2EC\uB9AC", ["\uC0BC\uB2EC2\uB9AC\uC0AC\uBB34\uC18C", "\uC0BC\uB2EC1\uB9AC"]],
  ["\uC2E0\uD654\uC5ED\uC0AC\uACF5\uC6D0", ["\uC81C\uC8FC\uC2E0\uD654\uC6D4\uB4DC \uC785\uAD6C", "\uC2E0\uD654\uC6D4\uB4DC\uB9AC\uC870\uD2B8"]],
  ["\uBCF4\uC131\uB9AC \uB300\uC815\uB18D\uD611", ["\uB300\uC815\uB18D\uD611\uD558\uB098\uB85C\uB9C8\uD2B8"]],
  ["신제주R", ["제주도청 신제주로터리"]],
  ["용문R", ["용문사거리"]],
  ["노형R", ["노형오거리", "노형오거리/이마트"]],
  ["광양", ["광양/시민회관방면", "동광양"]],
  ["연동대림A", ["연동대림1차아파트"]],
  ["중앙고", ["제주중앙고등학교"]],
  ["신고", ["신성여자중고등학교"]],
  ["여고", ["제주여자중고등학교", "서귀포여자고등학교"]],
  ["서귀포 여고", ["서귀포여자고등학교"]],
  ["서귀여고", ["서귀포여자고등학교"]],
  ["여상", ["제주여자상업고등학교"]],
  ["제대", ["제주대학교"]],
  ["중앙여중", ["제주중앙여자중학교", "제주중앙여자중학교/한국 소방안전원"]],
  ["한라중학교", ["한라중학교/부영아파트"]],
  ["GM 빌라", ["GM빌라"]],
  ["서중", ["제주서중학교"]],
  ["탐라도서관", ["한라도서관"]],
  ["서해A", ["서해아파트"]],
  ["대림A", ["대림아파트", "연동대림1차아파트", "대림2차아파트"]],
  ["한마음병원", ["한마음근린공원"]],
  ["이도주공", ["이도초등학교", "이도근린공원", "혜성무지개타운"]],
  ["보건소", ["제주보건소 정문", "서귀포보건소"]],
  ["중앙로사거리", ["중앙로 제민신협본점", "중앙로(현대약국)", "중앙로(중앙성당)"]],
  ["중앙로 사거리", ["중앙로 제민신협본점", "중앙로(현대약국)", "중앙로(중앙성당)"]],
  ["동문 로타리", ["동문로터리"]],
  ["중앙 로터리", ["중앙로터리", "중앙로터리/제주권역재활병원"]],
  ["서귀포 등기소", ["서귀포환승정류장(서귀포등기소)"]],
  ["시청 2청사", ["서귀포우체국 서귀포시청 제2청사", "서귀포시청 2청사(서귀포우체국)"]],
  ["공무원 연금공단", ["공무원연금공단"]],
  ["천지연", ["천지연폭포"]],
  ["서문로터리", ["서문로터리입구", "구 터미널", "서귀포농협"]],
  ["서귀여중", ["서귀포여자중학교"]],
  ["토평 마을회관", ["토평마을회관/서귀포교육지원청", "토평반석타운"]],
  ["토평초교", ["토평초등학교"]],
  ["하례2리 입구", ["하례2리입구"]],
  ["서귀포 농업기술센터", ["서귀포농업기술센터"]],
  ["서귀포농업 기술센터", ["서귀포농업기술센터"]],
  ["공영버스 차고지입구", ["공영버스 차고지", "공업단지 입구"]],
  ["신례리", ["신례초등학교", "신례하동"]],
  ["하효", ["신효동", "효돈초등학교"]],
  ["세기 아파트", ["세기아파트"]],
  ["오일장", ["제주민속오일장", "서귀포향토오일시장"]],
  ["오일시장", ["제주민속오일장", "서귀포향토오일시장"]],
  ["중문 우체국", ["중문환승정류장(중문우체국)"]],
  ["중문우체국", ["중문환승정류장(중문우체국)"]],
  ["회수", ["회수마을회관", "회수사거리", "회수사거리, 연화빌"]],
  ["법환농협", ["법환초등학교", "켄싱턴리조트 악근천"]],
  ["강정초교", ["강정초등학교"]],
  ["주공3.4단지", ["주공 3 4단지", "주공3/4단지"]],
  ["대포항", ["대포포구"]],
  ["중문 게이트볼장", ["중문게이트볼장", "중문요양원"]],
  ["중문 케이트볼장", ["중문게이트볼장", "중문요양원"]],
  ["월평마을", ["월평알동네", "월평 아왜낭목"]],
  ["제주대병원", ["제주대학교병원"]],
  ["제주대학교 병원", ["제주대학교병원"]],
  ["성읍 1리", ["성읍1리"]],
  ["오설록", ["제주오설록 티뮤지엄"]],
  ["청수 마을회관", ["청수마을회관"]],
  ["저지리 사무소", ["저지리사무소"]],
  ["한경면 사무소", ["한경면사무소"]],
  ["동광", ["동광육거리", "동광환승정류장2(영어교육도시방면)"]],
  ["명리동", ["명리동알동네"]],
] as const) {
  registerStopAliases(canonical, aliases);
}

for (const [canonical, aliases] of [
  ["\uACF5\uD56D", ["\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D"]],
  ["\uC81C\uC8FC\uD130\uBBF8\uB110", ["\uC81C\uC8FC\uBC84\uC2A4\uD130\uBBF8\uB110"]],
  ["\uC131\uC0B0\uD3EC\uD56D", ["\uC131\uC0B0\uD56D"]],
  ["\uC1A1\uB2F9", ["\uC1A1\uB2F9\uB85C\uD0C0\uB9AC"]],
  ["\uBD09\uAC1C", ["\uBD09\uAC1C\uB3D9"]],
  ["\uAD50\uB798", ["\uAD50\uB798\uC0AC\uAC70\uB9AC"]],
  ["\uD45C\uC120", ["\uD45C\uC120\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uC131\uC74D1\uB9AC", ["\uC131\uC74D\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uD558\uADC0", ["\uD558\uADC0\uD658\uC2B9\uC815\uB958\uC7A5"]],
  ["\uC624\uC77C\uC2DC\uC7A5", ["\uC81C\uC8FC\uBBFC\uC18D\uC624\uC77C\uC7A5"]],
  ["\uC218\uB9DD\uB9AC", ["\uC218\uB9DD\uAC00\uB984"]],
  ["\uD55C\uB9BC\uACF5\uACE0", ["\uD55C\uB9BC\uD56D\uACF5\uC6B0\uC8FC\uACE0\uB4F1\uD559\uAD50"]],
  ["\uC81C\uC8FC\uC5EC\uC911\uACE0", ["\uC81C\uC8FC\uC5EC\uC790\uC911\uACE0\uB4F1\uD559\uAD50"]],
  ["\uC0BC\uC591\uCD08\uAD50", ["\uC0BC\uC591\uCD08\uB4F1\uD559\uAD50"]],
  ["\uC678\uB3C4\uCD08\uAD50", ["\uC678\uB3C4\uCD08\uB4F1\uD559\uAD50"]],
  ["\uD558\uADC0\uCD08\uAD50", ["\uD558\uADC0\uCD08\uB4F1\uD559\uAD50"]],
  ["\uC81C\uC8FC\uACF5\uD56D", ["\uC81C\uC8FC\uAD6D\uC81C\uACF5\uD56D", "\uACF5\uD56D"]],
  ["\uC81C\uC8FC\uB300\uD559\uAD50", ["\uC81C\uC8FC\uB300"]],
  ["\uC81C\uC8FC\uD55C\uB77C\uB300\uD559\uAD50", ["\uD55C\uB77C\uB300"]],
  ["\uC11C\uADC0\uD3EC\uBC84\uC2A4\uD130\uBBF8\uB110", ["\uC11C\uADC0\uD3EC \uBC84\uC2A4\uD130\uBBF8\uB110"]],
  ["\uC11C\uADC0\uD3EC\uC911\uC559\uB85C\uD130\uB9AC", ["\uC11C\uADC0\uD3EC\uC911\uC559 \uB85C\uD130\uB9AC(\uC11C)"]],
  [
    "\uC81C\uC8FC\uB3C4\uCCAD(\uC2E0\uC81C\uC8FC\uB85C\uD130\uB9AC)",
    [
      "\uC81C\uC8FC\uB3C4\uCCAD(\uC2E0\uC81C\uC8FC\uB85C\uD0C0\uB9AC)",
      "\uC81C\uC8FC\uB3C4\uCCAD (\uC2E0\uC81C\uC8FC\uB85C\uD0C0\uB9AC)",
    ],
  ],
  ["\uC6A9\uB2F4\uC0AC\uAC70\uB9AC", ["\uC6A9\uB2F4 \uC0AC\uAC70\uB9AC"]],
] as const) {
  registerStopAliases(canonical, aliases, { bidirectional: true });
}

for (const [canonical, aliases] of [
  ["도립미술관", ["제주도립미술관입구"]],
  ["중문사거리", ["중문동주민센터"]],
  ["이호태우 해수욕장", ["이호테우해수욕장"]],
  ["이호태우해수욕장", ["이호테우해수욕장"]],
  ["다호 마을", ["다호마을"]],
  ["그레이 스호텔", ["명주주택"]],
  ["그레이스호텔", ["명주주택"]],
  ["도평동", ["도평마을입구", "도평동"]],
  ["신성 여고", ["신성여자중고등학교"]],
  ["신성여고", ["신성여자중고등학교"]],
  ["수협 도지회", ["수협제주도지회"]],
  ["수협도지회", ["수협제주도지회"]],
  ["온난화센터", ["온난화대응농업연구소"]],
  ["온난화 센터", ["온난화대응농업연구소"]],
  ["삼성여고", ["삼성여자고등학교"]],
  ["구터미널", ["구 터미널", "서귀포시 구 버스터미널"]],
  ["남주고", ["남주중고등학교"]],
  ["남군농협", ["NH농협 남제주지점", "서귀포농협"]],
  ["회수사거리", ["회수사거리, 연화빌"]],
  ["월평", ["월평 회차지(출발지)", "월평마을"]],
  ["신사동종점", ["신사동"]],
  ["서귀포오일장", ["서귀포향토오일시장"]],
  ["토평", ["토평초등학교", "토평 보목입구"]],
  ["동광육거리(동광환승정류장)", ["동광육거리", "동광환승정류장2(영어교육도시방면)", "동광환승정류장5(서귀방면)"]],
  ["서귀포중앙로터리", ["중앙로터리/제주권역재활병원"]],
  ["비석거리", ["비석거리(오희준로)", "비석거리 교차로"]],
  ["제주도청(신제주로터리)", ["제주도청 신제주로터리"]],
  ["대정읍사무소", ["대정환승정류장(대정읍사무소)"]],
  ["농공단지", ["대정농공단지", "대정농공단지입구"]],
  ["고산1리 (고산성당)", ["고산환승정류장(고산1리 고산성당 앞)", "고산환승정류장(고산1리)"]],
  ["서귀포 여중", ["서귀포여자중학교"]],
] as const) {
  registerStopAliases(canonical, aliases);
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
      ...buildCommonShorthandKeys(normalized),
      ...buildCommonShorthandKeys(bracketless),
      ...buildCommonShorthandKeys(simplified),
      ...buildTokenSetKeys(normalized),
      ...buildTokenSetKeys(bracketless),
      ...buildTokenSetKeys(simplified),
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
      label: "\uB9E4\uC77C",
      weekdays: "MON,TUE,WED,THU,FRI,SAT,SUN",
    },
    create: {
      id: "svc-daily",
      label: "\uB9E4\uC77C",
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
