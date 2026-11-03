import { access, mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { neutralMotionState } from "../src/deform.js";
import { loadProjectTextureSources, loadProjectTextureSourcesLowMemory, renderProjectDirectoryPoseLowMemory, renderProjectPoseWithSources } from "../src/offline-render.js";
import { featureGatedMotionState } from "../src/render-contract.js";
import { compareNeutralProjectStates, compareProjectRevisions, compareProjectStates, renderProjectSuiteFromProject } from "../src/render-suite.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import type { LayerBinding, PuppetLoomProject } from "../src/types.js";

function layer(id: string, order: number, blendMode = "normal"): LayerBinding {
  return {
    id, sourceName: id, sourcePath: [id], role: "accessory", side: "center", order, opacity: 1, blendMode,
    bounds: { x: 0, y: 0, width: 1, height: 1 }, texture: `textures/${id}.png`, pivot: { x: 0.5, y: 0.5 },
    mesh: {
      rows: 2, cols: 2,
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      triangles: [0, 1, 2, 1, 3, 2]
    },
    weights: { head: 0, body: 0, gaze: 0, physics: 0 }, parentGroup: "root"
  };
}

function project(layers: LayerBinding[]): PuppetLoomProject {
  return {
    version: 2, name: "render-contract", canvas: { width: 10, height: 10 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/fixture.psd" },
    rigLevel: "minimal", layers, anchors: {},
    runtime: {
      seed: 1, profile: "calm-v1",
      envelope: { headYaw: 0, headPitch: 0, headRollDegrees: 0, bodySway: 0, bodyRollDegrees: 0, gazeX: 0, gazeY: 0, breath: 0, globalScale: 1 },
      features: { headTurn: false, bodyFollow: false, gaze: false, hairPhysics: false, blink: false, mouthMotion: false }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] }, disabledReasons: []
  };
}

function pixel(red: number, green: number, blue: number, alpha: number) {
  return { width: 1, height: 1, data: new Uint8ClampedArray([red, green, blue, alpha]) };
}

async function writeTexture(root: string, relativePath: string, width: number, height: number, data: number[]): Promise<void> {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await sharp(Buffer.from(data), { raw: { width, height, channels: 4 } }).png().toFile(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe("offline renderer contract", () => {
  it("occludes a saturated iris during partial closure instead of crossfading it into the face", () => {
    const skin = layer("skin", 0), white = { ...layer("white", 1), role: "eyeWhite" as const };
    const iris = { ...layer("iris", 2), role: "iris" as const, clipLayerId: white.id };
    const closed = { ...layer("closed", 3), role: "eyeClosed" as const };
    closed.mesh = { ...closed.mesh, topology: "art" };
    const value = project([skin, white, iris, closed]);
    for (const surface of [white, iris, closed]) (surface as LayerBinding).blinkMode = "geometry";
    value.model = createDefaultAuthoringModel();
    value.model.bindings.push({ id: "test-aperture", parameterIds: ["param-blink"], target: { kind: "layer", id: white.id }, keyforms: [
      { values: [0] }, { values: [1], transform: { scale: { x: 1, y: 0.02 } } }
    ] });
    value.runtime.features.blink = true;
    const sources = new Map([[skin.id, pixel(250, 220, 210, 255)], [white.id, pixel(255, 255, 255, 255)], [iris.id, pixel(240, 0, 0, 255)], [closed.id, pixel(0, 0, 0, 255)]]);
    const result = renderProjectPoseWithSources(value, sources, { ...neutralMotionState, blink: 0.65 }, 40, 40);
    const colors = Array.from({ length: 1600 }, (_, i) => Array.from(result.data.slice(i * 4, i * 4 + 3)).join(","));
    expect(colors).toContain("240,0,0");
    expect(colors).toContain("250,220,210");
    expect(colors.every((color) => ["240,0,0", "250,220,210", "255,255,255"].includes(color))).toBe(true);
  });
  it("lets the global blink drive both eyes until an asymmetric side is explicitly controlled", () => {
    const value = project([]);
    value.runtime.features.blink = true;
    value.runtime.features.asymmetricBlink = true;
    const global = featureGatedMotionState(value, { ...neutralMotionState, parameters: { "param-blink": 1 } });
    expect(global.blink).toBe(1);
    expect(global.blinkLeft).toBe(1);
    expect(global.blinkRight).toBe(1);
    const globalSecondPass = featureGatedMotionState(value, global);
    expect(globalSecondPass.blink).toBe(1);
    expect(globalSecondPass.blinkLeft).toBe(1);
    expect(globalSecondPass.blinkRight).toBe(1);

    const asymmetric = featureGatedMotionState(value, {
      ...neutralMotionState,
      parameters: { "param-blink": 1, "param-blink-left": 0.25 }
    });
    expect(asymmetric.blinkLeft).toBe(0.25);
    expect(asymmetric.blinkRight).toBe(1);
  });

  it.each([
    ["normal", [128, 0, 127]],
    ["multiply", [0, 0, 127]],
    ["screen", [128, 0, 255]],
    ["add", [128, 0, 255]],
    ["darken", [0, 0, 0]],
    ["lighten", [128, 0, 255]]
  ])("matches premultiplied WebGL %s blending", (mode, expected) => {
    const bottom = layer("bottom", 0);
    const top = layer("top", 1, mode);
    const result = renderProjectPoseWithSources(project([bottom, top]), new Map([
      [bottom.id, pixel(0, 0, 255, 255)],
      [top.id, pixel(255, 0, 0, 128)]
    ]), neutralMotionState, 1, 1);
    expect(Array.from(result.data.slice(0, 3))).toEqual(expected);
    expect(result.data[3]).toBe(255);
  });

  it("uses the deformed clip texture alpha instead of its rectangular bounds", () => {
    const clip = { ...layer("clip", 0), visible: false };
    const child = { ...layer("child", 1), clipLayerId: clip.id };
    const result = renderProjectPoseWithSources(project([clip, child]), new Map([
      [clip.id, { width: 2, height: 1, data: new Uint8ClampedArray([255, 255, 255, 0, 255, 255, 255, 255]) }],
      [child.id, pixel(255, 0, 0, 255)]
    ]), neutralMotionState, 10, 2);
    expect(result.data[3]).toBe(0);
    expect(result.data[(0 * 10 + 5) * 4 + 3]).toBe(255);
  });

  it("low-memory loading keeps shared materials, skips hidden non-clips, and retains hidden clips", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-low-memory-"));
    try {
      const clip = { ...layer("clip", 0), visible: false, texture: "textures/clip.png" };
      const shared = { ...layer("shared", 1), opacity: 0, texture: "textures/shared.png" };
      const child = { ...layer("child", 2), clipLayerId: clip.id, texture: "./textures/shared.png" };
      const hiddenClip = { ...layer("hidden-clip", 3), visible: false, texture: "textures/missing-clip.png" };
      const hidden = { ...layer("hidden", 4), visible: false, clipLayerId: hiddenClip.id, texture: "textures/missing.png" };
      const value = project([clip, shared, child, hiddenClip, hidden]);
      await writeTexture(root, "textures/clip.png", 3, 1, [255, 255, 255, 0, 255, 255, 255, 0, 255, 255, 255, 255]);
      await writeTexture(root, "textures/shared.png", 1, 1, [240, 20, 10, 255]);

      const sources = await loadProjectTextureSourcesLowMemory(root, value);
      expect([...sources.keys()]).toEqual([clip.id, shared.id, child.id]);
      expect(sources.get(shared.id)).toBe(sources.get(child.id));
      const result = renderProjectPoseWithSources(value, sources, neutralMotionState, 10, 2);
      const streamed = await renderProjectDirectoryPoseLowMemory(root, value, neutralMotionState, 10, 2);
      expect(Array.from(streamed.data)).toEqual(Array.from(result.data));
      // The 10×10 project is aspect-fitted into 10×2, so its content occupies x=4..5.
      expect(result.data[(0 * 10 + 4) * 4 + 3]).toBe(0);
      expect(result.data[(0 * 10 + 5) * 4 + 3]).toBe(255);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps public loading unchanged and makes low-memory render-suite output pixel-exact across poses", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-low-memory-ab-"));
    try {
      const bottom = layer("bottom", 0);
      const top = { ...layer("top", 1), texture: "textures/shared.png" };
      const hidden = { ...layer("hidden", 2), visible: false, texture: "textures/hidden.png" };
      const value = project([bottom, top, hidden]);
      value.runtime.features.headTurn = true;
      value.runtime.envelope.headYaw = 0.3;
      bottom.weights = { ...bottom.weights, head: 1 };
      await writeTexture(root, bottom.texture, 1, 1, [10, 20, 220, 255]);
      await writeTexture(root, top.texture, 1, 1, [220, 20, 10, 255]);
      await writeTexture(root, hidden.texture, 1, 1, [20, 220, 10, 255]);

      const publicSources = await loadProjectTextureSources(root, value);
      const lowMemorySources = await loadProjectTextureSourcesLowMemory(root, value);
      expect([...publicSources.keys()]).toEqual([bottom.id, top.id, hidden.id]);
      expect([...lowMemorySources.keys()]).toEqual([bottom.id, top.id]);
      const states = [
        neutralMotionState,
        { ...neutralMotionState, headYaw: 0.8 },
        { ...neutralMotionState, headPitch: -0.5, breath: 0.4 }
      ];
      for (const state of states) {
        const publicPixels = renderProjectPoseWithSources(value, publicSources, state, 24, 24);
        const lowMemoryPixels = renderProjectPoseWithSources(value, lowMemorySources, state, 24, 24);
        const streamedPixels = await renderProjectDirectoryPoseLowMemory(root, value, state, 24, 24);
        expect(Array.from(lowMemoryPixels.data)).toEqual(Array.from(publicPixels.data));
        expect(Array.from(streamedPixels.data)).toEqual(Array.from(publicPixels.data));
      }

      const publicSuite = await renderProjectSuiteFromProject(root, value, join(root, "public"), "poses", 1, [], { size: 300 });
      const lowMemorySuite = await renderProjectSuiteFromProject(root, value, join(root, "low-memory"), "poses", 1, [], { size: 300, lowMemoryTextures: true });
      const streamingSuite = await renderProjectSuiteFromProject(root, value, join(root, "streaming"), "poses", 1, [], { size: 300, streamingTextures: true });
      expect(lowMemorySuite.artifacts.map((artifact) => artifact.id)).toEqual(publicSuite.artifacts.map((artifact) => artifact.id));
      expect(streamingSuite.artifacts.map((artifact) => artifact.id)).toEqual(publicSuite.artifacts.map((artifact) => artifact.id));
      for (const artifact of publicSuite.artifacts) {
        const lowMemoryArtifact = lowMemorySuite.artifacts.find((candidate) => candidate.id === artifact.id);
        expect(lowMemoryArtifact).toBeDefined();
        expect(await readFile(lowMemoryArtifact!.path)).toEqual(await readFile(artifact.path));
        const streamingArtifact = streamingSuite.artifacts.find((candidate) => candidate.id === artifact.id);
        expect(streamingArtifact).toBeDefined();
        expect(await readFile(streamingArtifact!.path)).toEqual(await readFile(artifact.path));
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("still reports a missing visible texture in low-memory mode", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-low-memory-missing-"));
    try {
      await expect(loadProjectTextureSourcesLowMemory(root, project([layer("missing", 0)]))).rejects.toThrow();
      const missingClip = { ...layer("missing-clip-child", 0), clipLayerId: "not-in-project" };
      await expect(loadProjectTextureSourcesLowMemory(root, project([missingClip]))).rejects.toThrow(/clip/);
      await expect(renderProjectDirectoryPoseLowMemory(root, project([missingClip]), neutralMotionState, 4, 4)).rejects.toThrow(/clip/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("selects the opt-in streaming renderer for poses, focus evidence, and neutral before/after", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-streaming-suite-"));
    try {
      const visible = layer("visible", 0);
      const hidden = { ...layer("hidden", 1), visible: false, texture: "textures/not-loaded.png" };
      const value = project([visible, hidden]);
      await writeTexture(root, visible.texture, 1, 1, [220, 30, 10, 255]);

      const streaming = await renderProjectSuiteFromProject(root, value, join(root, "streaming"), "poses", 1, [], {
        size: 300,
        streamingTextures: true
      });
      expect(streaming.artifacts.some((artifact) => artifact.id === "left-up")).toBe(true);
      expect(streaming.artifacts.some((artifact) => artifact.id === "pose-sheet")).toBe(true);

      const streamingFocus = await renderProjectSuiteFromProject(root, value, join(root, "streaming-focus"), "poses", 1, [], {
        size: 300,
        focus: "accessory",
        streamingTextures: true
      });
      expect(streamingFocus.artifacts.some((artifact) => artifact.id === "focus-left-up")).toBe(true);
      expect(streamingFocus.focus?.scope).toBe("accessory");

      const neutral = await compareNeutralProjectStates(root, value, value, join(root, "neutral"), { streamingTextures: true });
      expect(neutral.changedPixelRatio).toBe(0);
      expect(neutral.meanAbsoluteDifference).toBe(0);

      await expect(renderProjectSuiteFromProject(root, value, join(root, "default"), "poses", 1, [], { size: 300 })).rejects.toThrow();
      await writeTexture(root, hidden.texture, 1, 1, [10, 20, 30, 255]);
      const changed = project([{ ...visible, opacity: 0.5 }, hidden]);
      const changedNeutral = await compareNeutralProjectStates(root, value, changed, join(root, "changed-neutral"), { streamingTextures: true });
      expect(changedNeutral.changedPixelRatio).toBeGreaterThan(0);
      expect(changedNeutral.meanAbsoluteDifference).toBeGreaterThan(0);
      const defaultFocus = await renderProjectSuiteFromProject(root, value, join(root, "default-focus"), "poses", 1, [], {
        size: 300,
        focus: "accessory"
      });
      const streamingFocusWithAllTextures = await renderProjectSuiteFromProject(root, value, join(root, "streaming-focus-with-all-textures"), "poses", 1, [], {
        size: 300,
        focus: "accessory",
        streamingTextures: true
      });
      for (const artifact of defaultFocus.artifacts.filter((candidate) => candidate.id.startsWith("focus-"))) {
        const streamingArtifact = streamingFocusWithAllTextures.artifacts.find((candidate) => candidate.id === artifact.id);
        expect(streamingArtifact).toBeDefined();
        expect(await readFile(streamingArtifact!.path)).toEqual(await readFile(artifact.path));
      }
      await expect(renderProjectSuiteFromProject(root, value, join(root, "ambiguous"), "poses", 1, [], {
        size: 300,
        lowMemoryTextures: true,
        streamingTextures: true
      })).rejects.toThrow(/不能同時指定/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects conflicting texture flags before compare wrappers create output or read projects", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-streaming-preflight-"));
    try {
      const options = { lowMemoryTextures: true, streamingTextures: true } as const;
      const revisionOutput = join(root, "revision-output");
      const stateOutput = join(root, "state-output");
      const neutralOutput = join(root, "neutral-output");
      await expect(compareProjectRevisions(root, 0, 1, revisionOutput, [], options)).rejects.toThrow(/不能同時指定/);
      await expect(compareProjectStates(root, project([]), project([]), 0, 1, stateOutput, [], options)).rejects.toThrow(/不能同時指定/);
      await expect(compareNeutralProjectStates(root, project([]), project([]), neutralOutput, options)).rejects.toThrow(/不能同時指定/);
      expect(await pathExists(revisionOutput)).toBe(false);
      expect(await pathExists(stateOutput)).toBe(false);
      expect(await pathExists(neutralOutput)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("validates size and focus before decoding a missing texture", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-render-preflight-"));
    try {
      const value = project([layer("missing", 0)]);
      for (const options of [{}, { lowMemoryTextures: true }, { streamingTextures: true }]) {
        await expect(renderProjectSuiteFromProject(root, value, join(root, "invalid-size"), "poses", 1, [], { ...options, size: 299 })).rejects.toThrow(/300 到 1600/);
        await expect(renderProjectSuiteFromProject(root, value, join(root, "invalid-focus"), "poses", 1, [], { ...options, focus: "eyes" })).rejects.toThrow(/没有可用于 eyes/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
