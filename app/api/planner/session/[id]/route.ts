import { NextResponse } from "next/server";
import { getExecutionSessionStatus } from "@/features/planner/service";
import { getErrorMessage, getErrorStatus } from "@/lib/api-error";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const status = await getExecutionSessionStatus(id);
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json(
      {
        error: getErrorMessage(error, "실행 상태 조회에 실패했습니다."),
      },
      { status: getErrorStatus(error) },
    );
  }
}
