import { importStudy, StudySourceError } from "@/server/studySource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function apiError(error: unknown): Response {
  if (error instanceof StudySourceError) {
    return Response.json({ code: error.code, message: error.message }, {
      status: error.status,
      headers: { "Cache-Control": "no-store" }
    });
  }
  return Response.json({ code: "IMPORT_FAILED", message: "影像导入失败，请检查文件后重试。" }, {
    status: 500,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request): Promise<Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 1024 * 1024 * 1024 + 16 * 1024 * 1024) {
    return Response.json({ code: "IMPORT_TOO_LARGE", message: "导入文件总量超过 1 GiB 限制。" }, {
      status: 413,
      headers: { "Cache-Control": "no-store" }
    });
  }
  try {
    const form = await request.formData();
    const files = form.getAll("files").filter((entry): entry is File => typeof entry === "object" && entry !== null && "arrayBuffer" in entry && "stream" in entry) as File[];
    return Response.json(await importStudy(files), { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return apiError(error);
  }
}
