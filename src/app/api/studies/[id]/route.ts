import { disposeStudy, getStudy, StudySourceError } from "@/server/studySource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string }> };

function apiError(error: unknown): Response {
  if (error instanceof StudySourceError) {
    return Response.json({ code: error.code, message: error.message }, {
      status: error.status,
      headers: { "Cache-Control": "no-store" }
    });
  }
  return Response.json({ code: "STUDY_REQUEST_FAILED", message: "无法读取影像会话。" }, {
    status: 500,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    return Response.json(getStudy(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id } = await context.params;
    await disposeStudy(id);
    return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
