import { NextRequest, NextResponse } from "next/server";
import { searchCatalog } from "@/features/planner/service";
import { getErrorMessage, getErrorStatus } from "@/lib/api-error";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const results = await searchCatalog({
      kind: searchParams.get("kind"),
      q: searchParams.get("q"),
      limit: searchParams.get("limit") ?? undefined,
      includeGeneratedStops: searchParams.get("includeGeneratedStops") ?? undefined,
    });

    return NextResponse.json({
      results,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: getErrorMessage(error, "검색에 실패했습니다."),
      },
      { status: getErrorStatus(error) },
    );
  }
}
