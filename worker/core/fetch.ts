import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";

const insecureDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

type QueryValue = string | number | undefined | null;

function buildUrl(url: string, query?: Record<string, QueryValue>) {
  if (!query) {
    return url;
  }

  const nextUrl = new URL(url);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    nextUrl.searchParams.set(key, String(value));
  }

  return nextUrl.toString();
}

export function isRemoteSource(source: string) {
  return /^https?:\/\//i.test(source);
}

export async function readLocalFile(source: string) {
  return fs.readFile(path.resolve(source));
}

async function fetchWithRetry(url: string, init?: RequestInit) {
  const buildInit = (baseInit?: RequestInit) => ({
    ...baseInit,
    cache: "no-store" as const,
    signal: baseInit?.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
  });

  try {
    return await fetch(url, {
      ...buildInit(init),
    });
  } catch (error) {
    if (
      url.includes("bus.jeju.go.kr") ||
      url.includes("jejudatahub.net") ||
      url.includes("api.visitjeju.net")
    ) {
      return fetch(url, {
        ...buildInit(init),
        dispatcher: insecureDispatcher,
      } as RequestInit);
    }

    throw error;
  }
}

export async function fetchBuffer(
  url: string,
  query?: Record<string, QueryValue>,
  init?: RequestInit,
) {
  const response = await fetchWithRetry(buildUrl(url, query), init);

  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText} for ${url}`);
  }

  return Buffer.from(await response.arrayBuffer());
}

export async function fetchPlainText(
  url: string,
  query?: Record<string, QueryValue>,
  init?: RequestInit,
) {
  const buffer = await fetchBuffer(url, query, {
    headers: {
      Accept: "application/json, text/plain, text/html, application/xml, text/xml, */*",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Codex/1.0",
      ...(init?.headers ?? {}),
    },
    ...init,
  });

  return buffer.toString("utf8");
}

export async function fetchJson<T>(
  url: string,
  query?: Record<string, QueryValue>,
  init?: RequestInit,
) {
  const text = await fetchPlainText(url, query, init);
  return JSON.parse(text) as T;
}
