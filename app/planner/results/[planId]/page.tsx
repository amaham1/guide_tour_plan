import { notFound } from "next/navigation";
import { Clock3, Footprints, RefreshCw, Shuffle } from "lucide-react";
import { ResultsActions } from "@/components/planner/results-actions";
import { getPlannerResult } from "@/features/planner/service";
import { formatClock, formatDateTime, formatDuration } from "@/lib/utils";

const metricIcons = {
  duration: Clock3,
  walk: Footprints,
  transfer: Shuffle,
  realtime: RefreshCw,
};

export default async function PlannerResultsPage({
  params,
}: {
  params: Promise<{ planId: string }>;
}) {
  const { planId } = await params;

  let result;
  try {
    result = await getPlannerResult(planId);
  } catch {
    notFound();
  }

  const headline =
    result.candidates.length > 0
      ? `추천 경로 ${result.candidates.length}개를 계산했습니다.`
      : "추천 경로를 찾지 못했습니다.";

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <section className="rounded-[2.5rem] border border-white/50 bg-[rgba(255,249,240,0.8)] p-8 shadow-tide backdrop-blur sm:p-10">
          <p className="text-sm uppercase tracking-[0.32em] text-lagoon/70">
            Planner Result
          </p>
          <h1 className="mt-3 text-4xl font-semibold text-ink sm:text-5xl">{headline}</h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-ink/70">
            시작 시각은 {formatDateTime(result.startAt)} 기준입니다. 결과 화면에서는 운영시간
            충돌, 보강 정류장 시각, 실시간 가용 여부를 함께 비교할 수 있습니다.
          </p>

          <div className="mt-6 flex flex-wrap gap-3">
            {result.places.map((place, index) => (
              <span
                key={place.placeId}
                className="rounded-full border border-ink/10 bg-white px-4 py-2 text-sm text-ink/75"
              >
                {index + 1}. {place.displayName} 체류 {place.dwellMinutes}분
              </span>
            ))}
          </div>

          {result.includeGeneratedTimes ? (
            <div className="mt-4 rounded-2xl border border-sunrise/20 bg-sunrise/10 px-4 py-3 text-sm text-ink/75">
              생성 시각 포함 옵션이 켜져 있어 공식 시간표가 비어 있는 중간 정류장도 함께 계산했습니다.
            </div>
          ) : null}
        </section>

        {result.fallbackMessage ? (
          <section className="mt-8 rounded-[2rem] border border-coral/20 bg-coral/10 p-6 text-coral shadow-tide">
            <h2 className="text-2xl font-semibold">연결 가능한 경로를 찾지 못했습니다.</h2>
            <p className="mt-3 text-base">{result.fallbackMessage}</p>
          </section>
        ) : (
          <section className="mt-8 grid gap-6 xl:grid-cols-3">
            {result.candidates.map((candidate) => {
              const DurationIcon = metricIcons.duration;
              const WalkIcon = metricIcons.walk;
              const TransferIcon = metricIcons.transfer;
              const RealtimeIcon = metricIcons.realtime;

              return (
                <article
                  key={candidate.id}
                  className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide"
                >
                  <div className="flex items-center justify-between gap-4">
                    <div>
                      <p className="text-sm uppercase tracking-[0.22em] text-lagoon/70">
                        {candidate.kind.replaceAll("_", " ")}
                      </p>
                      <h2 className="mt-2 text-2xl font-semibold text-ink">
                        {candidate.summary.title}
                      </h2>
                    </div>
                    <span className="rounded-full border border-lagoon/15 bg-lagoon/8 px-3 py-1 text-xs font-semibold text-lagoon">
                      점수 {candidate.score.toFixed(1)}
                    </span>
                  </div>

                  <p className="mt-3 text-sm leading-6 text-ink/65">
                    {candidate.summary.narrative}
                  </p>

                  <div className="mt-4 flex flex-wrap gap-2">
                    {candidate.warnings.map((warning) => (
                      <span
                        key={`${warning.code}-${warning.message}`}
                        className="rounded-full border border-sunrise/25 bg-sunrise/10 px-3 py-1 text-xs font-semibold text-ink"
                      >
                        {warning.code === "OPENING_HOURS_CONFLICT"
                          ? "운영시간 충돌"
                          : warning.code === "ESTIMATED_STOP_TIMES"
                            ? "생성 시각 포함"
                            : warning.code === "REALTIME_UNAVAILABLE"
                              ? "실시간 미지원"
                              : "환승 포함"}
                      </span>
                    ))}
                  </div>

                  <div className="mt-5 grid gap-3 sm:grid-cols-2">
                    <div className="rounded-2xl border border-ink/8 bg-white p-4">
                      <DurationIcon className="size-4 text-lagoon" />
                      <p className="mt-2 text-sm text-ink/55">총 소요</p>
                      <p className="mt-1 text-lg font-semibold text-ink">
                        {formatDuration(candidate.summary.totalDurationMinutes)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-ink/8 bg-white p-4">
                      <WalkIcon className="size-4 text-lagoon" />
                      <p className="mt-2 text-sm text-ink/55">총 도보</p>
                      <p className="mt-1 text-lg font-semibold text-ink">
                        {formatDuration(candidate.summary.totalWalkMinutes)}
                      </p>
                    </div>
                    <div className="rounded-2xl border border-ink/8 bg-white p-4">
                      <TransferIcon className="size-4 text-lagoon" />
                      <p className="mt-2 text-sm text-ink/55">환승 횟수</p>
                      <p className="mt-1 text-lg font-semibold text-ink">
                        {candidate.summary.transfers}회
                      </p>
                    </div>
                    <div className="rounded-2xl border border-ink/8 bg-white p-4">
                      <RealtimeIcon className="size-4 text-lagoon" />
                      <p className="mt-2 text-sm text-ink/55">실시간 반영</p>
                      <p className="mt-1 text-lg font-semibold text-ink">
                        {candidate.summary.realtimeEligible ? "가능" : "시간표 기준"}
                      </p>
                    </div>
                  </div>

                  <div className="mt-5 rounded-2xl border border-ink/8 bg-white px-4 py-3 text-sm text-ink/70">
                    최종 도착 시각 {formatDateTime(candidate.summary.finalArrivalAt)}
                  </div>

                  {candidate.warnings.length > 0 ? (
                    <div className="mt-4 space-y-2">
                      {candidate.warnings.map((warning) => (
                        <p
                          key={warning.message}
                          className="rounded-2xl border border-sunrise/20 bg-sunrise/10 px-4 py-3 text-sm text-ink/75"
                        >
                          {warning.message}
                        </p>
                      ))}
                    </div>
                  ) : null}

                  <div className="mt-6 space-y-3">
                    {candidate.legs.map((leg) => (
                      <div
                        key={leg.id}
                        className="rounded-2xl border border-ink/8 bg-white px-4 py-4"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <p className="text-xs uppercase tracking-[0.16em] text-lagoon/65">
                              {leg.kind}
                            </p>
                            <h3 className="mt-1 text-base font-semibold text-ink">
                              {leg.title}
                            </h3>
                            {leg.subtitle ? (
                              <p className="mt-1 text-sm text-ink/60">{leg.subtitle}</p>
                            ) : null}
                          </div>
                          <div className="text-right text-sm text-ink/60">
                            <p>
                              {formatClock(leg.startAt)} - {formatClock(leg.endAt)}
                            </p>
                            <p>{formatDuration(leg.durationMinutes)}</p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>

                  <ResultsActions planCandidateId={candidate.id} />
                </article>
              );
            })}
          </section>
        )}
      </div>
    </main>
  );
}



