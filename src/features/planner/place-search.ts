import { appEnv } from "@/lib/env";
import {
  DependencyUnavailableError,
  UpstreamServiceError,
} from "@/lib/errors";
import type { SearchResultDto } from "@/features/planner/types";

type KakaoKeywordDocument = {
  id: string;
  place_name: string;
  category_name?: string;
  category_group_name?: string;
  category_group_code?: string;
  phone?: string;
  address_name?: string;
  road_address_name?: string;
  x: string;
  y: string;
  place_url?: string;
};

type KakaoKeywordResponse = {
  documents?: KakaoKeywordDocument[];
};

const JEJU_RECT = "126.08,33.10,126.98,33.58";

function compactErrorDetail(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 240);
}

function buildRegionName(document: KakaoKeywordDocument) {
  const baseAddress = document.road_address_name || document.address_name || "제주";
  const segments = baseAddress.split(/\s+/).filter(Boolean);
  return segments.slice(0, 3).join(" ") || "제주";
}

function buildCategoryLabel(document: KakaoKeywordDocument) {
  const segments = (document.category_name ?? "")
    .split(" > ")
    .map((segment) => segment.trim())
    .filter(Boolean);

  return (
    segments.at(-1) ||
    document.category_group_name ||
    (document.category_group_code === "AT4" ? "관광명소" : "장소")
  );
}

export async function searchKakaoPlaces(
  query: string,
  limit: number,
): Promise<SearchResultDto[]> {
  if (!appEnv.kakaoRestApiKey) {
    return [];
  }

  const requestUrl = new URL("https://dapi.kakao.com/v2/local/search/keyword.json");
  requestUrl.searchParams.set("query", query);
  requestUrl.searchParams.set("size", String(Math.min(Math.max(limit, 1), 15)));
  requestUrl.searchParams.set("rect", JEJU_RECT);

  let response: Response;

  try {
    response = await fetch(requestUrl, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `KakaoAK ${appEnv.kakaoRestApiKey}`,
      },
    });
  } catch (error) {
    const cause = error instanceof Error ? error.message : "unknown network error";
    throw new DependencyUnavailableError(
      `Kakao 장소 검색 API에 연결하지 못했습니다. 원인: ${cause}`,
    );
  }

  if (!response.ok) {
    const bodyText = compactErrorDetail(await response.text());
    throw new UpstreamServiceError(
      `Kakao 장소 검색이 실패했습니다 (${response.status} ${response.statusText}).${bodyText ? ` 원인: ${bodyText}` : ""}`,
    );
  }

  const payload = (await response.json()) as KakaoKeywordResponse;
  const documents = payload.documents ?? [];
  const deduped = new Map<string, SearchResultDto>();

  for (const document of documents) {
    const latitude = Number(document.y);
    const longitude = Number(document.x);

    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      continue;
    }

    const result: SearchResultDto = {
      id: `kakao:${document.id}`,
      kind: "place",
      displayName: document.place_name.trim(),
      categoryLabel: buildCategoryLabel(document),
      regionName: buildRegionName(document),
      latitude,
      longitude,
      meta: {
        mode: "external",
        provider: "kakao",
        externalId: document.id,
        placeUrl: document.place_url ?? null,
        addressName: document.address_name ?? null,
        roadAddressName: document.road_address_name ?? null,
        categoryName: document.category_name ?? null,
        phone: document.phone ?? null,
      },
    };

    deduped.set(result.id, result);
  }

  return [...deduped.values()].slice(0, limit);
}
