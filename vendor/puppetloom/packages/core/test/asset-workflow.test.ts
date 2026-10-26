import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { artifactPath } from "../../../test/support/artifacts.js";
import { applyAssetAssembly, createProject, loadCalibration, loadProject, migrateProject, planAssetAssembly, prepareAssetReference, registerAssetImage, restoreCalibrationRevision, saveCalibrationPatch, verifyProject } from "../src/index.js";

describe("registered asset workflow", () => {
  it("registers HD landmarks while keeping world bounds and density-one mesh UVs, and rejects forged evidence", async () => {
    const root = artifactPath("asset-landmark-hd"), project = resolve(root, "project");
    await mkdir(root, { recursive: true });
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: project, seed: 73 });
    const before = await loadProject(project), template = before.layers.find((layer) => layer.role === "frontHair")!;
    const reference = await prepareAssetReference(project, template.id);
    const image = resolve(root, "landmarks.png");
    const shape = Buffer.from('<svg width="32" height="32"><rect x="4" y="4" width="24" height="24" fill="white"/></svg>');
    await sharp({ create: { width: 32, height: 32, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input: shape }]).png().toFile(image);
    const scale = Math.min(before.canvas.width, before.canvas.height) / 48;
    const left = before.canvas.width / 2 - 12 * scale, top = before.canvas.height / 2 - 12 * scale;
    const landmarks = { kind: "landmarks" as const, anchors: [
      { generated: { x: 4, y: 4 }, source: { x: left, y: top } },
      { generated: { x: 28, y: 4 }, source: { x: left + 24 * scale, y: top } },
      { generated: { x: 4, y: 28 }, source: { x: left, y: top + 24 * scale } }
    ] };
    const hd = await registerAssetImage(project, reference.id, image, { ...landmarks, textureScale: 2 });
    const densityOne = await registerAssetImage(project, reference.id, image, landmarks);
    expect(hd.bounds).toEqual(densityOne.bounds);
    expect((await sharp(resolve(project, hd.texture)).metadata()).width).toBe((await sharp(resolve(project, densityOne.texture)).metadata()).width! * 2);
    const plan = await planAssetAssembly(project, { baseRevision: 0, additions: [
      { registrationId: hd.id, layerId: "landmarks-hd" },
      { registrationId: densityOne.id, layerId: "landmarks-density-one" }
    ] });
    await applyAssetAssembly(project, plan.id);
    expect((await verifyProject(project)).valid).toBe(true);
    const assembled = await loadProject(project);
    const hdLayer = assembled.layers.find((layer) => layer.id === "landmarks-hd")!;
    const densityOneLayer = assembled.layers.find((layer) => layer.id === "landmarks-density-one")!;
    expect(hdLayer.bounds).toEqual(densityOneLayer.bounds);
    const hdMesh = structuredClone(hdLayer.mesh), oneMesh = structuredClone(densityOneLayer.mesh);
    if (hdMesh.art) delete hdMesh.art.textureSize;
    if (oneMesh.art) delete oneMesh.art.textureSize;
    expect(hdMesh).toEqual(oneMesh);
    expect(hd.meshTexture).toBeDefined();
    expect(await sharp(resolve(project, hd.meshTexture!)).metadata()).toMatchObject({ width: hd.bounds.width, height: hd.bounds.height });

    const registrationPath = resolve(project, `assets/registrations/${hd.id}.json`);
    const registrationBytes = await readFile(registrationPath);
    const badMetadata = JSON.parse(registrationBytes.toString("utf8"));
    badMetadata.registration.input.textureScale = 3;
    await writeFile(registrationPath, JSON.stringify(badMetadata));
    let report = await verifyProject(project);
    expect(report.invalidTextures.find((item) => item.path === hd.texture)?.reason).toMatch(/不可變 registration ID/);
    await writeFile(registrationPath, registrationBytes);

    const forged = JSON.parse(registrationBytes.toString("utf8"));
    forged.bounds.x += 1;
    const forgedBytes = Buffer.from(JSON.stringify(forged));
    const forgedId = createHash("sha256").update(forgedBytes).digest("hex");
    await writeFile(resolve(project, `assets/registrations/${forgedId}.json`), forgedBytes);
    const forgedLayer = structuredClone(hdLayer);
    forgedLayer.generatedAsset!.registrationId = forgedId;
    await saveCalibrationPatch(project, { baseRevision: 1, overrides: { assetLayers: { [forgedLayer.id]: forgedLayer } } });
    report = await verifyProject(project);
    expect(report.invalidTextures.find((item) => item.path === hd.texture)?.reason).toMatch(/原始 PNG 重算結果不符/);
  });

  it("previews and commits a padded replacement with identical pixels and restores through normal history", async () => {
    const root = artifactPath("asset-workflow"), project = resolve(root, "project");
    await mkdir(root, { recursive: true });
    await createProject({ input: resolve("test/fixtures/semantic.psd"), output: project, seed: 42 });
    expect((await verifyProject(project)).valid).toBe(true);
    const original = await loadProject(project), originalHair = original.layers.find((layer) => layer.role === "frontHair")!;
    await saveCalibrationPatch(project, { baseRevision: 0, overrides: { layers: { [originalHair.id]: {
      meshPointDeltas: Object.fromEntries(originalHair.mesh.points.map((_, i) => [String(i), { x: 0.005, y: 0 }]))
    } } } });
    const before = await loadProject(project), template = before.layers.find((layer) => layer.role === "frontHair")!;
    const baseFile = await readFile(resolve(project, "puppetloom.json"));
    const reference = await prepareAssetReference(project, template.id);
    const source = resolve(project, reference.cleanPath), size = await sharp(source).metadata();
    const image = resolve(root, "padded.png");
    const padded = await sharp(source).extend({ left: 5, right: 5, top: 7, bottom: 7, background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
    await sharp(padded).resize((size.width! + 10) * 2, (size.height! + 14) * 2, { kernel: "nearest" }).png().toFile(image);
    const registered = await registerAssetImage(project, reference.id, image, { kind: "frame", generatedRect: { x: 10, y: 14, width: size.width! * 2, height: size.height! * 2 }, sourceRect: reference.sourceRect });
    expect(await sharp(resolve(project, registered.texture)).raw().toBuffer()).toEqual(await sharp(source).raw().toBuffer());
    const sourceRectFrame = { x: 10, y: 14, width: size.width! * 2, height: size.height! * 2 };
    const frame = { kind: "frame" as const, generatedRect: sourceRectFrame, sourceRect: reference.sourceRect, preserveFrame: true };
    const registrationOne = await registerAssetImage(project, reference.id, image, { ...frame, textureScale: 1 });
    const registrationTwo = await registerAssetImage(project, reference.id, image, { ...frame, textureScale: 2 });
    expect((await sharp(resolve(project, registrationTwo.texture)).metadata()).width).toBe((await sharp(resolve(project, registrationOne.texture)).metadata()).width! * 2);
    expect(registrationTwo.bounds).toEqual(registrationOne.bounds);
    expect(registrationTwo.registration.matrix).toEqual(registrationOne.registration.matrix);
    const plan = await planAssetAssembly(project, { baseRevision: 1, additions: [
      { registrationId: registered.id, layerId: "replacement-hair" },
      { registrationId: registrationOne.id, layerId: "replacement-hair-density-one" },
      { registrationId: registrationTwo.id, layerId: "replacement-hair-density-two" }
    ], replaceLayerIds: [template.id] });
    expect((await loadCalibration(project)).revision).toBe(1);
    expect(plan.evidence.after.artifacts.length).toBeGreaterThan(0);
    const applied = await applyAssetAssembly(project, plan.id);
    expect(applied.calibration.revision).toBe(2);
    expect((await verifyProject(project)).valid).toBe(true);
    const after = await loadProject(project), replacement = after.layers.find((layer) => layer.id === "replacement-hair")!;
    const densityOne = after.layers.find((layer) => layer.id === "replacement-hair-density-one")!, densityTwo = after.layers.find((layer) => layer.id === "replacement-hair-density-two")!;
    expect(densityTwo.bounds).toEqual(densityOne.bounds);
    const densityOneMesh = structuredClone(densityOne.mesh), densityTwoMesh = structuredClone(densityTwo.mesh);
    if (densityOneMesh.art) delete densityOneMesh.art.textureSize;
    if (densityTwoMesh.art) delete densityTwoMesh.art.textureSize;
    expect(densityTwoMesh).toEqual(densityOneMesh);
    expect(densityTwo.mesh.art?.textureSize).toEqual({ width: (await sharp(resolve(project, registrationTwo.texture)).metadata()).width, height: (await sharp(resolve(project, registrationTwo.texture)).metadata()).height });
    expect(replacement.generatedAsset).toMatchObject({ registrationId: registered.id, templateLayerId: template.id });
    expect(replacement.parentGroup).toBe(template.parentGroup);
    expect(replacement.deformerId).toBe(template.deformerId);
    replacement.mesh.points.forEach((point, index) => {
      expect(point.x - (replacement.bounds.x + replacement.mesh.uvs[index]!.x * replacement.bounds.width)).toBeCloseTo(0.005, 5);
    });
    expect(after.layers.find((layer) => layer.id === template.id)!.visible).toBe(false);
    expect(await readFile(resolve(project, "puppetloom.json"))).toEqual(baseFile);
    const hdTexturePath = resolve(project, densityTwo.texture), hdTextureBytes = await readFile(hdTexturePath);
    const hdTextureSize = await sharp(hdTextureBytes).metadata();
    await sharp(hdTextureBytes).resize(hdTextureSize.width! + 2, hdTextureSize.height! + 2).png().toFile(hdTexturePath);
    expect((await verifyProject(project)).invalidTextures.some((item) => item.path === densityTwo.texture)).toBe(true);
    await writeFile(hdTexturePath, hdTextureBytes);
    const registrationPath = resolve(project, `assets/registrations/${registrationTwo.id}.json`), registrationBytes = await readFile(registrationPath);
    const forgedRegistration = JSON.parse(registrationBytes.toString("utf8"));
    forgedRegistration.registration.input.textureScale = 4;
    forgedRegistration.textureSha256 = "0".repeat(64);
    forgedRegistration.bounds.x += 1;
    await writeFile(registrationPath, JSON.stringify(forgedRegistration));
    expect((await verifyProject(project)).invalidTextures.some((item) => item.path === densityTwo.texture)).toBe(true);
    await writeFile(registrationPath, registrationBytes);
    const migrated = await migrateProject({ project, input: resolve("test/fixtures/semantic.psd"), output: resolve(root, "migrated") });
    expect(migrated.appliedRevision).toBe(1);
    expect((await loadProject(migrated.outputDirectory)).layers.find((layer) => layer.id === replacement.id)).toEqual(replacement);
    const migratedHd = (await loadProject(migrated.outputDirectory)).layers.find((layer) => layer.id === "replacement-hair-density-two")!;
    expect(migratedHd).toEqual(densityTwo);
    expect(await readFile(resolve(migrated.outputDirectory, densityTwo.texture))).toEqual(await readFile(resolve(project, densityTwo.texture)));
    expect(await readFile(resolve(migrated.outputDirectory, registrationTwo.meshTexture!))).toEqual(await readFile(resolve(project, registrationTwo.meshTexture!)));
    expect(await readFile(resolve(migrated.outputDirectory, registered.originalPath))).toEqual(await readFile(image));
    await expect(applyAssetAssembly(project, plan.id)).rejects.toThrow(/版本/);
    await restoreCalibrationRevision(project, 1, 2, "恢复试装前");
    const restored = await loadProject(project);
    expect(restored.layers).toEqual(before.layers);
    expect(restored.model).toEqual(before.model);
    expect(await readFile(image)).toEqual(await readFile(resolve(project, registered.originalPath)));
  });
});
