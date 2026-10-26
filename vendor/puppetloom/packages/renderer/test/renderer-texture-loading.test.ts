import { afterEach, describe, expect, it, vi } from "vitest";
import type { PuppetLoomProject } from "@puppetloom/core/browser";
import { PuppetRenderer, type TextureResolver } from "../src/renderer.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

afterEach(() => vi.unstubAllGlobals());

describe("PuppetRenderer texture loading", () => {
  it("stops claiming layers after a failure and waits for active workers to close bitmaps", async () => {
    const layers = Array.from({ length: 6 }, (_, index) => ({ id: `layer-${index}` }));
    const project = {
      layers,
      model: { bindings: [] },
      runtime: {}
    } as unknown as PuppetLoomProject;
    const renderer = Object.create(PuppetRenderer.prototype) as PuppetRenderer & { currentProject: PuppetLoomProject };
    renderer.currentProject = project;
    const createResources = vi.spyOn(renderer as any, "createLayerResources").mockImplementation(() => undefined);
    const deferredSources = layers.slice(1, 4).map(() => deferred<ImageBitmapSource>());
    const closeMocks = deferredSources.map(() => vi.fn());
    const bitmaps = closeMocks.map((close) => ({ close }) as unknown as ImageBitmap);
    const bitmapQueue = [...bitmaps];
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmapQueue.shift()!));
    const started: string[] = [];
    const resolveTexture: TextureResolver = async (layer) => {
      started.push(layer.id);
      if (layer.id === "layer-0") throw new Error("texture failed");
      return deferredSources[Number(layer.id.split("-")[1]) - 1]!.promise;
    };
    const loadTextures = (renderer as unknown as { loadTextures: (resolver: TextureResolver) => Promise<void> })
      .loadTextures.bind(renderer);

    let settled = false;
    const load = loadTextures(resolveTexture).finally(() => { settled = true; });
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const settledBeforeActiveWorkersFinish = settled;

    for (let index = 0; index < deferredSources.length; index += 1) {
      deferredSources[index]!.resolve({} as ImageBitmapSource);
    }
    await expect(load).rejects.toThrow("texture failed");

    expect(started.slice(0, 4)).toEqual(["layer-0", "layer-1", "layer-2", "layer-3"]);
    expect(settledBeforeActiveWorkersFinish).toBe(false);
    expect(started).toHaveLength(4);
    expect(createResources).not.toHaveBeenCalled();
    expect(closeMocks.every((close) => close.mock.calls.length === 1)).toBe(true);
  });
});
