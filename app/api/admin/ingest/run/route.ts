import { NextResponse } from "next/server";
import { z } from "zod";
import { getErrorMessage, getErrorStatus } from "@/lib/api-error";
import { assertInternalAdminEnabled } from "@/lib/admin";
import { runAllJobs, runJobByKey } from "@/worker/core/job-runner";

const bodySchema = z.object({
  jobKey: z.string().optional(),
  runAll: z.boolean().optional(),
});

export async function POST(request: Request) {
  try {
    assertInternalAdminEnabled();

    const body = bodySchema.parse(await request.json());

    if (body.runAll) {
      const results = await runAllJobs({ triggeredBy: "admin" });
      return NextResponse.json({ results });
    }

    if (!body.jobKey) {
      return NextResponse.json(
        { error: "jobKey is required when runAll is false." },
        { status: 400 },
      );
    }

    const results = await runJobByKey(body.jobKey, { triggeredBy: "admin" });
    return NextResponse.json({ results });
  } catch (error) {
    return NextResponse.json(
      {
        error: getErrorMessage(error, "Ingest run failed."),
      },
      {
        status: getErrorStatus(error),
      },
    );
  }
}
