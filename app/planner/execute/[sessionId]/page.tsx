import { notFound } from "next/navigation";
import { ExecutePanel } from "@/components/planner/execute-panel";
import { getExecutionSessionStatus } from "@/features/planner/service";

export default async function PlannerExecutePage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  let status;
  try {
    status = await getExecutionSessionStatus(sessionId);
  } catch {
    notFound();
  }

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <section className="mb-8 rounded-[2.5rem] border border-white/40 bg-[rgba(255,249,240,0.8)] p-8 shadow-tide backdrop-blur sm:p-10">
          <p className="text-sm uppercase tracking-[0.32em] text-lagoon/70">
            Execution Session
          </p>
          <h1 className="mt-3 text-4xl font-semibold text-ink sm:text-5xl">
            지금 해야 할 행동만 간결하게 보여줍니다.
          </h1>
          <p className="mt-4 max-w-3xl text-base leading-7 text-ink/70">
            30초 polling 기준으로 현재 leg와 다음 leg를 갱신하고, GNSS 실시간 적용이
            실패해도 같은 스키마로 시간표 fallback 상태를 유지합니다.
          </p>
        </section>

        <ExecutePanel initialStatus={status} />
      </div>
    </main>
  );
}
