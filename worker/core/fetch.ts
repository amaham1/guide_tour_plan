import fs from "node:fs/promises";
import path from "node:path";
import { Agent } from "undici";

const insecureDispatcher = new Agent({
  connect: {
    rejectUnauthorized: false,
  },
});

const DEFAULT_FETCH_TIMEOUT_MS = 25_000;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 300;

type QueryValue = string | number | undefined | null;

export function normalizeServiceKeyQueryValue(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function buildUrl(url: string, query?: Record<string, QueryValue>) {
  if (!query) {
    return url;
  }

  const nextUrl = new URL(url);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    const normalizedValue =
      typeof value === "string" && key.toLowerCase() === "servicekey"
        ? normalizeServiceKeyQueryValue(value)
        : String(value);

    nextUrl.searchParams.set(key, normalizedValue);
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
  const useInsecureFallback =
    url.includes("bus.jeju.go.kr") ||
    url.includes("jejudatahub.net") ||
    url.includes("api.visitjeju.net");
  const buildInit = (baseInit?: RequestInit, useInsecureDispatcher = false) => ({
    ...baseInit,
    cache: "no-store" as const,
    signal: baseInit?.signal ?? AbortSignal.timeout(DEFAULT_FETCH_TIMEOUT_MS),
    ...(useInsecureDispatcher ? ({ dispatcher: insecureDispatcher } as RequestInit) : {}),
  });
  const isRetryableError = (error: unknown) => {
    if (!(error instanceof Error)) {
      return false;
    }

    const message = `${error.name} ${error.message}`;
    return /abort|timeout|timed out|fetch failed|terminated|socket|network|und_err/i.test(message);
  };

  let lastError: unknown = null;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt += 1) {
    try {
      return await fetch(url, buildInit(init, useInsecureFallback && attempt > 0));
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === MAX_FETCH_ATTEMPTS - 1) {
        break;
      }

      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS * (attempt + 1)));
    }
  }

  throw lastError;
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
