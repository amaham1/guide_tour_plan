import { NextRequest, NextResponse } from "next/server";
import { createPlannerResult } from "@/features/planner/service";
import { getErrorMessage, getErrorStatus } from "@/lib/api-error";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result = await createPlannerResult(body);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      {
        error: getErrorMessage(error, "플랜 생성에 실패했습니다."),
      },
      { status: getErrorStatus(error) },
    );
  }
}
