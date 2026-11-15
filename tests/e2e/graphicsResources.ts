import type { Page } from "@playwright/test";

type ResourceCounts = Record<string, number>;

/** Count real browser allocations, including resources reclaimed on context loss. */
export async function trackGraphicsResources(page: Page) {
  await page.addInitScript(() => {
    const live: Record<string, number> = { buffers: 0, textures: 0, programs: 0, framebuffers: 0, renderbuffers: 0, vertexArrays: 0 };
    (window as unknown as { anatomyResources: Record<string, number> }).anatomyResources = live;
    const contexts = new WeakMap<WebGL2RenderingContext, Map<object, string>>();
    for (const [create, remove, key] of [
      ["createBuffer", "deleteBuffer", "buffers"], ["createTexture", "deleteTexture", "textures"],
      ["createProgram", "deleteProgram", "programs"], ["createFramebuffer", "deleteFramebuffer", "framebuffers"],
      ["createRenderbuffer", "deleteRenderbuffer", "renderbuffers"], ["createVertexArray", "deleteVertexArray", "vertexArrays"],
    ]) {
      const prototype = WebGL2RenderingContext.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
      const allocate = prototype[create], release = prototype[remove];
      prototype[create] = function (this: WebGL2RenderingContext, ...args: unknown[]) {
        const object = allocate.apply(this, args) as object | null;
        if (!contexts.has(this)) {
          const resources = new Map<object, string>();
          contexts.set(this, resources);
          this.canvas.addEventListener("webglcontextlost", () => {
            for (const kind of resources.values()) live[kind]--;
            resources.clear();
          });
        }
        if (object) { contexts.get(this)!.set(object, key); live[key]++; }
        return object;
      };
      prototype[remove] = function (this: WebGL2RenderingContext, object: unknown) {
        if (object && contexts.get(this)?.delete(object as object)) live[key]--;
        return release.call(this, object);
      };
    }
  });
}

export const graphicsResources = (page: Page) => page.evaluate(() =>
  ({ ...(window as unknown as { anatomyResources: ResourceCounts }).anatomyResources }),
);

export const zeroGraphicsResources = { buffers: 0, textures: 0, programs: 0, framebuffers: 0, renderbuffers: 0, vertexArrays: 0 };
