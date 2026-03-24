import { NextRequest, NextResponse } from "next/server";
import { createExecutionSession } from "@/features/planner/service";
import { getErrorMessage, getErrorStatus } from "@/lib/api-error";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const session = await createExecutionSession(body);
    return NextResponse.json(session);
  } catch (error) {
    return NextResponse.json(
      {
        error: getErrorMessage(error, "실행 세션 생성에 실패했습니다."),
      },
      { status: getErrorStatus(error) },
    );
  }
}
