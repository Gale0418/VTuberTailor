import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  applyCalibrationOverrides,
  applyCalibrationOverridesForInteractivePreview,
  applyCalibrationOverridesForPreview,
  buildGeneratedLayerCloneOverrides,
  buildLayerTriangleSplitOverrides,
  mergeCalibrationOverrides,
  mergeCalibrationOverridesForPreview,
  rebaseCalibrationOverridesForPreview
} from "../src/calibration.js";
import { buildArtMesh } from "../src/art-mesh.js";
import { restoreCalibrationRevision, saveAuthoringPatch, saveCalibrationPatch } from "../src/calibration-store.js";
import { makeGridMesh } from "../src/rig.js";
import { layersInRenderOrder } from "../src/render-contract.js";
import { initializeCalibration, loadProject, prepareGeneratedLayerClonePatch, prepareLayerTriangleSplitPatch } from "../src/project-store.js";
import { createDefaultAuthoringModel } from "../src/model.js";
import type { LayerBinding, LayerTriangleSplitOperation, PuppetLoomProject } from "../src/types.js";

function layer(id: string, order: number): LayerBinding {
  return {
    id,
    sourceName: id,
    sourcePath: [id],
    role: "accessory",
    side: "center",
    order,
    opacity: 1,
    blendMode: "normal",
    bounds: { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
    texture: `textures/${id}.png`,
    pivot: { x: 0.4, y: 0.4 },
    mesh: makeGridMesh({ x: 0.2, y: 0.2, width: 0.4, height: 0.4 }, 3, 3),
    weights: { head: 0, body: 0, gaze: 0, physics: 1 },
    parentGroup: "root"
  };
}

function project(): PuppetLoomProject {
  return {
    version: 2,
    name: "calibration-overrides",
    canvas: { width: 512, height: 512 },
    source: { originalFileName: "fixture.psd", psdSha256: "0".repeat(64), psdPath: "source/source.psd" },
    rigLevel: "grouped",
    layers: [layer("parent", 0), layer("child", 1)],
    model: createDefaultAuthoringModel(),
    anchors: {},
    runtime: {
      seed: 42,
      profile: "calm-v1",
      features: { headTurn: true, bodyFollow: true, gaze: true, hairPhysics: true, blink: false, mouthMotion: false },
      envelope: { headYaw: 0.2, headPitch: 0.1, headRollDegrees: 2, bodySway: 0.01, bodyRollDegrees: 1, gazeX: 0.1, gazeY: 0.1, breath: 0.003, globalScale: 1 }
    },
    quality: { poseValidations: [], safetyScale: 1, issues: [] },
    disabledReasons: []
  };
}

async function installSplitProvenance(root: string, candidate: PuppetLoomProject, png: Buffer): Promise<void> {
  candidate.canvas = { width: 1, height: 1 };
  for (const layer of candidate.layers) layer.bounds = { x: 0, y: 0, width: 1, height: 1 };
  await mkdir(join(root, "assets", "originals"), { recursive: true });
  await mkdir(join(root, "assets", "references"), { recursive: true });
  await mkdir(join(root, "assets", "registrations"), { recursive: true });
  await mkdir(join(root, "textures"), { recursive: true });
  await writeFile(join(root, "textures", "parent.png"), png);
  await writeFile(join(root, "textures", "child.png"), png);
  const imageSha256 = createHash("sha256").update(png).digest("hex");
  const originalPath = `assets/originals/${imageSha256}.png`;
  await writeFile(join(root, originalPath), png);
  const referenceBody = {
    version: 1,
    baseRevision: 0,
    fingerprint: "synthetic",
    templateLayerId: "r30-face-upper",
    canvas: candidate.canvas,
    sourceRect: { x: 0, y: 0, width: 1, height: 1 },
    cleanPath: originalPath,
    cleanSha256: imageSha256,
    contextPath: originalPath,
    contextSha256: imageSha256,
    annotationPath: originalPath,
    annotationSha256: imageSha256
  };
  const referenceBytes = Buffer.from(JSON.stringify(referenceBody));
  const referenceId = createHash("sha256").update(referenceBytes).digest("hex");
  await writeFile(join(root, "assets", "references", `${referenceId}.json`), referenceBytes);
  const registrationBody = {
    version: 1,
    referenceId,
    originalPath,
    originalSha256: imageSha256,
    texture: "textures/parent.png",
    textureSha256: imageSha256,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    registration: {
      matrix: { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 },
      rmsErrorPixels: 0,
      input: { kind: "frame", generatedRect: { x: 0, y: 0, width: 1, height: 1 }, sourceRect: { x: 0, y: 0, width: 1, height: 1 }, textureScale: 1, preserveFrame: true },
      warnings: []
    }
  };
  const registrationBytes = Buffer.from(JSON.stringify(registrationBody));
  const registrationId = createHash("sha256").update(registrationBytes).digest("hex");
  await writeFile(join(root, "assets", "registrations", `${registrationId}.json`), registrationBytes);
  candidate.layers[0]!.generatedAsset = { referenceId, registrationId, imageSha256, templateLayerId: "r30-face-upper" };
}

describe("calibration override contract", () => {
  it("routes explicit low-memory loading through suite and rebuilt-neutral evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-low-memory-save-"));
    try {
      const candidate = project();
      const visible = candidate.layers[0]!;
      const hiddenClip = candidate.layers[1]!;
      hiddenClip.visible = false;
      visible.clipLayerId = hiddenClip.id;
      const hiddenUnused = { ...hiddenClip, id: "unused-hidden", sourceName: "unused-hidden", sourcePath: ["unused-hidden"], texture: "textures/missing.png", clipLayerId: undefined };
      candidate.layers = [visible, hiddenClip, hiddenUnused];
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      await mkdir(join(root, "textures"), { recursive: true });
      await writeFile(join(root, "textures", "parent.png"), png);
      await writeFile(join(root, "textures", "child.png"), png);
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(candidate)}\n`, "utf8");
      await initializeCalibration(root);

      const first = await saveCalibrationPatch(root, {
        baseRevision: 0,
        overrides: { runtime: { motionTuning: { response: 0.501 } } }
      }, { lowMemoryTextures: true });
      expect(first.calibration.revision).toBe(1);
      expect(first.evidence.before.artifacts.length).toBeGreaterThan(0);

      const second = await saveCalibrationPatch(root, {
        baseRevision: 1,
        overrides: { layers: { [visible.id]: { meshDensity: { rows: 4, cols: 4 } } } }
      }, { lowMemoryTextures: true });
      expect(second.calibration.revision).toBe(2);
      expect((await stat(join(second.evidence.outputDirectory, "neutral-comparison.json"))).isFile()).toBe(true);

      const restored = await restoreCalibrationRevision(root, 1, 2, "low-memory restore", { lowMemoryTextures: true });
      expect(restored.calibration.revision).toBe(3);
      expect(restored.evidence.before.artifacts.length).toBeGreaterThan(0);

      const authored = await saveAuthoringPatch(root, {
        version: 1,
        baseRevision: 3,
        operations: [{ op: "set-layer-head-pose", layerId: visible.id, mode: "keyforms" }]
      }, { lowMemoryTextures: true });
      expect(authored.calibration.revision).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("splits an immutable generated layer by complete triangle ownership without changing texture, points or UVs", () => {
    const before = project();
    const source = before.layers[0]!;
    source.sourceLayerId = "native-parent";
    source.generatedAsset = {
      referenceId: "reference-r1",
      registrationId: "registration-r1",
      imageSha256: "a".repeat(64),
      templateLayerId: source.id
    };
    source.visible = false;
    before.model.bindings.push({
      id: "parent-motion",
      parameterIds: ["param-head-yaw"],
      target: { kind: "layer", id: source.id },
      keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0.02, y: 0 } } }]
    });
    const operation = {
      sourceLayerId: source.id,
      targets: [
        { layerId: "parent-left", semantic: { role: "ear" as const, side: "left" as const }, triangleIndices: [0, 1, 2, 3] },
        { layerId: "parent-right", semantic: { role: "ear" as const, side: "right" as const, visible: true }, triangleIndices: [4, 5, 6, 7] }
      ]
    };
    const overrides = buildLayerTriangleSplitOverrides(before, operation);
    const persisted = applyCalibrationOverrides(before, overrides);
    const preview = applyCalibrationOverridesForPreview(before, overrides);
    const left = persisted.layers.find((layer) => layer.id === "parent-left")!;
    const right = persisted.layers.find((layer) => layer.id === "parent-right")!;
    expect(preview).toEqual(persisted);
    expect(persisted.layers.find((layer) => layer.id === source.id)).toMatchObject({ visible: false });
    expect(left).toMatchObject({ texture: source.texture, role: "ear", side: "left", visible: false, order: 0, generatedAsset: source.generatedAsset });
    expect(right).toMatchObject({ texture: source.texture, role: "ear", side: "right", visible: true, order: 1, generatedAsset: source.generatedAsset });
    for (const child of [left, right]) {
      expect(child.mesh.points).toEqual(source.mesh.points);
      expect(child.mesh.uvs).toEqual(source.mesh.uvs);
      expect(child.mesh.influences).toEqual(source.mesh.influences);
      expect(child.sourcePath).toEqual([...source.sourcePath, "split", child.id]);
    }
    expect(left.mesh.triangles).toEqual(source.mesh.triangles.slice(0, 12));
    expect(right.mesh.triangles).toEqual(source.mesh.triangles.slice(12));
    expect(persisted.layers.find((layer) => layer.id === "child")!.order).toBe(2);
    expect(persisted.model.bindings.filter((binding) => binding.target.kind === "layer").map((binding) => [binding.id, binding.target.id])).toEqual([
      ["parent-motion", "parent"],
      ["parent-motion/split/parent-left", "parent-left"],
      ["parent-motion/split/parent-right", "parent-right"]
    ]);
    expect(before.layers).toHaveLength(2);
    expect(before.layers.find((layer) => layer.id === source.id)!.visible).toBe(false);
  });

  it("replaces a source at its stable order/index position when neighbouring layers share an order", () => {
    const before = project();
    const source = before.layers[0]!;
    source.generatedAsset = { referenceId: "reference-r1", registrationId: "registration-r1", imageSha256: "c".repeat(64), templateLayerId: source.id };
    before.layers = [
      { ...source, id: "before", sourceName: "before", order: 9 },
      { ...source, id: "parent", sourceName: "parent", order: 9 },
      { ...source, id: "after-same-order", sourceName: "after-same-order", order: 9 },
      { ...source, id: "after", sourceName: "after", order: 10 }
    ];
    const overrides = buildLayerTriangleSplitOverrides(before, {
      sourceLayerId: "parent",
      targets: [
        { layerId: "parent-left", triangleIndices: [0, 1, 2, 3] },
        { layerId: "parent-right", triangleIndices: [4, 5, 6, 7] }
      ]
    });
    const applied = applyCalibrationOverrides(before, overrides);
    expect(layersInRenderOrder(applied.layers).map((layer) => layer.id)).toEqual([
      "before", "parent-left", "parent-right", "after-same-order", "after"
    ]);
    expect(applied.layers.find((layer) => layer.id === "before")!.order).toBe(0);
    expect(applied.layers.find((layer) => layer.id === "parent-left")!.order).toBe(1);
    expect(applied.layers.find((layer) => layer.id === "parent-right")!.order).toBe(2);
    expect(applied.layers.find((layer) => layer.id === "after-same-order")!.order).toBe(3);
    expect(applied.layers.find((layer) => layer.id === "after")!.order).toBe(4);
  });

  it("fails closed when hiding the source would orphan parent, clip, collision or production references", () => {
    const generated = project();
    generated.layers[0]!.generatedAsset = {
      referenceId: "reference-r1", registrationId: "registration-r1", imageSha256: "d".repeat(64), templateLayerId: "parent"
    };
    const operation = { sourceLayerId: "parent", targets: [{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [1] }] };
    const references: Array<(candidate: PuppetLoomProject) => void> = [
      (candidate) => { candidate.layers[1]!.parentLayerId = "parent"; },
      (candidate) => { candidate.layers[1]!.clipLayerId = "parent"; },
      (candidate) => { candidate.runtime.constraints = { collisions: [{ id: "collision", name: "collision", movingLayerIds: ["child"], colliderLayerIds: ["parent"], padding: 0, maxCorrection: 0.1, strength: 1 }] }; },
      (candidate) => { candidate.production = { variants: [{ id: "variant", name: "variant", defaultOptionId: "option", options: [{ id: "option", name: "option", layerIds: ["parent"] }] }], props: [], presets: [] }; },
      (candidate) => { candidate.model.bindings.push({ id: "dynamic-order", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: "parent" }, keyforms: [{ values: [0], drawOrderOffset: 1 }, { values: [1], drawOrderOffset: -1 }] }); }
    ];
    for (const addReference of references) {
      const candidate = structuredClone(generated);
      addReference(candidate);
      expect(() => buildLayerTriangleSplitOverrides(candidate, operation)).toThrow(/无法安全隐藏/);
    }
  });

  it("prepares from the effective revision and round-trips through saveCalibrationPatch without losing asset layers or model bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-split-roundtrip-"));
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const before = project();
      const source = before.layers[0]!;
      await installSplitProvenance(root, before, png);
      before.model.bindings.push({ id: "parent-motion", parameterIds: ["param-head-yaw"], target: { kind: "layer", id: source.id }, keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0.01, y: 0 } } }] });
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(before)}\n`, "utf8");
      await initializeCalibration(root);
      const existing = { ...source, id: "existing-asset", sourceName: "existing-asset", sourcePath: ["generated", "existing-asset"], visible: false };
      await saveCalibrationPatch(root, { baseRevision: 0, overrides: { assetLayers: { [existing.id]: existing }, model: before.model } });
      const splitPatch = await prepareLayerTriangleSplitPatch(root, {
        sourceLayerId: source.id,
        targets: [
          { layerId: "parent-left", triangleIndices: [0, 1, 2, 3] },
          { layerId: "parent-right", triangleIndices: [4, 5, 6, 7] }
        ]
      });
      expect(splitPatch.baseRevision).toBe(1);
      expect(splitPatch.expectedBaseProjectSha256).toMatch(/^[a-f0-9]{64}$/);
      const saved = await saveCalibrationPatch(root, splitPatch);
      expect(saved.calibration.revision).toBe(2);
      const loaded = await loadProject(root);
      expect(loaded.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining(["existing-asset", "parent-left", "parent-right"]));
      expect(loaded.layers.find((layer) => layer.id === source.id)).toMatchObject({ visible: false });
      expect(loaded.layers.find((layer) => layer.id === "existing-asset")!.generatedAsset).toEqual(source.generatedAsset);
      expect(loaded.layers.find((layer) => layer.id === "parent-left")!.generatedAsset?.templateLayerId).toBe("r30-face-upper");
      expect(loaded.model.bindings.map((binding) => binding.id)).toEqual(expect.arrayContaining(["parent-motion", "parent-motion/split/parent-left", "parent-motion/split/parent-right"]));
      await expect(saveCalibrationPatch(root, splitPatch)).rejects.toThrow(/校准基线已从 1 更新到 2/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a prepared revision-zero patch when the base project changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-split-base-cas-"));
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const before = project();
      await installSplitProvenance(root, before, png);
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(before)}\n`, "utf8");
      await initializeCalibration(root);
      const splitPatch = await prepareLayerTriangleSplitPatch(root, {
        sourceLayerId: "parent",
        targets: [
          { layerId: "parent-left", triangleIndices: [0, 1, 2, 3] },
          { layerId: "parent-right", triangleIndices: [4, 5, 6, 7] }
        ]
      });
      expect(splitPatch.baseRevision).toBe(0);
      const changed = { ...before, name: "calibration-overrides-changed-base" };
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(changed)}\n`, "utf8");
      await expect(saveCalibrationPatch(root, splitPatch)).rejects.toThrow(/base-project SHA|基础项目已改变/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects a forged immutable registration before persisting a split", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-split-provenance-forgery-"));
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const candidate = project();
      await installSplitProvenance(root, candidate, png);
      const source = candidate.layers[0]!;
      const registrationPath = join(root, "assets", "registrations", `${source.generatedAsset!.registrationId}.json`);
      const forged = JSON.parse(await readFile(registrationPath, "utf8")) as { textureSha256: string };
      forged.textureSha256 = "0".repeat(64);
      const forgedBytes = Buffer.from(JSON.stringify(forged));
      const forgedId = createHash("sha256").update(forgedBytes).digest("hex");
      await writeFile(join(root, "assets", "registrations", `${forgedId}.json`), forgedBytes);
      source.generatedAsset!.registrationId = forgedId;
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(candidate)}\n`, "utf8");
      await initializeCalibration(root);
      await expect(prepareLayerTriangleSplitPatch(root, {
        sourceLayerId: source.id,
        targets: [
          { layerId: "parent-left", triangleIndices: [0, 1, 2, 3] },
          { layerId: "parent-right", triangleIndices: [4, 5, 6, 7] }
        ]
      })).rejects.toThrow(/texture PNG SHA-256/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects unknown, duplicate, missing and illegal triangle ownership", () => {
    const generated = project();
    generated.layers[0]!.generatedAsset = {
      referenceId: "reference-r1", registrationId: "registration-r1", imageSha256: "b".repeat(64), templateLayerId: "parent"
    };
    const split = (targets: LayerTriangleSplitOperation["targets"]) => buildLayerTriangleSplitOverrides(generated, { sourceLayerId: "parent", targets });
    expect(() => buildLayerTriangleSplitOverrides(generated, { sourceLayerId: "missing", targets: [{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [1] }] })).toThrow(/找不到/);
    expect(() => split([{ layerId: "left", triangleIndices: [0] }, { layerId: "left", triangleIndices: [1] }])).toThrow(/占用或重复/);
    expect(() => split([{ layerId: "left", triangleIndices: [0, 0] }, { layerId: "right", triangleIndices: [1] }])).toThrow(/重复声明/);
    expect(() => split([{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [0] }])).toThrow(/多个/);
    expect(() => split([{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [1] }])).toThrow(/遗漏/);
    expect(() => split([{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [8] }])).toThrow(/不存在/);
    expect(() => split([{ layerId: "left", triangleIndices: [] }, { layerId: "right", triangleIndices: [0, 1] }])).toThrow();
    const malformed = project();
    malformed.layers[0]!.generatedAsset = generated.layers[0]!.generatedAsset;
    malformed.layers[0]!.mesh.triangles[1] = malformed.layers[0]!.mesh.triangles[0]!;
    expect(() => buildLayerTriangleSplitOverrides(malformed, { sourceLayerId: "parent", targets: [{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [1] }] })).toThrow(/三角形不能重复引用同一顶点/);
    expect(() => buildLayerTriangleSplitOverrides(project(), { sourceLayerId: "parent", targets: [{ layerId: "left", triangleIndices: [0] }, { layerId: "right", triangleIndices: [1] }] })).toThrow(/immutable/);
  });

  it("adds generated-layer copies with custom schema mesh/order while preserving the source", () => {
    const before = project();
    const source = before.layers[0]!;
    source.sourceLayerId = "native-parent";
    source.generatedAsset = {
      referenceId: "reference-r1", registrationId: "registration-r1", imageSha256: "e".repeat(64), templateLayerId: "template-layer"
    };
    before.model.bindings.push({
      id: "source-motion",
      parameterIds: ["param-head-yaw"],
      target: { kind: "layer", id: source.id },
      keyforms: [{ values: [0] }, { values: [1], meshPointDeltas: { "0": { x: 0.01, y: 0 } } }]
    });
    const customMesh = JSON.parse(JSON.stringify(source.mesh)) as typeof source.mesh;
    customMesh.points[0] = { x: 0.23, y: 0.21 };
    const overrides = buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "generated-copy", mesh: customMesh, order: 17, semantic: { side: "left" } }]
    });
    const after = applyCalibrationOverrides(before, overrides);
    const copy = after.layers.find((layer) => layer.id === "generated-copy")!;
    expect(after.layers.find((layer) => layer.id === source.id)).toEqual(source);
    expect(copy).toMatchObject({ texture: source.texture, generatedAsset: source.generatedAsset, order: 17, side: "left" });
    expect(copy.mesh).toEqual(customMesh);
    expect(copy.sourceLayerId).toBeUndefined();
    expect(after.model.bindings.map((binding) => binding.id)).toEqual(["source-motion"]);
    expect(() => buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "invalid-copy", mesh: { ...customMesh, triangles: [0, 0, 1] } }]
    })).toThrow(/退化三角形/);
    const zeroAreaMesh = JSON.parse(JSON.stringify(source.mesh)) as typeof source.mesh;
    zeroAreaMesh.points[3] = { ...zeroAreaMesh.points[0]! };
    expect(() => buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "zero-area-copy", mesh: zeroAreaMesh }]
    })).toThrow(/零面积三角形/);
    const reorderedMesh = JSON.parse(JSON.stringify(source.mesh)) as typeof source.mesh;
    [reorderedMesh.points[0], reorderedMesh.points[1]] = [reorderedMesh.points[1]!, reorderedMesh.points[0]!];
    const reordered = applyCalibrationOverrides(before, buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "reordered-copy", mesh: reorderedMesh }]
    }));
    expect(reordered.model.bindings.map((binding) => binding.id)).toEqual(["source-motion"]);
    expect(() => buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "unsafe-copy", mesh: reorderedMesh, bindingMode: "copy" }]
    })).toThrow(/不能複製含頂點索引/);
    const copiedBindings = applyCalibrationOverrides(before, buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "exact-copy", bindingMode: "copy" }]
    }));
    expect(copiedBindings.model.bindings.map((binding) => binding.id)).toEqual(["source-motion", "source-motion/clone/exact-copy"]);
    const cloneWithCalibrationOverride = buildGeneratedLayerCloneOverrides(before, {
      sourceLayerId: source.id,
      targets: [{ layerId: "overridden-copy", order: 12 }]
    });
    const overridden = applyCalibrationOverrides(before, {
      ...cloneWithCalibrationOverride,
      layers: { "overridden-copy": { pivot: { x: 0.6, y: 0.4 }, deformerId: null, weights: { head: 1 } } }
    });
    expect(overridden.layers.find((layer) => layer.id === "overridden-copy")).toMatchObject({ pivot: { x: 0.6, y: 0.4 }, weights: { head: 1 } });
    expect(overridden.layers.find((layer) => layer.id === "overridden-copy")!.deformerId).toBeUndefined();
    const withHair = JSON.parse(JSON.stringify(before)) as PuppetLoomProject;
    withHair.layers[0]!.role = "frontHair";
    withHair.layers[0]!.hairStrands = [0, 1].map((index) => ({
      id: `strand-${index}`,
      root: { x: 0.25 + index * 0.1, y: 0.2 },
      tip: { x: 0.25 + index * 0.1, y: 0.3 },
      width: 0.05,
      confidence: 1,
      source: "corrected" as const,
      physics: { stiffness: 10, damping: 1, segments: 2, maxDisplacement: 0.1 },
      weights: Array(9).fill(0.5),
      release: Array(9).fill(0.5)
    }));
    expect(() => buildGeneratedLayerCloneOverrides(withHair, {
      sourceLayerId: source.id,
      targets: [{ layerId: "hair-mismatch-copy", mesh: customMesh }]
    })).toThrow(/hairStrands.*remap/);
    expect(() => buildGeneratedLayerCloneOverrides(withHair, {
      sourceLayerId: source.id,
      targets: [{ layerId: "hair-exact-copy" }]
    })).toThrow(/hairStrands.*remap/);
  });

  it("prepares generated-layer clone through immutable provenance and revision CAS", async () => {
    const root = await mkdtemp(join(tmpdir(), "puppetloom-generated-clone-"));
    try {
      const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
      const candidate = project();
      await installSplitProvenance(root, candidate, png);
      await writeFile(join(root, "puppetloom.json"), `${JSON.stringify(candidate)}\n`, "utf8");
      await initializeCalibration(root);
      const patch = await prepareGeneratedLayerClonePatch(root, {
        sourceLayerId: "parent",
        targets: [{ layerId: "parent-copy", order: 4 }]
      });
      const saved = await saveCalibrationPatch(root, patch);
      expect(saved.calibration.revision).toBe(1);
      const loaded = await loadProject(root);
      const loadedSource = loaded.layers.find((layer) => layer.id === "parent")!;
      const loadedCopy = loaded.layers.find((layer) => layer.id === "parent-copy")!;
      expect(loaded.layers.map((layer) => layer.id)).toEqual(expect.arrayContaining(["parent", "parent-copy"]));
      expect(loadedCopy.texture).toBe(loadedSource.texture);
      expect(loadedCopy.generatedAsset).toEqual(loadedSource.generatedAsset);
      expect(loadedCopy.sourceLayerId).toBeUndefined();
      await expect(saveCalibrationPatch(root, patch)).rejects.toThrow(/校准基线已从 0 更新到 1/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps the interactive structural result equal to the persistence result", () => {
    const current = applyCalibrationOverrides(project(), {});
    const overrides = {
      anchors: { nose: { x: 0.51, y: 0.48 } },
      layers: { child: { pivot: { x: 0.43, y: 0.39 }, meshPointDeltas: { "4": { x: 0.002, y: -0.003 } } } },
      runtime: { motionTuning: { response: 0.8 } }
    };
    const preview = applyCalibrationOverridesForPreview(current, overrides);
    const persisted = applyCalibrationOverrides(current, overrides);
    expect(preview).toEqual(persisted);
    expect(preview.layers[0]).toBe(current.layers[0]);
    expect(preview.layers[1]).not.toBe(current.layers[1]);
  });

  it("rebases final point deltas onto an already calibrated project without double-applying them", () => {
    const saved = { layers: { child: { meshPointDeltas: { "4": { x: 0.01, y: -0.02 } } } } };
    const patch = { layers: { child: { meshPointDeltas: { "4": { x: 0.014, y: -0.017 } } } } };
    const current = applyCalibrationOverrides(project(), saved);
    const effective = mergeCalibrationOverridesForPreview(saved, patch);
    const rebased = rebaseCalibrationOverridesForPreview(saved, patch);
    const interactive = applyCalibrationOverridesForInteractivePreview(current, rebased);
    const persisted = applyCalibrationOverrides(project(), effective);
    expect(rebased.layers?.child.meshPointDeltas?.["4"]?.x).toBeCloseTo(0.004);
    expect(rebased.layers?.child.meshPointDeltas?.["4"]?.y).toBeCloseTo(0.003);
    expect(interactive.layers.find((entry) => entry.id === "child")!.mesh.points[4]).toEqual(
      persisted.layers.find((entry) => entry.id === "child")!.mesh.points[4]
    );
  });

  it("applies hierarchy, drawing, visibility, lock and a resampled mesh as runtime data", () => {
    const applied = applyCalibrationOverrides(project(), {
      layers: {
        child: {
          parentLayerId: "parent",
          order: 9,
          visible: false,
          locked: true,
          side: "left",
          meshDensity: { rows: 5, cols: 6 }
        }
      }
    });
    const child = applied.layers.find((entry) => entry.id === "child")!;
    expect(child).toMatchObject({ parentLayerId: "parent", order: 9, visible: false, locked: true, side: "left" });
    expect(child.mesh).toMatchObject({ rows: 5, cols: 6 });
    expect(child.mesh.points).toHaveLength(30);
    expect(child.mesh.triangles).toHaveLength((5 - 1) * (6 - 1) * 6);
    expect(child.mesh.influences?.physics).toHaveLength(30);
  });

  it("rebuilds density from the neutral mesh instead of retaining stale vertex indexes", () => {
    const previous = {
      layers: { child: { meshPointDeltas: { "8": { x: 0.01, y: 0 } }, vertexInfluences: { face: { "8": 0.25 }, skull: { "8": 0.75 }, pin: { "8": 1 } } } }
    };
    const merged = mergeCalibrationOverrides(previous, { layers: { child: { meshDensity: { rows: 2, cols: 2 } } } });
    expect(merged.layers?.child.meshPointDeltas).toBeUndefined();
    expect(merged.layers?.child.vertexInfluences).toBeUndefined();
    expect(() => applyCalibrationOverrides(project(), merged)).not.toThrow();
  });

  it("stores a generated ArtMesh as a non-destructive legacy-grid upgrade", () => {
    const replacement = buildArtMesh(
      { x: 0.2, y: 0.2, width: 0.4, height: 0.4 },
      { textureSize: { width: 100, height: 100 }, alphaThreshold: 8, detail: 40, regions: [{ outer: [{ x: 0.5, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }], holes: [] }] }
    );
    const merged = mergeCalibrationOverrides(
      { layers: { child: { meshDensity: { rows: 5, cols: 5 }, meshPointDeltas: { "0": { x: 0.01, y: 0 } } } } },
      { layers: { child: { mesh: replacement } } }
    );
    expect(merged.layers?.child.meshDensity).toBeUndefined();
    expect(merged.layers?.child.meshPointDeltas).toBeUndefined();
    const upgraded = applyCalibrationOverrides(project(), merged).layers.find((entry) => entry.id === "child")!.mesh;
    expect(upgraded.topology).toBe("art");
    expect(upgraded.points).toEqual(replacement.points);
  });

  it("rebuilds front-hair physics weights by semantic region instead of carrying scalp wobble forward", () => {
    const value = project();
    const target = value.layers.find((entry) => entry.id === "child")!;
    target.role = "frontHair";
    target.parentGroup = "head";
    target.weights = { head: 1, body: 0, gaze: 0, physics: 1 };
    target.secondaryAnchors = {
      ahogeRoot: { x: 0.4, y: 0.3 },
      frontHairRoot: { x: 0.4, y: 0.42 },
      frontHairRootLeft: { x: 0.28, y: 0.42 },
      frontHairRootRight: { x: 0.52, y: 0.42 },
      frontHairTipLeft: { x: 0.23, y: 0.58 },
      frontHairTipRight: { x: 0.57, y: 0.58 }
    };
    target.mesh = buildArtMesh(target.bounds, {
      textureSize: { width: 160, height: 160 }, alphaThreshold: 8, detail: 10,
      regions: [{ outer: [{ x: 0.5, y: 0 }, { x: 1, y: 0.35 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0, y: 0.35 }], holes: [] }]
    });
    target.mesh.influences!.physics = target.mesh.points.map(() => 1);

    const rebuilt = applyCalibrationOverrides(value, { layers: { child: { meshDetail: 12 } } }).layers.find((entry) => entry.id === "child")!;
    const lateralCrown = rebuilt.mesh.points
      .map((point, index) => ({ point, weight: rebuilt.mesh.influences!.physics![index]! }))
      .filter(({ point }) => point.y < target.secondaryAnchors!.frontHairRoot!.y && Math.abs(point.x - target.secondaryAnchors!.ahogeRoot!.x) > target.bounds.width * 0.2);
    const freeEnds = rebuilt.mesh.points
      .map((point, index) => ({ point, weight: rebuilt.mesh.influences!.physics![index]! }))
      .filter(({ point }) => point.y > target.secondaryAnchors!.frontHairRoot!.y + target.bounds.height * 0.12);
    expect(lateralCrown.length).toBeGreaterThan(0);
    expect(lateralCrown.every(({ weight }) => weight === 0)).toBe(true);
    expect(freeEnds.some(({ weight }) => weight === 1)).toBe(true);
  });

  it("stores independent face and skull control-cage influence per vertex", () => {
    const applied = applyCalibrationOverrides(project(), {
      layers: { child: { vertexInfluences: { face: { "0": 0.2 }, skull: { "0": 0.7 } } } }
    });
    const mesh = applied.layers.find((entry) => entry.id === "child")!.mesh;
    expect(mesh.influences?.face?.[0]).toBe(0.2);
    expect(mesh.influences?.skull?.[0]).toBe(0.7);
    expect(mesh.influences?.face).toHaveLength(mesh.points.length);
    expect(mesh.influences?.skull).toHaveLength(mesh.points.length);
  });

  it("rejects missing, self-referential and cyclic parent relationships", () => {
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "missing" } } })).toThrow(/不存在/);
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "child" } } })).toThrow(/自己/);
    expect(() => applyCalibrationOverrides(project(), { layers: { child: { parentLayerId: "parent" }, parent: { parentLayerId: "child" } } })).toThrow(/循环/);
  });

  it("merges per-part motion tuning without discarding other parts", () => {
    const merged = mergeCalibrationOverrides(
      { runtime: { secondaryMotionTuning: { frontHair: { amplitude: 0.8 } } } },
      { runtime: { secondaryMotionTuning: { frontHair: { response: 0.9 }, tail: { stability: 0.7 } } } }
    );
    expect(merged.runtime?.secondaryMotionTuning).toEqual({
      frontHair: { amplitude: 0.8, response: 0.9 },
      tail: { stability: 0.7 }
    });
  });
});
