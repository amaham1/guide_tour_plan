import { notFound } from "next/navigation";
import { RunAllButton } from "@/components/admin/run-all-button";
import { RunJobButton } from "@/components/admin/run-job-button";
import { getAdminDashboard } from "@/features/admin/service";
import { appEnv } from "@/lib/env";
import { formatDateTime } from "@/lib/utils";

function formatUnknownDate(value: string | Date | null) {
  return value ? formatDateTime(value) : "none";
}

function formatTimetableSyncStatus(status: string) {
  switch (status) {
    case "in_sync":
      return "In sync";
    case "refreshing":
      return "Refreshing";
    case "stale":
      return "Stale";
    default:
      return "Idle";
  }
}

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
                Transit Ingest Health
              </h1>
              <p className="mt-4 max-w-3xl text-base leading-7 text-ink/70">
                Review ingest freshness, geometry coverage, timetable quality, and OSRM status in
                one place.
              </p>
            </div>
            <RunAllButton />
          </div>

          <div className="mt-6 grid gap-4 sm:grid-cols-4 xl:grid-cols-8">
            {[
              ["POI", dashboard.catalogStatus.placeCount],
              ["Stop", dashboard.catalogStatus.stopCount],
              ["Route Pattern", dashboard.catalogStatus.routePatternCount],
              ["Trip", dashboard.catalogStatus.tripCount],
              ["Official Stop", dashboard.catalogStatus.officialStopCount],
              ["Generated Stop", dashboard.catalogStatus.generatedStopCount],
              ["Walk Link", dashboard.catalogStatus.walkLinkCount],
              ["Geometry", dashboard.catalogStatus.routeGeometryCount],
              ["Projection", dashboard.catalogStatus.stopProjectionCount],
            ].map(([label, value]) => (
              <div key={label} className="rounded-2xl border border-ink/8 bg-white p-4">
                <p className="text-sm text-ink/55">{label}</p>
                <p className="mt-1 text-2xl font-semibold text-ink">{String(value)}</p>
              </div>
            ))}
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
                        {job.key} | {job.scheduleLabel}
                      </p>
                    </div>
                    <RunJobButton jobKey={job.key} />
                  </div>
                  <p className="mt-2 text-sm text-ink/55">
                    latest success: {formatUnknownDate(job.lastSuccessfulAt)}
                  </p>
                </div>
              ))}
            </div>

            <div className="mt-6 rounded-2xl border border-ink/8 bg-white p-4">
              <h3 className="text-lg font-semibold text-ink">Recent Runs</h3>
              <div className="mt-4 space-y-3">
                {dashboard.runs.map((run) => (
                  <div key={run.id} className="rounded-xl border border-ink/8 px-3 py-3">
                    <div className="flex items-center justify-between gap-3">
                      <p className="font-medium text-ink">{run.job.name}</p>
                      <span className="text-sm text-ink/55">{run.status}</span>
                    </div>
                    <p className="mt-1 text-sm text-ink/55">
                      {formatDateTime(run.startedAt)}
                      {run.endedAt ? ` -> ${formatDateTime(run.endedAt)}` : ""}
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
          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide xl:col-span-3">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <h2 className="text-2xl font-semibold text-ink">Schedule Matching</h2>
                <p className="mt-2 text-sm text-ink/60">
                  Latest `routes-html` diagnostics for sparse official timetable matching.
                </p>
              </div>
              <div className="rounded-2xl border border-ink/8 bg-white px-4 py-3 text-sm text-ink/60">
                latest {formatUnknownDate(dashboard.scheduleMatchingStats.latestRoutesHtmlAt)}
              </div>
            </div>

            <div className="mt-5 grid gap-4 md:grid-cols-4">
              {[
                ["Active Source", dashboard.scheduleMatchingStats.activeScheduleSourceCount],
                ["Matched Variant", dashboard.scheduleMatchingStats.matchedVariantCount],
                ["Unmatched Variant", dashboard.scheduleMatchingStats.unmatchedVariantCount],
                ["Skipped Variant", dashboard.scheduleMatchingStats.skippedVariantCount],
              ].map(([label, value]) => (
                <div key={label} className="rounded-2xl border border-ink/8 bg-white p-4">
                  <p className="text-sm text-ink/55">{label}</p>
                  <p className="mt-1 text-2xl font-semibold text-ink">{String(value)}</p>
                </div>
              ))}
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-3">
              <div className="rounded-2xl border border-ink/8 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Top Matched Families</h3>
                <div className="mt-4 space-y-3">
                  {dashboard.scheduleMatchingStats.matchedRouteLabels.length === 0 ? (
                    <p className="text-sm text-ink/55">No matched families yet.</p>
                  ) : (
                    dashboard.scheduleMatchingStats.matchedRouteLabels.map((item) => (
                      <div key={item.shortName} className="rounded-xl border border-ink/8 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium text-ink">{item.shortName}</p>
                          <span className="text-sm text-ink/55">{item.count}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-ink/8 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Top Unmatched Families</h3>
                <div className="mt-4 space-y-3">
                  {dashboard.scheduleMatchingStats.unmatchedRouteLabels.length === 0 ? (
                    <p className="text-sm text-ink/55">No unmatched families.</p>
                  ) : (
                    dashboard.scheduleMatchingStats.unmatchedRouteLabels.map((item) => (
                      <div key={item.shortName} className="rounded-xl border border-ink/8 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium text-ink">{item.shortName}</p>
                          <span className="text-sm text-ink/55">{item.count}</span>
                        </div>
                        <p className="mt-1 text-sm text-ink/55">
                          {item.reasons.length === 0
                            ? "no reason breakdown"
                            : item.reasons
                                .map((reason: { reason: string; count: number }) => `${reason.reason} ${reason.count}`)
                                .join(" | ")}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-ink/8 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Near Misses</h3>
                <div className="mt-4 space-y-3">
                  {dashboard.scheduleMatchingStats.nearMisses.length === 0 ? (
                    <p className="text-sm text-ink/55">No near misses recorded.</p>
                  ) : (
                    dashboard.scheduleMatchingStats.nearMisses.map((item) => (
                      <div
                        key={`${item.scheduleId}-${item.variantKey}-${item.bestCandidate?.routePatternId ?? "none"}`}
                        className="rounded-xl border border-ink/8 px-3 py-3"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <p className="font-medium text-ink">
                              {item.shortName} [{item.variantKey}]
                            </p>
                            <p className="text-sm text-ink/55">
                              schedule {item.scheduleId} | stops {item.stopCount} | rows {item.tripCount}
                            </p>
                          </div>
                          <span className="text-sm text-ink/55">
                            {Math.round((item.bestCandidate?.coverageRatio ?? 0) * 100)}%
                          </span>
                        </div>
                        <p className="mt-2 text-sm text-ink/55">
                          candidate {item.bestCandidate?.shortName ?? "-"} |{" "}
                          {item.bestCandidate?.displayName ?? item.bestCandidate?.directionLabel ?? "-"}
                        </p>
                        <p className="mt-1 text-sm text-ink/55">
                          subtype {item.reasonSubtype ?? "unknown"} | reason {item.reason}
                        </p>
                        <p className="mt-1 text-sm text-ink/55">
                          unmatched{" "}
                          {(item.bestCandidate?.unmatchedStopNames ?? []).length > 0
                            ? item.bestCandidate?.unmatchedStopNames.join(", ")
                            : "none"}
                        </p>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>

            <div className="mt-5 grid gap-4 xl:grid-cols-2">
              <div className="rounded-2xl border border-ink/8 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Mixed Variant Diagnostics</h3>
                <p className="mt-2 text-sm text-ink/55">
                  inherited rows {dashboard.scheduleMatchingStats.inheritedVariantRowCount} | unresolved rows{" "}
                  {dashboard.scheduleMatchingStats.unresolvedVariantRowCount}
                </p>
                <div className="mt-4 space-y-3">
                  {dashboard.scheduleMatchingStats.unresolvedMixedVariantSchedules.length === 0 &&
                  dashboard.scheduleMatchingStats.resolvedMixedVariantSchedules.length === 0 ? (
                    <p className="text-sm text-ink/55">No mixed variant schedules recorded.</p>
                  ) : (
                    <>
                      {dashboard.scheduleMatchingStats.unresolvedMixedVariantSchedules.map((item) => (
                        <div
                          key={`unresolved-${item.scheduleId}`}
                          className="rounded-xl border border-coral/15 px-3 py-3"
                        >
                          <p className="font-medium text-ink">{item.shortName}</p>
                          <p className="mt-1 text-sm text-ink/55">
                            schedule {item.scheduleId} | inherited {item.inheritedVariantRowCount} |
                            unresolved {item.unresolvedVariantRowCount}
                          </p>
                        </div>
                      ))}
                      {dashboard.scheduleMatchingStats.resolvedMixedVariantSchedules.map((item) => (
                        <div
                          key={`resolved-${item.scheduleId}`}
                          className="rounded-xl border border-ink/8 px-3 py-3"
                        >
                          <p className="font-medium text-ink">{item.shortName}</p>
                          <p className="mt-1 text-sm text-ink/55">
                            schedule {item.scheduleId} | inherited {item.inheritedVariantRowCount}
                          </p>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              </div>

              <div className="rounded-2xl border border-ink/8 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Rejection Breakdown</h3>
                <div className="mt-4 space-y-3">
                  {dashboard.scheduleMatchingStats.rejectionBreakdown.length === 0 ? (
                    <p className="text-sm text-ink/55">No rejection breakdown recorded.</p>
                  ) : (
                    dashboard.scheduleMatchingStats.rejectionBreakdown.map((item) => (
                      <div key={`${item.reason}-${item.reasonSubtype}`} className="rounded-xl border border-ink/8 px-3 py-3">
                        <div className="flex items-center justify-between gap-3">
                          <p className="font-medium text-ink">
                            {item.reasonSubtype} / {item.reason}
                          </p>
                          <span className="text-sm text-ink/55">{item.count}</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </article>

          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">POI Join Exceptions</h2>
            <div className="mt-5 space-y-3">
              {dashboard.poiJoinExceptions.length === 0 ? (
                <p className="rounded-2xl border border-ink/8 bg-white px-4 py-4 text-sm text-ink/60">
                  No exceptions found.
                </p>
              ) : (
                dashboard.poiJoinExceptions.map((place) => (
                  <div key={place.id} className="rounded-2xl border border-ink/8 bg-white px-4 py-4">
                    <p className="font-semibold text-ink">{place.displayName}</p>
                    <p className="mt-1 text-sm text-ink/55">
                      access {place.accessLinks} | egress {place.egressLinks}
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
                    stops {pattern.stopCount} | active sources {pattern.scheduleSourceCount} | trips {pattern.tripCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    sequence {pattern.sequenceOk ? "OK" : "CHECK"} | distance{" "}
                    {pattern.distanceMonotonic ? "OK" : "CHECK"} | unresolved stop{" "}
                    {pattern.placeholderStopCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    official stop times {pattern.officialStopTimeCount} | generated stop times{" "}
                    {pattern.generatedStopTimeCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    geometry {pattern.geometrySource ?? "NONE"} | confidence{" "}
                    {pattern.geometryConfidence?.toFixed(2) ?? "-"} | projection{" "}
                    {pattern.projectedStopCount}/{pattern.stopCount} | mean snap{" "}
                    {pattern.meanSnapDistance ?? "-"}m
                  </p>
                </div>
              ))}
            </div>
          </article>

          <article className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-6 shadow-tide">
            <h2 className="text-2xl font-semibold text-ink">Timetable / Vehicle / Geometry</h2>
            <div
              className={`rounded-2xl border p-4 ${
                dashboard.timetableSyncStats.status === "stale" ||
                dashboard.timetableSyncStats.zeroTripScheduleSourceCount > 0
                  ? "border-coral/20 bg-coral/5"
                  : "border-ink/8 bg-white"
              }`}
            >
              <p className="text-sm text-ink/55">Timetable materialization</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {formatTimetableSyncStatus(dashboard.timetableSyncStats.status)}
              </p>
              <p className="mt-1 text-sm text-ink/55">
                routes-html {formatUnknownDate(dashboard.timetableSyncStats.latestRoutesHtmlAt)}
                <br />
                timetables-xlsx {formatUnknownDate(dashboard.timetableSyncStats.latestTimetablesXlsxAt)}{" "}
                {dashboard.timetableSyncStats.latestTimetablesXlsxStatus
                  ? `(${dashboard.timetableSyncStats.latestTimetablesXlsxStatus})`
                  : ""}
              </p>
              <p className="mt-1 text-sm text-ink/55">
                active sources without trips {dashboard.timetableSyncStats.zeroTripScheduleSourceCount}
                {dashboard.timetableSyncStats.lagMinutes !== null
                  ? ` | stale by ${dashboard.timetableSyncStats.lagMinutes} min`
                  : ""}
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-ink/8 bg-white p-4">
              <p className="text-sm text-ink/55">Vehicle map coverage</p>
              <p className="mt-1 text-2xl font-semibold text-ink">
                {dashboard.vehicleMapStats.successRate}%
              </p>
              <p className="mt-1 text-sm text-ink/55">
                {dashboard.vehicleMapStats.mappedPatterns} / {dashboard.vehicleMapStats.totalPatterns}
              </p>
            </div>

            <div className="mt-4 rounded-2xl border border-ink/8 bg-white p-4 text-sm text-ink/55">
              geometry coverage {dashboard.geometryStats.geometryCoverage}% | projection coverage{" "}
              {dashboard.geometryStats.projectionCoverage}%
              <br />
              route-geometries {formatUnknownDate(dashboard.geometryStats.latestRouteGeometryAt)}
              <br />
              GTFS configured {dashboard.geometryStats.gtfsConfigured ? "YES" : "NO"} | BIS link{" "}
              {dashboard.geometryStats.busJejuLinkCount} | GTFS match{" "}
              {dashboard.geometryStats.gtfsMatchCount} | OSRM fallback{" "}
              {dashboard.geometryStats.fallbackCount}
              {dashboard.geometryStats.gtfsSource ? (
                <>
                  <br />
                  GTFS source {dashboard.geometryStats.gtfsSource}
                </>
              ) : null}
              {dashboard.geometryStats.gtfsLoadError ? (
                <>
                  <br />
                  GTFS load error {dashboard.geometryStats.gtfsLoadError}
                </>
              ) : null}
              {dashboard.geometryStats.gtfsProbe ? (
                <>
                  <br />
                  GTFS files{" "}
                  {Array.isArray(dashboard.geometryStats.gtfsProbe.availableFiles)
                    ? dashboard.geometryStats.gtfsProbe.availableFiles.join(", ")
                    : "-"}{" "}
                  | missing{" "}
                  {Array.isArray(dashboard.geometryStats.gtfsProbe.missingFiles) &&
                  dashboard.geometryStats.gtfsProbe.missingFiles.length > 0
                    ? dashboard.geometryStats.gtfsProbe.missingFiles.join(", ")
                    : "none"}
                </>
              ) : null}
            </div>

            {dashboard.timetableSyncStats.zeroTripScheduleSources.length > 0 ? (
              <div className="mt-4 rounded-2xl border border-coral/15 bg-white p-4">
                <h3 className="text-lg font-semibold text-ink">Active Sources Without Trips</h3>
                <div className="mt-4 space-y-3">
                  {dashboard.timetableSyncStats.zeroTripScheduleSources.map((source) => (
                    <div key={source.id} className="rounded-xl border border-ink/8 px-3 py-3">
                      <p className="font-medium text-ink">
                        {source.routePattern.route.shortName} {source.routePattern.directionLabel}
                      </p>
                      <p className="mt-1 text-sm text-ink/55">
                        schedule {source.scheduleId} [{source.variantKey}] | {source.routePattern.displayName}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="mt-5 space-y-3">
              {dashboard.timetableReview.map((pattern) => (
                <div key={pattern.id} className="rounded-2xl border border-ink/8 bg-white px-4 py-4">
                  <p className="font-semibold text-ink">{pattern.label}</p>
                  <p className="mt-1 text-sm text-ink/55">
                    trips {pattern.tripCount} | official stop times {pattern.officialStopTimeCount} |
                    generated stop times {pattern.generatedStopTimeCount}
                  </p>
                  <p className="mt-1 text-sm text-ink/55">
                    {pattern.hasTrips ? `${pattern.coverage} coverage` : "no trips"}
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
