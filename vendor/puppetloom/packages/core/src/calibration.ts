import { calibrationOverridesSchema, generatedLayerCloneOperationSchema, layerTriangleSplitOperationSchema } from "./schema.js";
import { parsePuppetLoomProject } from "./project-format.js";
import { remeshArtMesh } from "./art-mesh.js";
import { frontHairPhysicsMask } from "./front-hair-geometry.js";
import { hairAttachmentInfluences } from "./hair-strands.js";
import { makeGridMesh, reprojectMeshInfluences } from "./mesh.js";
import type {
  CalibrationOverrides,
  CalibrationPatch,
  GeneratedLayerCloneOperation,
  LayerTriangleSplitOperation,
  LayerBinding,
  LayerCalibrationOverride,
  MeshInfluenceChannel,
  MeshBinding,
  HairStrandSpec,
  Point,
  PuppetLoomProject
} from "./types.js";
import { PUPPETLOOM_PROJECT_VERSION } from "./types.js";

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mergeIndexed<T>(base: Record<string, T> | undefined, patch: Record<string, T> | undefined): Record<string, T> | undefined {
  if (!base && !patch) return undefined;
  return { ...(base ?? {}), ...(patch ?? {}) };
}

function mergeLayerOverride(base: LayerCalibrationOverride | undefined, patch: LayerCalibrationOverride): LayerCalibrationOverride {
  const meshChanged = patch.mesh !== undefined || (patch.meshDensity !== undefined
    && (patch.meshDensity.rows !== base?.meshDensity?.rows || patch.meshDensity.cols !== base?.meshDensity?.cols))
    || (patch.meshDetail !== undefined && patch.meshDetail !== base?.meshDetail);
  const mergeBase = meshChanged && base
    ? Object.fromEntries(Object.entries(base).filter(([key]) => key !== "meshPointDeltas"
      && key !== "vertexInfluences"
      && (!patch.mesh || (key !== "meshDensity" && key !== "meshDetail")))) as LayerCalibrationOverride
    : base;
  const vertexChannels = new Set<MeshInfluenceChannel>([
    ...Object.keys(mergeBase?.vertexInfluences ?? {}) as MeshInfluenceChannel[],
    ...Object.keys(patch.vertexInfluences ?? {}) as MeshInfluenceChannel[]
  ]);
  const vertexInfluences = Object.fromEntries([...vertexChannels].map((channel) => [
    channel,
    mergeIndexed(mergeBase?.vertexInfluences?.[channel], patch.vertexInfluences?.[channel])
  ]).filter(([, value]) => value !== undefined)) as LayerCalibrationOverride["vertexInfluences"];
  return {
    ...(mergeBase ?? {}),
    ...patch,
    ...(mergeBase?.secondaryAnchors || patch.secondaryAnchors ? {
      secondaryAnchors: { ...(mergeBase?.secondaryAnchors ?? {}), ...(patch.secondaryAnchors ?? {}) }
    } : {}),
    ...(mergeBase?.weights || patch.weights ? { weights: { ...(mergeBase?.weights ?? {}), ...(patch.weights ?? {}) } } : {}),
    ...(mergeBase?.meshPointDeltas || patch.meshPointDeltas ? {
      meshPointDeltas: mergeIndexed(mergeBase?.meshPointDeltas, patch.meshPointDeltas)!
    } : {}),
    ...(Object.keys(vertexInfluences ?? {}).length > 0 ? { vertexInfluences } : {})
  } as LayerCalibrationOverride;
}

function mergeParsedCalibrationOverrides(base: CalibrationOverrides, patch: CalibrationOverrides): CalibrationOverrides {
  const layerIds = new Set([...Object.keys(base.layers ?? {}), ...Object.keys(patch.layers ?? {})]);
  const layers = Object.fromEntries([...layerIds].map((id) => {
    const next = patch.layers?.[id];
    return [id, next ? mergeLayerOverride(base.layers?.[id], next) : base.layers![id]!];
  }));
  return {
    ...(base.assetLayers || patch.assetLayers ? { assetLayers: { ...(base.assetLayers ?? {}), ...(patch.assetLayers ?? {}) } } : {}),
    ...(patch.model ? { model: patch.model } : base.model ? { model: base.model } : {}),
    ...(base.anchors || patch.anchors ? { anchors: { ...(base.anchors ?? {}), ...(patch.anchors ?? {}) } } : {}),
    ...(base.semanticPoints || patch.semanticPoints ? {
      semanticPoints: { ...(base.semanticPoints ?? {}), ...(patch.semanticPoints ?? {}) }
    } : {}),
    ...(Object.keys(layers).length > 0 ? { layers } : {}),
    ...(base.runtime || patch.runtime ? {
      runtime: {
        ...(base.runtime ?? {}),
        ...(patch.runtime ?? {}),
        ...(base.runtime?.envelope || patch.runtime?.envelope ? {
          envelope: { ...(base.runtime?.envelope ?? {}), ...(patch.runtime?.envelope ?? {}) }
        } : {}),
        ...(base.runtime?.motionTuning || patch.runtime?.motionTuning ? {
          motionTuning: { ...(base.runtime?.motionTuning ?? {}), ...(patch.runtime?.motionTuning ?? {}) }
        } : {}),
        ...(base.runtime?.poseField || patch.runtime?.poseField ? {
          poseField: { ...(base.runtime?.poseField ?? {}), ...(patch.runtime?.poseField ?? {}) }
        } : {}),
        ...(base.runtime?.poseOcclusion || patch.runtime?.poseOcclusion ? {
          poseOcclusion: { ...(base.runtime?.poseOcclusion ?? {}), ...(patch.runtime?.poseOcclusion ?? {}) }
        } : {}),
        ...(base.runtime?.secondaryMotionTuning || patch.runtime?.secondaryMotionTuning ? {
          secondaryMotionTuning: Object.fromEntries([...new Set([
            ...Object.keys(base.runtime?.secondaryMotionTuning ?? {}),
            ...Object.keys(patch.runtime?.secondaryMotionTuning ?? {})
          ])].map((part) => [part, {
            ...(base.runtime?.secondaryMotionTuning?.[part as keyof NonNullable<typeof base.runtime.secondaryMotionTuning>] ?? {}),
            ...(patch.runtime?.secondaryMotionTuning?.[part as keyof NonNullable<typeof patch.runtime.secondaryMotionTuning>] ?? {})
          }]))
        } : {})
      }
    } : {})
  } as CalibrationOverrides;
}

export function mergeCalibrationOverrides(base: CalibrationOverrides, patch: CalibrationOverrides): CalibrationOverrides {
  return calibrationOverridesSchema.parse(mergeParsedCalibrationOverrides(base, patch)) as CalibrationOverrides;
}

/**
 * Merges calibration objects already admitted through a schema boundary.
 * The editor uses this while composing its in-memory draft; draft persistence
 * and save transactions still parse and validate the complete result.
 */
export function mergeCalibrationOverridesForPreview(base: CalibrationOverrides, patch: CalibrationOverrides): CalibrationOverrides {
  return mergeParsedCalibrationOverrides(base, patch);
}

/**
 * Converts a revision patch into the equivalent patch for a project that
 * already contains the saved calibration. Point deltas are the only additive
 * override; all other fields are absolute replacements.
 */
export function rebaseCalibrationOverridesForPreview(saved: CalibrationOverrides, patch: CalibrationOverrides): CalibrationOverrides {
  if (!patch.layers) return patch;
  const layers = Object.fromEntries(Object.entries(patch.layers).map(([layerId, layerPatch]) => {
    if (!layerPatch.meshPointDeltas || layerPatch.mesh || layerPatch.meshDensity || layerPatch.meshDetail !== undefined) return [layerId, layerPatch];
    const savedDeltas = saved.layers?.[layerId]?.meshPointDeltas;
    return [layerId, {
      ...layerPatch,
      meshPointDeltas: Object.fromEntries(Object.entries(layerPatch.meshPointDeltas).map(([index, delta]) => {
        const previous = savedDeltas?.[index] ?? { x: 0, y: 0 };
        return [index, { x: delta.x - previous.x, y: delta.y - previous.y }];
      }))
    }];
  })) as NonNullable<CalibrationOverrides["layers"]>;
  return { ...patch, layers };
}

export function clearCalibrationOverrides(base: CalibrationOverrides, clear: CalibrationPatch["clear"]): CalibrationOverrides {
  if (!clear) return clone(base);
  const next = clone(base);
  if (clear.model) delete next.model;
  for (const key of clear.anchors ?? []) if (next.anchors) delete next.anchors[key];
  for (const key of clear.semanticPoints ?? []) if (next.semanticPoints) delete next.semanticPoints[key];
  for (const id of clear.layers ?? []) if (next.layers) delete next.layers[id];
  for (const key of clear.runtime ?? []) if (next.runtime) delete next.runtime[key];
  if (next.anchors && Object.keys(next.anchors).length === 0) delete next.anchors;
  if (next.semanticPoints && Object.keys(next.semanticPoints).length === 0) delete next.semanticPoints;
  if (next.layers && Object.keys(next.layers).length === 0) delete next.layers;
  if (next.runtime && Object.keys(next.runtime).length === 0) delete next.runtime;
  return next;
}

function assertNormalized(point: Point, label: string): void {
  if (point.x < 0 || point.x > 1 || point.y < 0 || point.y > 1) throw new Error(`${label} 必须位于项目画布的 0..1 范围内。`);
}

const interactiveMeshTransformCache = new WeakMap<MeshBinding, Map<string, MeshBinding>>();

function cachedInteractiveMesh(source: MeshBinding, key: string, create: () => MeshBinding): MeshBinding {
  let entries = interactiveMeshTransformCache.get(source);
  if (!entries) {
    entries = new Map();
    interactiveMeshTransformCache.set(source, entries);
  }
  const cached = entries.get(key);
  if (cached) return cached;
  const created = create();
  entries.set(key, created);
  return created;
}

function meshAtDensity(layer: LayerBinding, rows: number, cols: number, interactive = false): MeshBinding {
  if (layer.mesh.topology !== "grid") throw new Error(`${layer.sourceName} 使用 Alpha ArtMesh，不能按行列重建。`);
  const create = (): MeshBinding => {
    const rebuilt = makeGridMesh(layer.bounds, rows, cols);
    rebuilt.influences = reprojectMeshInfluences(layer.mesh, rebuilt);
    return rebuilt;
  };
  const key = `grid:${layer.bounds.x}:${layer.bounds.y}:${layer.bounds.width}:${layer.bounds.height}:${rows}:${cols}`;
  return interactive ? cachedInteractiveMesh(layer.mesh, key, create) : create();
}

function meshAtDetail(mesh: MeshBinding, bounds: LayerBinding["bounds"], detail: number, interactive: boolean): MeshBinding {
  const create = () => remeshArtMesh(mesh, bounds, detail);
  const key = `art:${bounds.x}:${bounds.y}:${bounds.width}:${bounds.height}:${detail}`;
  return interactive ? cachedInteractiveMesh(mesh, key, create) : create();
}

const interactiveHairReprojectionCache = new WeakMap<MeshBinding, WeakMap<HairStrandSpec[], HairStrandSpec[]>>();

function reprojectHairStrands(previous: MeshBinding, next: MeshBinding, strands: HairStrandSpec[], interactive = false): HairStrandSpec[] {
  const cached = interactive ? interactiveHairReprojectionCache.get(next)?.get(strands) : undefined;
  if (cached) return cached;
  const reprojected = strands.map((strand) => ({
    ...strand,
    weights: next.points.map((point) => {
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < previous.points.length; index += 1) {
        const candidate = previous.points[index]!;
        const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      }
      return strand.weights[nearest] ?? 0;
    }),
    release: next.points.map((point) => {
      let nearest = 0;
      let nearestDistance = Number.POSITIVE_INFINITY;
      for (let index = 0; index < previous.points.length; index += 1) {
        const candidate = previous.points[index]!;
        const distance = (candidate.x - point.x) ** 2 + (candidate.y - point.y) ** 2;
        if (distance < nearestDistance) {
          nearest = index;
          nearestDistance = distance;
        }
      }
      return strand.release[nearest] ?? 0;
    })
  }));
  if (interactive) {
    let byStrands = interactiveHairReprojectionCache.get(next);
    if (!byStrands) {
      byStrands = new WeakMap();
      interactiveHairReprojectionCache.set(next, byStrands);
    }
    byStrands.set(strands, reprojected);
  }
  return reprojected;
}

const interactiveHairInfluenceCache = new WeakMap<MeshBinding, WeakMap<HairStrandSpec[], {
  headAttachment: number[];
  physicsRelease: number[];
  physics: number[];
}>>();

function validateSplitSourceMesh(layer: LayerBinding): number {
  const mesh = layer.mesh;
  if (mesh.points.length !== mesh.uvs.length) throw new Error(`${layer.sourceName} 的 points 与 UV 数量不一致，不能分割网格。`);
  if (mesh.triangles.length === 0 || mesh.triangles.length % 3 !== 0) throw new Error(`${layer.sourceName} 的三角形索引数量必须是 3 的正整数倍。`);
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const triangle = mesh.triangles.slice(index, index + 3);
    if (new Set(triangle).size !== 3) throw new Error(`${layer.sourceName} 含有退化三角形 ${index / 3}。`);
    if (triangle.some((pointIndex) => pointIndex < 0 || pointIndex >= mesh.points.length)) {
      throw new Error(`${layer.sourceName} 的三角形 ${index / 3} 引用了不存在的顶点。`);
    }
  }
  return mesh.triangles.length / 3;
}

function validateCloneMesh(mesh: MeshBinding, label: string): void {
  if (mesh.points.length !== mesh.uvs.length) throw new Error(`${label} 的 points 与 UV 数量不一致。`);
  if (mesh.triangles.length === 0 || mesh.triangles.length % 3 !== 0) throw new Error(`${label} 的三角形索引数量必须是 3 的正整数倍。`);
  for (let index = 0; index < mesh.triangles.length; index += 3) {
    const triangle = mesh.triangles.slice(index, index + 3);
    if (new Set(triangle).size !== 3) throw new Error(`${label} 含有退化三角形 ${index / 3}。`);
    if (triangle.some((pointIndex) => pointIndex < 0 || pointIndex >= mesh.points.length)) {
      throw new Error(`${label} 的三角形 ${index / 3} 引用了不存在的顶点。`);
    }
    const a = mesh.points[triangle[0]!]!;
    const b = mesh.points[triangle[1]!]!;
    const c = mesh.points[triangle[2]!]!;
    const area2 = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    if (Math.abs(area2) <= 1e-12) throw new Error(`${label} 含有零面积三角形 ${index / 3}。`);
  }
  for (const [channel, values] of Object.entries(mesh.influences ?? {})) {
    if (values && values.length !== mesh.points.length) throw new Error(`${label} 的 ${channel} 权重数量与网格不一致。`);
  }
}

function validateSplitLayerReferences(project: PuppetLoomProject, source: LayerBinding): void {
  const blockers: string[] = [];
  for (const layer of project.layers) {
    if (layer.id === source.id) continue;
    if (layer.parentLayerId === source.id) blockers.push(`${layer.id}.parentLayerId`);
    if (layer.clipLayerId === source.id) blockers.push(`${layer.id}.clipLayerId`);
  }
  for (const rule of project.runtime.constraints?.collisions ?? []) {
    if (rule.movingLayerIds.includes(source.id)) blockers.push(`collision:${rule.id}.movingLayerIds`);
    if (rule.colliderLayerIds.includes(source.id)) blockers.push(`collision:${rule.id}.colliderLayerIds`);
  }
  for (const group of project.production?.variants ?? []) {
    for (const option of group.options) if (option.layerIds.includes(source.id)) blockers.push(`variant:${group.id}/${option.id}`);
  }
  for (const prop of project.production?.props ?? []) if (prop.layerIds.includes(source.id)) blockers.push(`prop:${prop.id}`);
  for (const binding of project.model.bindings) {
    if (binding.target.kind === "layer" && binding.keyforms.some((keyform) => keyform.drawOrderOffset !== undefined)) {
      blockers.push(`binding:${binding.id}.drawOrderOffset`);
    }
  }
  // BehaviorTrack targets are parameter/expression-only by schema; layer
  // bindings are copied below and are the only motion graph references.
  if (blockers.length > 0) throw new Error(`图层 ${source.id} 被其他层级、裁剪、碰撞或生产状态引用，无法安全隐藏原图层：${blockers.join(", ")}`);
}

/**
 * Builds a pure calibration override that splits one generated layer into
 * multiple triangle-owned layers without touching texture bytes. This helper
 * does not inspect filesystem provenance; callers must use
 * prepareLayerTriangleSplitPatch before persisting the returned overrides.
 * With no target semantic override this is a geometry-only split; setting
 * `semantic` explicitly opts into role/side/visibility behavior changes.
 *
 * This deliberately returns the existing assetLayers/model/layers override
 * shape. It does not pretend that an AuthoringPatch can persist new layers:
 * saveAuthoringPatch only serializes overrides for layers that already existed
 * in its input project.
 */
export function buildLayerTriangleSplitOverrides(project: PuppetLoomProject, rawOperation: LayerTriangleSplitOperation): CalibrationOverrides {
  const operation = layerTriangleSplitOperationSchema.parse(rawOperation) as LayerTriangleSplitOperation;
  const base = parsePuppetLoomProject(project);
  const source = base.layers.find((candidate) => candidate.id === operation.sourceLayerId);
  if (!source) throw new Error(`找不到要分割的图层：${operation.sourceLayerId}`);
  if (!source.generatedAsset) throw new Error(`图层 ${source.id} 没有 immutable generatedAsset provenance，拒绝分割。`);
  validateSplitLayerReferences(base, source);

  const existingLayerIds = new Set(base.layers.map((layer) => layer.id));
  const targetLayerIds = new Set<string>();
  for (const target of operation.targets) {
    if (target.layerId === source.id) throw new Error(`分割目标图层不能复用源图层 ID：${target.layerId}`);
    if (existingLayerIds.has(target.layerId) || targetLayerIds.has(target.layerId)) throw new Error(`分割目标图层 ID 已被占用或重复：${target.layerId}`);
    targetLayerIds.add(target.layerId);
  }

  const triangleCount = validateSplitSourceMesh(source);
  const claimed = new Uint8Array(triangleCount);
  const targetTriangleIndices = operation.targets.map((target) => {
    const indices = [...target.triangleIndices].sort((left, right) => left - right);
    for (const triangleIndex of indices) {
      if (triangleIndex < 0 || triangleIndex >= triangleCount) throw new Error(`分割目标 ${target.layerId} 引用了不存在的三角形 ${triangleIndex}。`);
      if (claimed[triangleIndex]) throw new Error(`三角形 ${triangleIndex} 被多个分割目标重复声明。`);
      claimed[triangleIndex] = 1;
    }
    return indices;
  });
  const missing = [...claimed].findIndex((claimedTriangle) => claimedTriangle === 0);
  if (missing >= 0) throw new Error(`分割遗漏了三角形 ${missing}，拒绝产生不完整网格。`);

  const targetLayers: Record<string, LayerBinding> = {};
  const layerOverrides: NonNullable<CalibrationOverrides["layers"]> = {};
  // Calibration applies assetLayers after the base array and therefore cannot
  // literally splice them into place. Normalize the stable `(order, index)`
  // draw sequence to consecutive orders so the appended snapshots render as
  // an in-place replacement, including when neighbouring layers share order.
  const stableLayers = base.layers
    .map((layer, index) => ({ layer, index }))
    .sort((left, right) => left.layer.order - right.layer.order || left.index - right.index);
  const sourceStableIndex = stableLayers.findIndex((entry) => entry.layer.id === source.id);
  if (sourceStableIndex < 0) throw new Error(`无法在稳定绘制顺序中定位源图层：${source.id}`);
  const targetOrders = operation.targets.map((_, index) => sourceStableIndex + index);
  for (const [stableIndex, entry] of stableLayers.entries()) {
    if (entry.layer.id === source.id) {
      layerOverrides[source.id] = { visible: false, order: targetOrders[0]! };
      continue;
    }
    const order = stableIndex < sourceStableIndex ? stableIndex : stableIndex + operation.targets.length - 1;
    layerOverrides[entry.layer.id] = { order };
  }

  for (const [targetIndex, target] of operation.targets.entries()) {
    const triangleIndices = targetTriangleIndices[targetIndex]!;
    const layer = clone(source);
    layer.id = target.layerId;
    layer.sourceName = target.sourceName ?? `${source.sourceName} · ${target.layerId}`;
    layer.sourcePath = [...source.sourcePath, "split", target.layerId];
    if (source.sourceLayerId) layer.sourceLayerId = `${source.sourceLayerId}/split/${target.layerId}`;
    layer.role = target.semantic?.role ?? source.role;
    layer.side = target.semantic?.side ?? source.side;
    layer.order = targetOrders[targetIndex]!;
    const visible = target.semantic?.visible ?? source.visible;
    if (visible === undefined) delete layer.visible;
    else layer.visible = visible;
    layer.mesh = {
      ...clone(source.mesh),
      triangles: triangleIndices.flatMap((triangleIndex) => source.mesh.triangles.slice(triangleIndex * 3, triangleIndex * 3 + 3))
    };
    targetLayers[layer.id] = layer;
  }

  const model = clone(base.model);
  const sourceBindings = model.bindings.filter((binding) => binding.target.kind === "layer" && binding.target.id === source.id);
  const bindingIds = new Set(model.bindings.map((binding) => binding.id));
  for (const target of operation.targets) {
    for (const binding of sourceBindings) {
      const id = `${binding.id}/split/${target.layerId}`;
      if (bindingIds.has(id)) throw new Error(`分割动作绑定 ID 已被占用：${id}`);
      bindingIds.add(id);
      model.bindings.push({ ...clone(binding), id, target: { kind: "layer", id: target.layerId } });
    }
  }

  return { assetLayers: targetLayers, model, layers: layerOverrides };
}

/**
 * Builds calibration overrides that add copies of an immutable generated
 * layer. Unlike triangle splitting, this leaves the source layer untouched;
 * each target may provide a complete schema-valid mesh and explicit order.
 */
export function buildGeneratedLayerCloneOverrides(project: PuppetLoomProject, rawOperation: GeneratedLayerCloneOperation): CalibrationOverrides {
  const operation = generatedLayerCloneOperationSchema.parse(rawOperation) as GeneratedLayerCloneOperation;
  const base = parsePuppetLoomProject(project);
  const source = base.layers.find((candidate) => candidate.id === operation.sourceLayerId);
  if (!source) throw new Error(`找不到要複製的圖層：${operation.sourceLayerId}`);
  if (!source.generatedAsset) throw new Error(`圖層 ${source.id} 沒有 immutable generatedAsset provenance，拒絕複製。`);
  validateCloneMesh(source.mesh, source.sourceName);

  const existingLayerIds = new Set(base.layers.map((layer) => layer.id));
  const targetLayerIds = new Set<string>();
  const targetLayers: Record<string, LayerBinding> = {};
  const model = clone(base.model);
  const sourceBindings = model.bindings.filter((binding) => binding.target.kind === "layer" && binding.target.id === source.id);
  const bindingIds = new Set(model.bindings.map((binding) => binding.id));
  for (const target of operation.targets) {
    if (existingLayerIds.has(target.layerId) || targetLayerIds.has(target.layerId)) {
      throw new Error(`複製目標圖層 ID 已被占用或重複：${target.layerId}`);
    }
    targetLayerIds.add(target.layerId);
    const mesh = target.mesh ? clone(target.mesh) : clone(source.mesh);
    if (source.hairStrands) {
      throw new Error(`圖層 ${source.id} 含有以頂點索引的 hairStrands；clone 沒有全域 ID／頂點 remap 路徑，拒絕複製。`);
    }
    validateCloneMesh(mesh, target.layerId);
    const layer = clone(source);
    layer.id = target.layerId;
    layer.sourceName = target.sourceName ?? `${source.sourceName} · ${target.layerId}`;
    layer.sourcePath = [...source.sourcePath, "clone", target.layerId];
    delete layer.sourceLayerId;
    layer.mesh = mesh;
    if (target.order !== undefined) layer.order = target.order;
    const role = target.semantic?.role;
    if (role) layer.role = role;
    const side = target.semantic?.side;
    if (side) layer.side = side;
    if (target.semantic?.visible === undefined) {
      if (source.visible === undefined) delete layer.visible;
    } else {
      layer.visible = target.semantic.visible;
    }
    targetLayers[layer.id] = layer;
    if (target.bindingMode === "copy" && target.mesh) {
      throw new Error(`複製目標 ${target.layerId} 使用自訂 mesh，不能複製含頂點索引的 layer binding；請省略 bindingMode 或改用 none。`);
    }
    if (target.bindingMode !== "copy") continue;
    for (const binding of sourceBindings) {
      const id = `${binding.id}/clone/${target.layerId}`;
      if (bindingIds.has(id)) throw new Error(`複製動作綁定 ID 已被占用：${id}`);
      bindingIds.add(id);
      model.bindings.push({ ...clone(binding), id, target: { kind: "layer", id: target.layerId } });
    }
  }
  return { assetLayers: targetLayers, model };
}

function applyHairStrandInfluences(layer: LayerBinding, interactiveMesh?: MeshBinding): void {
  if (!layer.hairStrands || layer.hairStrands.length < 2) return;
  const cached = layer.role !== "frontHair" ? interactiveHairInfluenceCache.get(interactiveMesh ?? layer.mesh)?.get(layer.hairStrands) : undefined;
  if (cached) {
    layer.mesh.influences = { ...(layer.mesh.influences ?? {}), ...cached };
    return;
  }
  const attachment = hairAttachmentInfluences(layer, layer.hairStrands);
  const derived = {
    headAttachment: attachment.headAttachment,
    physicsRelease: attachment.physicsRelease,
    physics: layer.mesh.points.map((point, index) => Math.max(
      layer.mesh.influences?.physics?.[index] ?? 0,
      attachment.physicsRelease[index] ?? 0,
      layer.role === "frontHair" ? frontHairPhysicsMask(layer, point) : 0
    ))
  };
  layer.mesh.influences = { ...(layer.mesh.influences ?? {}), ...derived };
  if (interactiveMesh && layer.role !== "frontHair") {
    let byStrands = interactiveHairInfluenceCache.get(interactiveMesh);
    if (!byStrands) {
      byStrands = new WeakMap();
      interactiveHairInfluenceCache.set(interactiveMesh, byStrands);
    }
    byStrands.set(layer.hairStrands, derived);
  }
}

function applyLayerOverride(layer: LayerBinding, override: LayerCalibrationOverride, interactive = false): LayerBinding {
  const next = interactive ? { ...layer } : clone(layer);
  const previousMesh = next.mesh;
  if (override.role) next.role = override.role;
  if (override.side) next.side = override.side;
  if (override.parentGroup) next.parentGroup = override.parentGroup;
  if (override.parentLayerId === null) delete next.parentLayerId;
  else if (override.parentLayerId !== undefined) next.parentLayerId = override.parentLayerId;
  if (override.deformerId === null) delete next.deformerId;
  else if (override.deformerId !== undefined) next.deformerId = override.deformerId;
  if (override.order !== undefined) next.order = override.order;
  if (override.visible !== undefined) next.visible = override.visible;
  if (override.locked !== undefined) next.locked = override.locked;
  if (override.pivot) {
    assertNormalized(override.pivot, `${layer.sourceName} 的轴心`);
    next.pivot = { ...override.pivot };
  }
  if (override.garmentStructure) next.garmentStructure = override.garmentStructure;
  if (override.garmentFlexibility !== undefined) next.garmentFlexibility = override.garmentFlexibility;
  if (override.headwearPerspective === null) delete next.headwearPerspective;
  else if (override.headwearPerspective !== undefined) next.headwearPerspective = override.headwearPerspective;
  if (override.blinkMode === null) delete next.blinkMode;
  else if (override.blinkMode !== undefined) next.blinkMode = override.blinkMode;
  if (override.headPoseMode === null) delete next.headPoseMode;
  else if (override.headPoseMode !== undefined) next.headPoseMode = override.headPoseMode;
  if (override.clipLayerId === null) delete next.clipLayerId;
  else if (override.clipLayerId !== undefined) next.clipLayerId = override.clipLayerId;
  if (override.secondaryAnchors) {
    for (const [name, point] of Object.entries(override.secondaryAnchors)) if (point) assertNormalized(point, `${layer.sourceName} 的 ${name}`);
    next.secondaryAnchors = { ...(next.secondaryAnchors ?? {}), ...clone(override.secondaryAnchors) };
  }
  if (override.weights) next.weights = { ...next.weights, ...override.weights };
  if (override.mesh) next.mesh = interactive ? override.mesh : clone(override.mesh);
  if (override.meshDensity) next.mesh = meshAtDensity(next, override.meshDensity.rows, override.meshDensity.cols, interactive);
  if (override.meshDetail !== undefined) {
    next.mesh = meshAtDetail(next.mesh, next.bounds, override.meshDetail, interactive);
  }
  const interactiveStructuralMesh = interactive ? next.mesh : undefined;
  if (interactive && next.mesh !== previousMesh) {
    next.mesh = {
      ...next.mesh,
      points: [...next.mesh.points],
      ...(next.mesh.influences ? { influences: { ...next.mesh.influences } } : {})
    };
  }
  if (override.meshDetail !== undefined) {
    if (next.role === "frontHair" && next.mesh.influences) {
      next.mesh.influences.physics = next.mesh.points.map((point) => frontHairPhysicsMask(next, point));
    }
  }
  if (override.hairStrands) next.hairStrands = clone(override.hairStrands);
  else if (next.mesh !== previousMesh && next.hairStrands) next.hairStrands = reprojectHairStrands(previousMesh, interactiveStructuralMesh ?? next.mesh, next.hairStrands, interactive);
  const pointDeltas = Object.entries(override.meshPointDeltas ?? {});
  if (interactive && pointDeltas.length > 0 && next.mesh === previousMesh) {
    next.mesh = { ...next.mesh, points: [...next.mesh.points] };
  }
  for (const [rawIndex, delta] of pointDeltas) {
    const index = Number(rawIndex);
    const base = next.mesh.points[index];
    if (!Number.isInteger(index) || !base) throw new Error(`${layer.sourceName} 不存在网格顶点 ${rawIndex}。`);
    const point = { x: base.x + delta.x, y: base.y + delta.y };
    assertNormalized(point, `${layer.sourceName} 的网格顶点 ${rawIndex}`);
    next.mesh.points[index] = point;
  }
  const derivedHairChanged = !interactive || override.mesh !== undefined || override.meshDensity !== undefined
    || override.meshDetail !== undefined || override.hairStrands !== undefined || override.role !== undefined;
  if (derivedHairChanged) {
    if (interactive && next.mesh === previousMesh) next.mesh = clone(next.mesh);
    applyHairStrandInfluences(next, interactiveStructuralMesh);
  }
  const vertexInfluenceEntries = Object.entries(override.vertexInfluences ?? {}) as Array<[MeshInfluenceChannel, Record<string, number>]>;
  if (interactive && vertexInfluenceEntries.length > 0 && next.mesh === previousMesh) next.mesh = { ...next.mesh };
  for (const [channel, values] of vertexInfluenceEntries) {
    const fallback = channel === "pin" || channel === "physicsRelease" ? 0 : 1;
    const target = [...(next.mesh.influences?.[channel] ?? Array(next.mesh.points.length).fill(fallback))];
    if (target.length !== next.mesh.points.length) throw new Error(`${layer.sourceName} 的 ${channel} 权重数量与网格不一致。`);
    for (const [rawIndex, value] of Object.entries(values)) {
      const index = Number(rawIndex);
      if (!Number.isInteger(index) || index < 0 || index >= target.length) throw new Error(`${layer.sourceName} 不存在权重顶点 ${rawIndex}。`);
      target[index] = value;
    }
    next.mesh.influences = { ...(next.mesh.influences ?? {}), [channel]: target };
  }
  return next;
}

function applyParsedCalibrationOverrides(project: PuppetLoomProject, overrides: CalibrationOverrides, interactive = false): PuppetLoomProject {
  const next: PuppetLoomProject = {
    ...project,
    version: PUPPETLOOM_PROJECT_VERSION,
    ...(overrides.model ? { model: clone(overrides.model) } : {}),
    ...(overrides.anchors ? { anchors: { ...project.anchors } } : {}),
    ...(overrides.layers || overrides.assetLayers ? { layers: [...project.layers] } : {}),
    ...(overrides.semanticPoints || overrides.runtime ? { runtime: { ...project.runtime } } : {})
  };
  if (overrides.assetLayers) {
    for (const [id, layer] of Object.entries(overrides.assetLayers)) {
      if (id !== layer.id || !layer.generatedAsset) throw new Error("补件图层必须带有对应的素材登记身份。" );
      const existing = next.layers.findIndex((candidate) => candidate.id === id);
      if (existing >= 0 && !next.layers[existing]!.generatedAsset) throw new Error(`补件不能覆盖源图层身份：${id}`);
      if (existing >= 0) next.layers[existing] = clone(layer);
      else next.layers.push(clone(layer));
    }
  }
  if (overrides.model) next.model = clone(overrides.model);
  if (overrides.anchors) {
    for (const [name, point] of Object.entries(overrides.anchors)) if (point) assertNormalized(point, `锚点 ${name}`);
    next.anchors = { ...next.anchors, ...clone(overrides.anchors) };
  }
  if (overrides.semanticPoints) {
    if (!next.runtime.semanticCage) throw new Error("当前项目没有可校准的语义控制笼。" );
    next.runtime.semanticCage = {
      ...next.runtime.semanticCage,
      points: { ...next.runtime.semanticCage.points }
    };
    for (const [id, position] of Object.entries(overrides.semanticPoints)) {
      if (!position || !(id in next.runtime.semanticCage.points)) throw new Error(`未知语义控制点：${id}`);
      assertNormalized(position, `语义控制点 ${id}`);
      const pointId = id as keyof typeof next.runtime.semanticCage.points;
      next.runtime.semanticCage.points[pointId] = {
        ...next.runtime.semanticCage.points[pointId],
        position: { ...position },
        source: "corrected",
        confidence: Math.max(0.9, next.runtime.semanticCage.points[pointId].confidence)
      };
    }
  }
  if (overrides.layers) {
    const known = new Set(next.layers.map((layer) => layer.id));
    for (const id of Object.keys(overrides.layers)) if (!known.has(id)) throw new Error(`未知图层：${id}`);
    next.layers = next.layers.map((layer) => overrides.layers?.[layer.id] ? applyLayerOverride(layer, overrides.layers[layer.id]!, interactive) : layer);
    const ids = new Set(next.layers.map((layer) => layer.id));
    for (const layer of next.layers) {
      if (layer.parentLayerId === layer.id) throw new Error(`${layer.sourceName} 不能把自己设为父图层。`);
      if (layer.parentLayerId && !ids.has(layer.parentLayerId)) throw new Error(`${layer.sourceName} 的父图层不存在。`);
      const visited = new Set([layer.id]);
      let current = layer;
      while (current.parentLayerId) {
        if (visited.has(current.parentLayerId)) throw new Error(`${layer.sourceName} 的父图层关系形成循环。`);
        visited.add(current.parentLayerId);
        current = next.layers.find((candidate) => candidate.id === current.parentLayerId)!;
      }
    }
  }
  if (overrides.runtime?.envelope) next.runtime.envelope = { ...next.runtime.envelope, ...overrides.runtime.envelope };
  if (overrides.runtime?.features) next.runtime.features = { ...next.runtime.features, ...overrides.runtime.features };
  if (overrides.runtime?.poseField) {
    if (!next.runtime.poseField) throw new Error("当前项目没有可校准的统一头部姿态场。");
    next.runtime.poseField = { ...next.runtime.poseField, ...overrides.runtime.poseField };
  }
  if (overrides.runtime?.poseOcclusion) {
    next.runtime.poseOcclusion = {
      kind: "semantic-occlusion-v1",
      fadeStart: 0.58,
      farEyeOpacity: 1,
      farBrowOpacity: 1,
      farEarOpacity: 0.55,
      farSideHairOpacity: 0.72,
      sideHairDepthSwap: true,
      ...(next.runtime.poseOcclusion ?? {}),
      ...overrides.runtime.poseOcclusion
    };
  }
  if (overrides.runtime?.torsoVolumeProfile) next.runtime.torsoVolumeProfile = clone(overrides.runtime.torsoVolumeProfile);
  if (overrides.runtime?.motionTuning) {
    next.runtime.motionTuning = {
      amplitude: 1,
      response: 0.72,
      stability: 0.42,
      ...(next.runtime.motionTuning ?? {}),
      ...overrides.runtime.motionTuning
    };
  }
  if (overrides.runtime?.secondaryMotionTuning) {
    const defaults = { amplitude: 1, response: 0.5, stability: 0.5 };
    const parts = new Set([
      ...Object.keys(next.runtime.secondaryMotionTuning ?? {}),
      ...Object.keys(overrides.runtime.secondaryMotionTuning)
    ]);
    next.runtime.secondaryMotionTuning = Object.fromEntries([...parts].map((part) => [part, {
      ...defaults,
      ...(next.runtime.secondaryMotionTuning?.[part as keyof typeof next.runtime.secondaryMotionTuning] ?? {}),
      ...(overrides.runtime?.secondaryMotionTuning?.[part as keyof typeof overrides.runtime.secondaryMotionTuning] ?? {})
    }]));
  }
  return next;
}

/**
 * Applies schema-checked overrides without reparsing the complete project.
 * This is the interactive editor boundary: every touched branch is copied,
 * while unchanged project data keeps its identity for renderer caches.
 */
export function applyCalibrationOverridesForPreview(project: PuppetLoomProject, rawOverrides: CalibrationOverrides): PuppetLoomProject {
  const overrides = calibrationOverridesSchema.parse(rawOverrides) as CalibrationOverrides;
  return applyParsedCalibrationOverrides(project, overrides, true);
}

/** Applies an already parsed in-memory draft without repeating deep schema work. */
export function applyCalibrationOverridesForInteractivePreview(project: PuppetLoomProject, overrides: CalibrationOverrides): PuppetLoomProject {
  return applyParsedCalibrationOverrides(project, overrides, true);
}

/** Applies overrides at a persistence boundary and validates the final project once. */
export function applyCalibrationOverrides(project: PuppetLoomProject, rawOverrides: CalibrationOverrides): PuppetLoomProject {
  const overrides = calibrationOverridesSchema.parse(rawOverrides) as CalibrationOverrides;
  const normalizedProject = project.version === PUPPETLOOM_PROJECT_VERSION
    ? project
    : parsePuppetLoomProject(project);
  return parsePuppetLoomProject(applyParsedCalibrationOverrides(normalizedProject, overrides));
}
