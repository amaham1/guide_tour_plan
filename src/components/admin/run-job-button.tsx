"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RunJobButton({ jobKey }: { jobKey: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  return (
    <button
      type="button"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          await fetch("/api/admin/ingest/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ jobKey }),
          });
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
      className="rounded-xl border border-ink/10 bg-white px-3 py-2 text-sm font-medium text-ink transition hover:border-lagoon/35 hover:text-lagoon disabled:cursor-wait disabled:opacity-60"
    >
      {pending ? "실행 중..." : "지금 실행"}
    </button>
  );
}
