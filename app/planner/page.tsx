import Link from "next/link";
import { PlannerForm } from "@/components/planner/planner-form";
import { getPlannerCatalogStatus } from "@/features/planner/catalog";
import { appEnv } from "@/lib/env";

export default async function PlannerPage() {
  const catalogStatus = await getPlannerCatalogStatus();

  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <section className="mb-8 rounded-[2.5rem] border border-white/50 bg-grain p-8 shadow-tide sm:p-10">
          <p className="text-sm uppercase tracking-[0.32em] text-lagoon/70">
            Jeju Bus Guide Tour
          </p>
          <h1 className="mt-3 max-w-3xl text-4xl font-semibold leading-tight text-ink sm:text-5xl">
            제주 버스로 이어지는 하루.
            <br />
            장소 순서와 체류시간만 정하면 바로 플랜으로 바뀝니다.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-ink/70 sm:text-lg">
            실데이터 ingest가 끝나면 자동완성 검색, 버스 기반 후보 3종 계산, 실행 세션
            추적까지 한 번에 이어집니다.
          </p>

          {!catalogStatus.ready ? (
            <div className="mt-6 rounded-[1.75rem] border border-coral/20 bg-coral/10 p-5 text-ink">
              <p className="text-sm font-semibold text-coral">먼저 ingest 필요</p>
              <p className="mt-2 text-sm leading-6 text-ink/75">{catalogStatus.message}</p>
              {appEnv.enableInternalAdmin ? (
                <Link
                  href="/admin"
                  className="mt-4 inline-flex rounded-full border border-ink/10 bg-white px-4 py-2 text-sm font-semibold text-ink transition hover:border-lagoon/30 hover:text-lagoon"
                >
                  내부 관리자 열기
                </Link>
              ) : null}
            </div>
          ) : null}
        </section>

        <PlannerForm
          catalogReady={catalogStatus.ready}
          setupMessage={catalogStatus.ready ? null : catalogStatus.message}
        />
      </div>
    </main>
  );
}
