import { notFound } from "next/navigation";
import { RunAllButton } from "@/components/admin/run-all-button";
import { RunJobButton } from "@/components/admin/run-job-button";
import { getAdminDashboard } from "@/features/admin/service";
import { appEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/utils";

export default async function AdminPage() {
  if (!appEnv.enableInternalAdmin) {
    notFound();
  }

  const dashboard = await getAdminDashboard();

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl space-y-8">
        <section className="rounded-[2.5rem] border border-white/50 bg-grain p-8 shadow-tide sm:p-10">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-sm uppercase tracking-[0.32em] text-lagoon/70">
                Internal Admin
              </p>
              <h1 className="mt-3 text-4xl font-semibold text-ink sm:text-5xl">
                실데이터 ingest와 검증 상태
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-ink/70">
                source catalog, ingest 이력, POI 조인 예외, 노선 패턴 검토, 시간표 파싱,
                vehicle-device-map 상태를 한 화면에서 확인합니다.
              </p>
            </div>
            <RunAllButton />
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-5">
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">POI</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.catalogStatus.placeCount}
              </p>
            </div>
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">정류소</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.catalogStatus.stopCount}
              </p>
            </div>
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">노선 패턴</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.catalogStatus.routePatternCount}
              </p>
            </div>
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">Trip</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.catalogStatus.tripCount}
              </p>
            </div>
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">보행 링크</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.catalogStatus.walkLinkCount}
              </p>
            </div>
          </div>
        </section>

        <section className="grid gap-6 xl:grid-cols-2">
          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">Source Catalog</h2>
            <div className="mt-5 space-y-3">
              {dashboard.sources.map((source) => (
                <div
                  key={source.id}
                  className="rounded-2xl border border-ink/8 bg-white px-4 py-4"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-ink">{source.name}</p>
                      <p className="mt-1 text-sm text-ink/60">{source.description}</p>
                    </div>
                    <span className="rounded-full border border-lagoon/15 bg-lagoon/8 px-3 py-1 text-xs font-semibold text-lagoon">
                      {source.sourceKind}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">Ingest Jobs / Runs</h2>
            <div className="mt-5 space-y-3">
              {dashboard.jobs.map((job) => (
                <div
                  key={job.id}
                  className="rounded-2xl border border-ink/8 bg-white px-4 py-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-ink">{job.name}</p>
                      <p className="text-sm text-ink/55">
                        {job.key} · {job.scheduleLabel}
                      </p>
                    </div>
                    <RunJobButton jobKey={job.key} />
                  </div>
                  <p className="mt-2 text-sm text-ink/55">
                    최근 성공:
                    {" "}
                    {job.lastSuccessfulAt ? formatDateTime(job.lastSuccessfulAt) : "아직 없음"}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-ink/8 bg-white p-4">
              <h3 className="text-lg font-semibold text-ink">최근 실행 이력</h3>
              <div className="mt-4 space-y-3">
                {dashboard.runs.map((run) => (
                  <div key={run.id} className="rounded-xl border border-ink/8 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-ink">{run.job.name}</p>
                      <span className="text-sm text-ink/55">{run.status}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink/55">
                      {formatDateTime(run.startedAt)}
                      {run.endedAt ? ` → ${formatDateTime(run.endedAt)}` : ""}
                    </p>
                    {run.errorSummary ? (
                      <p className="mt-1 text-sm text-coral">{run.errorSummary}</p>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          </article>
        </section>

        <section className="grid gap-6 xl:grid-cols-3">
          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">POI 조인 예외</h2>
            <div className="mt-5 space-y-3">
              {dashboard.poiJoinExceptions.length === 0 ? (
                <p className="rounded-2xl border border-ink/8 bg-white px-4 py-4 text-sm text-ink/60">
                  예외가 없습니다.
                </p>
              ) : (
                dashboard.poiJoinExceptions.map((place) => (
                  <div key={place.id} className="rounded-2xl border border-ink/8 bg-white px-4 py-4">
                    <p className="font-semibold text-ink">{place.displayName}</p>
                    <p className="mt-1 text-sm text-ink/55">
                      access {place.accessLinks} · egress {place.egressLinks}
                    </p>
                  </div>
                ))
              )}
            </div>
          </article>

          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">Route Pattern Review</h2>
            <div className="mt-5 space-y-3">
              {dashboard.routePatternReview.map((pattern) => (
                <div key={pattern.id} className="rounded-2xl border border-ink/8 bg-white px-4 py-4">
                  <p className="font-semibold text-ink">{pattern.label}</p>
                  <p className="mt-1 text-sm text-ink/55">
                    정류소 {pattern.stopCount} · trip {pattern.tripCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    sequence {pattern.sequenceOk ? "OK" : "CHECK"} · distance {pattern.distanceMonotonic ? "OK" : "CHECK"} · placeholder {pattern.placeholderStopCount}
                  </p>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">Timetable / Vehicle Map</h2>
            <div className="rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">매핑 성공률</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.vehicleMapStats.successRate}%
              </p>
              <p className="mt-1 text-sm text-ink/55">
                {dashboard.vehicleMapStats.mappedPatterns} / {dashboard.vehicleMapStats.totalPatterns}
              </p>
            </div>
            <div className="mt-5 space-y-3">
              {dashboard.timetableReview.map((pattern) => (
                <div key={pattern.id} className="rounded-2xl border border-ink/8 bg-white px-4 py-4">
                  <p className="font-semibold text-ink">{pattern.label}</p>
                  <p className="mt-1 text-sm text-ink/55">
                    trip {pattern.tripCount} · estimated stop time {pattern.estimatedStopTimeCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    {pattern.hasTrips ? "시간표 적재됨" : "trip 없음"}
                  </p>
                </div>
              ))}
            </div>
          </article>
        </section>
      </div>
    </main>
  );
}
