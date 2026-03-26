"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function RunAllButton() {
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
            body: JSON.stringify({ runAll: true }),
          });
          router.refresh();
        } finally {
          setPending(false);
        }
      }}
      className="rounded-2xl bg-ink px-4 py-3 text-sm font-semibold text-white transition hover:bg-lagoon disabled:cursor-wait disabled:bg-ink/40"
    >
      {pending ? "Running all..." : "Run all jobs"}
    </button>
  );
}
