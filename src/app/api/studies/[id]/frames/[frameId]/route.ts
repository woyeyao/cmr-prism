import { readScalarFrame, StudySourceError } from "@/server/studySource";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ id: string; frameId: string }> };

function apiError(error: unknown): Response {
  if (error instanceof StudySourceError) {
    return Response.json({ code: error.code, message: error.message }, {
      status: error.status,
      headers: { "Cache-Control": "no-store" }
    });
  }
  return Response.json({ code: "FRAME_READ_FAILED", message: "无法读取此影像帧，请重试或重新导入。" }, {
    status: 500,
    headers: { "Cache-Control": "no-store" }
  });
}

export async function GET(_request: Request, context: RouteContext): Promise<Response> {
  try {
    const { id, frameId } = await context.params;
    const pixels = await readScalarFrame(id, frameId);
    const buffer = new ArrayBuffer(pixels.length * Float32Array.BYTES_PER_ELEMENT);
    const view = new DataView(buffer);
    for (let index = 0; index < pixels.length; index += 1) view.setFloat32(index * 4, pixels[index], true);
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/vnd.cmr-prism.float32; endian=little",
        "Content-Length": String(buffer.byteLength),
        "X-Frame-Pixel-Count": String(pixels.length),
        "Cache-Control": "no-store"
      }
    });
  } catch (error) {
    return apiError(error);
  }
}
