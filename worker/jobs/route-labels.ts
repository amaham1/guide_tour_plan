import { normalizeText } from "@/worker/jobs/helpers";

const explicitTokenPattern = /\d{2,4}(?:-\d+)?/g;
const shorthandBranchPattern = /(\d{2,4})-((?:\d+\s*[,/]\s*)+\d+)(?=\D|$)/g;

function normalizeRouteToken(value: string) {
  return normalizeText(value).replace(/[^0-9-]/g, "");
}

export function extractRouteShortNameTokens(value: string) {
  const normalized = normalizeText(value);
  const tokens = new Set<string>();

  for (const match of normalized.matchAll(shorthandBranchPattern)) {
    const [, base, branchList] = match;
    for (const branch of branchList.split(/[,\s/]+/).filter(Boolean)) {
      tokens.add(`${base}-${branch}`);
    }
  }

  for (const match of normalized.matchAll(explicitTokenPattern)) {
    const token = normalizeRouteToken(match[0]);
    if (/^\d{2,4}(?:-\d+)?$/.test(token)) {
      tokens.add(token);
    }
  }

  return [...tokens].filter((token) => !/^\d$/.test(token));
}

export function extractPrimaryRouteShortNameToken(value: string | null | undefined) {
  return extractRouteShortNameTokens(value ?? "")[0] ?? null;
}

export function buildRouteMatchKeys(value: string) {
  const normalized = normalizeText(value);
  const keys = new Set<string>();

  if (normalized) {
    keys.add(normalized);
  }

  for (const token of extractRouteShortNameTokens(normalized)) {
    keys.add(token);
  }

  return [...keys];
}

export function buildRouteLookupKeys(value: string) {
  const keys = new Set(buildRouteMatchKeys(value));

  for (const token of extractRouteShortNameTokens(value)) {
    if (token.includes("-")) {
      keys.add(token.split("-")[0]);
    }
  }

  return [...keys];
}
