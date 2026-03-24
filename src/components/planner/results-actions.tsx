"use client";

import { startTransition, useState } from "react";
import { useRouter } from "next/navigation";
import { Play } from "lucide-react";

type ResultsActionsProps = {
  planCandidateId: string;
};

export function ResultsActions({ planCandidateId }: ResultsActionsProps) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleStart() {
    setPending(true);
    setError(null);

    startTransition(() => {
      void (async () => {
        try {
          const response = await fetch("/api/planner/session", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              planCandidateId,
            }),
          });

          const payload = (await response.json()) as {
            executeUrl?: string;
            error?: string;
          };

          if (!response.ok || !payload.executeUrl) {
            throw new Error(payload.error ?? "실행 세션 생성에 실패했습니다.");
          }

          router.push(payload.executeUrl);
        } catch (requestError) {
          setError(
            requestError instanceof Error
              ? requestError.message
              : "실행 세션 생성에 실패했습니다.",
          );
        } finally {
          setPending(false);
        }
      })();
    });
  }

  return (
    <div className="mt-5">
      <button
        type="button"
        onClick={handleStart}
        disabled={pending}
        className="inline-flex items-center gap-2 rounded-2xl bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-lagoon disabled:cursor-wait disabled:bg-ink/35"
      >
        <Play className="size-4" />
        {pending ? "실행 세션 여는 중..." : "이 후보로 실행 시작"}
      </button>
      {error ? <p className="mt-2 text-sm text-coral">{error}</p> : null}
    </div>
  );
}
