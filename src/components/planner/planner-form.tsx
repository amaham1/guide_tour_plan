"use client";

import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Search, X } from "lucide-react";
import type {
  SearchResultDto,
  TimeReliabilityMode,
} from "@/features/planner/types";
import { cn } from "@/lib/utils";

type SelectedPlace = SearchResultDto & {
  dwellMinutes: number;
};

type PlannerFormProps = {
  catalogReady: boolean;
  setupMessage: string | null;
};

const timeReliabilityModeOptions: Array<{
  value: TimeReliabilityMode;
  label: string;
  description: string;
}> = [
  {
    value: "OFFICIAL_ONLY",
    label: "공식만",
    description: "공식 시간표가 있는 정류장만 사용합니다.",
  },
  {
    value: "INCLUDE_ESTIMATED",
    label: "추정 포함",
    description: "공식 anchor 사이의 추정 시각까지 함께 사용합니다.",
  },
  {
    value: "ALLOW_ROUGH",
    label: "대략까지 허용",
    description: "후보가 없을 때만 대략 범위 기반 시각을 fallback으로 허용합니다.",
  },
];

function toLocalDateTimeValue(date: Date) {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function buildPlanPlaceInput(place: SelectedPlace) {
  const meta = place.meta as Record<string, unknown>;

  if (meta.mode === "stored" && typeof meta.placeId === "string") {
    return {
      mode: "stored" as const,
      placeId: meta.placeId,
      dwellMinutes: place.dwellMinutes,
    };
  }

  return {
    mode: "external" as const,
    displayName: place.displayName,
    latitude: place.latitude,
    longitude: place.longitude,
    regionName: place.regionName,
    categoryLabel: place.categoryLabel,
    provider: typeof meta.provider === "string" ? meta.provider : "external",
    externalId: typeof meta.externalId === "string" ? meta.externalId : undefined,
    dwellMinutes: place.dwellMinutes,
  };
}

export function PlannerForm({ catalogReady, setupMessage }: PlannerFormProps) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [results, setResults] = useState<SearchResultDto[]>([]);
  const [selectedPlaces, setSelectedPlaces] = useState<SelectedPlace[]>([]);
  const [formError, setFormError] = useState<string | null>(setupMessage);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [loadingResults, setLoadingResults] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [timeReliabilityMode, setTimeReliabilityMode] =
    useState<TimeReliabilityMode>("INCLUDE_ESTIMATED");
  const [startAt, setStartAt] = useState(() => {
    const initial = new Date();
    initial.setMinutes(Math.ceil(initial.getMinutes() / 10) * 10, 0, 0);
    return toLocalDateTimeValue(initial);
  });

  useEffect(() => {
    setFormError(setupMessage);
  }, [setupMessage]);

  useEffect(() => {
    if (!catalogReady || deferredQuery.trim().length < 1) {
      setResults([]);
      setSearchError(null);
      setLoadingResults(false);
      return;
    }

    const controller = new AbortController();
    setLoadingResults(true);
    setSearchError(null);

    void (async () => {
      try {
        const response = await fetch(
          `/api/search?kind=place&q=${encodeURIComponent(deferredQuery)}&limit=8`,
          {
            signal: controller.signal,
          },
        );
        const payload = (await response.json()) as {
          results?: SearchResultDto[];
          error?: string;
        };

        if (!response.ok) {
          throw new Error(payload.error ?? "검색에 실패했습니다.");
        }

        setResults(payload.results ?? []);
        setSearchError(null);
      } catch (fetchError) {
        if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) {
          setResults([]);
          setSearchError(
            fetchError instanceof Error
              ? fetchError.message
              : "검색 중 문제가 발생했습니다.",
          );
        }
      } finally {
        setLoadingResults(false);
      }
    })();

    return () => {
      controller.abort();
    };
  }, [catalogReady, deferredQuery]);

  function addPlace(place: SearchResultDto) {
    setFormError(null);
    setSearchError(null);
    setSelectedPlaces((current) => {
      if (current.some((item) => item.id === place.id)) {
        return current;
      }

      if (current.length >= 5) {
        setFormError("장소는 최대 5개까지 선택할 수 있습니다.");
        return current;
      }

      return [...current, { ...place, dwellMinutes: 60 }];
    });
    setQuery("");
    setResults([]);
  }

  function removePlace(placeId: string) {
    setSelectedPlaces((current) => current.filter((place) => place.id !== placeId));
  }

  function updateDwell(placeId: string, dwellMinutes: number) {
    setSelectedPlaces((current) =>
      current.map((place) =>
        place.id === placeId
          ? {
              ...place,
              dwellMinutes,
            }
          : place,
      ),
    );
  }

  function handleSubmit() {
    if (!catalogReady) {
      setFormError(setupMessage ?? "먼저 ingest를 완료해 주세요.");
      return;
    }

    if (selectedPlaces.length < 2) {
      setFormError("최소 2개의 장소를 선택해야 합니다.");
      return;
    }

    setSubmitting(true);
    setFormError(null);
    setSearchError(null);

    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/planner/plan", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              language: "ko",
              startAt: new Date(startAt).toISOString(),
              timeReliabilityMode,
              places: selectedPlaces.map(buildPlanPlaceInput),
            }),
          });

          const payload = (await response.json()) as {
            planId?: string;
            error?: string;
          };

          if (!response.ok || !payload.planId) {
            throw new Error(payload.error ?? "플랜 생성에 실패했습니다.");
          }

          router.push(`/planner/results/${payload.planId}`);
        } catch (submitError) {
          setFormError(
            submitError instanceof Error
              ? submitError.message
              : "플랜 생성 중 문제가 발생했습니다.",
          );
        } finally {
          setSubmitting(false);
        }
      })();
    });
  }

  const visibleError = searchError ?? formError;

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="rounded-[2rem] border border-white/60 bg-[rgba(255,249,240,0.78)] p-7 shadow-tide backdrop-blur">
        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.25em] text-lagoon/70">
              Planner
            </p>
            <h2 className="mt-2 text-3xl font-semibold text-ink">
              장소를 순서대로 고르면
              <br />
              버스 동선을 바로 계산합니다
            </h2>
          </div>
          <div className="rounded-full border border-lagoon/15 bg-white/70 p-3 text-lagoon">
            <Search className="size-5" />
          </div>
        </div>

        <label className="block text-sm font-medium text-ink/80">
          출발 시작 시각
          <input
            type="datetime-local"
            value={startAt}
            onChange={(event) => setStartAt(event.target.value)}
            className="mt-2 w-full rounded-2xl border border-ink/10 bg-white px-4 py-3 outline-none transition focus:border-lagoon/40"
          />
        </label>

        <label className="mt-5 block text-sm font-medium text-ink/80">
          시간 신뢰도
          <select
            value={timeReliabilityMode}
            onChange={(event) =>
              setTimeReliabilityMode(event.target.value as TimeReliabilityMode)
            }
            className="mt-2 w-full rounded-2xl border border-ink/10 bg-white px-4 py-3 outline-none transition focus:border-lagoon/40"
          >
            {timeReliabilityModeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <span className="mt-2 block rounded-2xl border border-ink/10 bg-white/70 px-4 py-3 text-sm font-normal text-ink/65">
            {
              timeReliabilityModeOptions.find(
                (option) => option.value === timeReliabilityMode,
              )?.description
            }
          </span>
        </label>

        <div className="mt-5">
          <label className="block text-sm font-medium text-ink/80">
            장소 검색
            <div className="relative mt-2">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="관광지, 카페, 식당, 숙소, 해변..."
                disabled={!catalogReady}
                className="w-full rounded-2xl border border-ink/10 bg-white px-4 py-3 pr-12 outline-none transition focus:border-lagoon/40 disabled:cursor-not-allowed disabled:bg-white/70"
              />
              <Search className="pointer-events-none absolute right-4 top-1/2 size-4 -translate-y-1/2 text-ink/35" />
            </div>
          </label>

          <div className="mt-3 min-h-16 rounded-2xl border border-dashed border-ink/10 bg-white/60 p-3">
            {!catalogReady ? (
              <p className="text-sm text-ink/55">
                {setupMessage ?? "먼저 ingest가 필요합니다."}
              </p>
            ) : loadingResults ? (
              <p className="text-sm text-ink/55">검색 중...</p>
            ) : results.length > 0 ? (
              <div className="grid gap-2">
                {results.map((result) => (
                  <button
                    key={result.id}
                    type="button"
                    onClick={() => addPlace(result)}
                    className="flex items-center justify-between rounded-2xl border border-ink/8 bg-white px-4 py-3 text-left transition hover:border-lagoon/25 hover:bg-sand"
                  >
                    <span>
                      <span className="block font-medium text-ink">
                        {result.displayName}
                      </span>
                      <span className="text-sm text-ink/55">
                        {result.categoryLabel} · {result.regionName}
                      </span>
                    </span>
                    <span className="rounded-full bg-lagoon/8 px-3 py-1 text-xs font-semibold text-lagoon">
                      추가
                    </span>
                  </button>
                ))}
              </div>
            ) : (
              <p className="text-sm text-ink/55">
                {query.trim().length > 0
                  ? "검색 결과가 없습니다. 이름이나 띄어쓰기를 다시 확인해 주세요."
                  : "검색어를 입력하면 장소 자동완성 결과를 보여드립니다."}
              </p>
            )}
          </div>
        </div>

        {visibleError ? (
          <p className="mt-4 rounded-2xl border border-coral/25 bg-coral/10 px-4 py-3 text-sm text-coral">
            오류: {visibleError}
          </p>
        ) : null}

        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting || !catalogReady}
          className={cn(
            "mt-6 inline-flex w-full items-center justify-center rounded-2xl px-4 py-4 text-base font-semibold text-white transition",
            submitting || !catalogReady
              ? "cursor-not-allowed bg-ink/40"
              : "bg-ink hover:-translate-y-0.5 hover:bg-lagoon",
          )}
        >
          {submitting ? "후보를 계산하는 중..." : "후보 3개 계산하기"}
        </button>
      </section>

      <section className="rounded-[2rem] border border-ink/10 bg-[rgba(18,33,45,0.92)] p-7 text-white shadow-tide">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.25em] text-white/45">
              Itinerary Draft
            </p>
            <h3 className="mt-2 text-2xl font-semibold">선택한 순서</h3>
          </div>
          <span className="rounded-full border border-white/10 px-3 py-1 text-xs text-white/70">
            최대 5개
          </span>
        </div>

        <div className="mt-5 space-y-3">
          {selectedPlaces.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-white/15 px-5 py-10 text-center text-sm text-white/55">
              아직 선택한 장소가 없습니다.
            </div>
          ) : (
            selectedPlaces.map((place, index) => (
              <div
                key={place.id}
                className="rounded-3xl border border-white/10 bg-white/6 p-4"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-xs uppercase tracking-[0.2em] text-sunrise">
                      Stop {index + 1}
                    </p>
                    <h4 className="mt-1 text-lg font-semibold">{place.displayName}</h4>
                    <p className="text-sm text-white/55">
                      {place.categoryLabel} · {place.regionName}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => removePlace(place.id)}
                    className="rounded-full border border-white/10 p-2 text-white/60 transition hover:border-white/25 hover:text-white"
                    aria-label={`${place.displayName} 제거`}
                  >
                    <X className="size-4" />
                  </button>
                </div>

                <label className="mt-4 block text-sm text-white/75">
                  체류 시간
                  <div className="mt-2 flex items-center gap-3">
                    <input
                      type="range"
                      min={10}
                      max={240}
                      step={10}
                      value={place.dwellMinutes}
                      onChange={(event) =>
                        updateDwell(place.id, Number(event.target.value))
                      }
                      className="w-full accent-sunrise"
                    />
                    <span className="min-w-14 text-right font-semibold">
                      {place.dwellMinutes}분
                    </span>
                  </div>
                </label>
              </div>
            ))
          )}
        </div>
      </section>
    </div>
  );
}
