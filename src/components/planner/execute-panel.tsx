"use client";

import { useEffect, useState } from "react";
import { Bus, Clock3, Footprints, LocateFixed } from "lucide-react";
import type { ExecutionStatusDto } from "@/features/planner/types";
import { formatClock, formatDuration } from "@/lib/utils";

type ExecutePanelProps = {
  initialStatus: ExecutionStatusDto;
};

function formatCountdown(nextActionAt: string | null, now: number) {
  if (!nextActionAt) {
    return "일정 종료";
  }

  const diff = new Date(nextActionAt).getTime() - now;
  if (diff <= 0) {
    return "지금";
  }

  const totalSeconds = Math.floor(diff / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatLegTime(leg: ExecutionStatusDto["legs"][number]) {
  if (leg.timeReliability === "ROUGH" && leg.startWindowAt && leg.endWindowAt) {
    return `${formatClock(leg.startWindowAt)} - ${formatClock(leg.endWindowAt)}`;
  }

  return `${formatClock(leg.startAt)} - ${formatClock(leg.endAt)}`;
}

function formatLegStart(leg: ExecutionStatusDto["legs"][number]) {
  if (leg.timeReliability === "ROUGH" && leg.startWindowAt && leg.endWindowAt) {
    return `${formatClock(leg.startWindowAt)} - ${formatClock(leg.endWindowAt)}`;
  }

  return formatClock(leg.startAt);
}

function realtimeCopy(status: ExecutionStatusDto) {
  if (status.realtimeApplied) {
    return `${status.delayMinutes}분`;
  }

  return "미적용";
}

export function ExecutePanel({ initialStatus }: ExecutePanelProps) {
  const [status, setStatus] = useState(initialStatus);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const tick = window.setInterval(() => {
      setNow(Date.now());
    }, 1000);

    return () => window.clearInterval(tick);
  }, []);

  useEffect(() => {
    const poll = window.setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/planner/session/${status.sessionId}`);
          const payload = (await response.json()) as ExecutionStatusDto;
          if (response.ok) {
            setStatus(payload);
          }
        } catch {
          // Keep the last known state if polling fails.
        }
      })();
    }, 30_000);

    return () => window.clearInterval(poll);
  }, [status.sessionId]);

  const countdown = formatCountdown(status.nextActionAt, now);

  return (
    <div className="grid gap-6 lg:grid-cols-[1.05fr_0.95fr]">
      <section className="rounded-[2rem] border border-ink/10 bg-[rgba(255,252,246,0.92)] p-7 shadow-tide">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-lagoon/70">
              Live Session
            </p>
            <h2 className="mt-2 text-3xl font-semibold text-ink">
              {status.summary.title}
            </h2>
          </div>
          <div className="rounded-full bg-ink px-4 py-2 text-sm font-semibold text-white">
            {status.status}
          </div>
        </div>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <div className="rounded-3xl border border-ink/8 bg-white p-5">
            <Clock3 className="size-5 text-lagoon" />
            <p className="mt-3 text-sm text-ink/55">다음 행동까지</p>
            <p className="mt-2 text-3xl font-semibold text-ink">{countdown}</p>
            {status.nextActionAt ? (
              <p className="mt-2 text-sm text-ink/55">
                {formatClock(status.nextActionAt)} 예정
              </p>
            ) : null}
          </div>
          <div className="rounded-3xl border border-ink/8 bg-white p-5">
            <LocateFixed className="size-5 text-lagoon" />
            <p className="mt-3 text-sm text-ink/55">실시간 반영</p>
            <p className="mt-2 text-3xl font-semibold text-ink">
              {realtimeCopy(status)}
            </p>
            <p className="mt-2 text-sm text-ink/55">{status.notice}</p>
            {status.realtimeReason ? (
              <p className="mt-1 text-xs text-ink/45">{status.realtimeReason}</p>
            ) : null}
          </div>
        </div>

        <div className="mt-6 grid gap-4">
          <div className="rounded-3xl border border-ink/8 bg-white p-5">
            <p className="text-sm uppercase tracking-[0.18em] text-lagoon/70">
              Current
            </p>
            {status.currentLeg ? (
              <>
                <h3 className="mt-2 text-xl font-semibold text-ink">
                  {status.currentLeg.title}
                </h3>
                {status.currentLeg.subtitle ? (
                  <p className="mt-1 text-sm text-ink/60">
                    {status.currentLeg.subtitle}
                  </p>
                ) : null}
                <p className="mt-3 text-sm text-ink/55">
                  {formatLegTime(status.currentLeg)} ·{" "}
                  {formatDuration(status.currentLeg.durationMinutes)}
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-ink/55">
                아직 시작 전이거나 다음 구간을 기다리는 중입니다.
              </p>
            )}
          </div>

          <div className="rounded-3xl border border-ink/8 bg-white p-5">
            <p className="text-sm uppercase tracking-[0.18em] text-lagoon/70">
              Next
            </p>
            {status.nextLeg ? (
              <>
                <h3 className="mt-2 text-xl font-semibold text-ink">
                  {status.nextLeg.title}
                </h3>
                {status.nextLeg.subtitle ? (
                  <p className="mt-1 text-sm text-ink/60">{status.nextLeg.subtitle}</p>
                ) : null}
                <p className="mt-3 text-sm text-ink/55">
                  {formatLegStart(status.nextLeg)} 시작 예정
                </p>
              </>
            ) : (
              <p className="mt-2 text-sm text-ink/55">다음 구간이 없습니다.</p>
            )}
          </div>

          {status.replacementSuggested ? (
            <div className="rounded-3xl border border-coral/20 bg-coral/10 p-5">
              <p className="text-sm font-semibold text-coral">대체 경로 확인 권장</p>
              <p className="mt-2 text-sm text-ink/75">
                현재 지연으로 다음 연결이 불안정할 수 있습니다. 다음 탑승 구간을 현장에서 다시 확인해 주세요.
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className="rounded-[2rem] border border-white/15 bg-[rgba(18,33,45,0.94)] p-7 text-white shadow-tide">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm uppercase tracking-[0.22em] text-white/45">
              Timeline
            </p>
            <h3 className="mt-2 text-2xl font-semibold">전체 실행 타임라인</h3>
          </div>
          <div className="text-right text-sm text-white/55">
            <p>총 소요 {formatDuration(status.summary.totalDurationMinutes)}</p>
            <p>도보 {formatDuration(status.summary.totalWalkMinutes)}</p>
          </div>
        </div>

        <div className="mt-6 space-y-3">
          {status.legs.map((leg, index) => {
            const active = index === status.currentLegIndex;
            const Icon =
              leg.kind === "ride" ? Bus : leg.kind === "walk" ? Footprints : Clock3;

            return (
              <div
                key={leg.id}
                className={`rounded-3xl border px-4 py-4 transition ${
                  active
                    ? "border-sunrise bg-sunrise/14"
                    : "border-white/10 bg-white/6"
                }`}
              >
                <div className="flex items-center justify-between gap-4">
                  <div className="flex items-start gap-3">
                    <div
                      className={`mt-1 rounded-full p-2 ${
                        active ? "bg-white text-ink" : "bg-white/10 text-white/75"
                      }`}
                    >
                      <Icon className="size-4" />
                    </div>
                    <div>
                      <p className="text-xs uppercase tracking-[0.18em] text-white/45">
                        {leg.kind}
                      </p>
                      <h4 className="mt-1 text-base font-semibold">{leg.title}</h4>
                      <p className="mt-1 text-xs text-white/45">{leg.timeReliability}</p>
                      {leg.subtitle ? (
                        <p className="mt-1 text-sm text-white/60">{leg.subtitle}</p>
                      ) : null}
                    </div>
                  </div>

                  <div className="text-right text-sm text-white/60">
                    <p>{formatLegTime(leg)}</p>
                    <p>{formatDuration(leg.durationMinutes)}</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
