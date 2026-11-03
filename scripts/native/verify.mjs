import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { activeNativeAxes, buildPoses, selectVisualPoses } from './poses.mjs';
import { assertRecordedMocPath } from './export-paths.mjs';
import { writeContactSheets } from './contact-sheets.mjs';
import { validateNativeSourceMapParameters } from './source-map-validation.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
const safeExportPath = (root, path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error(`Invalid relative export asset path: ${path}`);
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Export asset escapes export directory: ${path}`);
  return full;
};
function assertFiniteArray(values, label) {
  if (!Array.isArray(values) || !values.every((value) => Number.isFinite(value))) {
    throw new Error(`${label} must be a finite array.`);
  }
}

function assertIntegerArray(values, label) {
  if (!Array.isArray(values) || !values.every((value) => Number.isInteger(value))) {
    throw new Error(`${label} must be an integer array.`);
  }
}

function orientedTriangleKey(triangle) {
  const [a, b, c] = triangle;
  return [`${a},${b},${c}`, `${b},${c},${a}`, `${c},${a},${b}`].sort()[0];
}

function triangleMultiset(indices, reverse = false) {
  const result = new Map();
  for (let index = 0; index < indices.length; index += 3) {
    const triangle = indices.slice(index, index + 3);
    const oriented = reverse ? [triangle[0], triangle[2], triangle[1]] : triangle;
    const key = orientedTriangleKey(oriented);
    result.set(key, (result.get(key) ?? 0) + 1);
  }
  return result;
}

function sameMultiset(left, right) {
  if (left.size !== right.size) return false;
  return [...left].every(([key, count]) => right.get(key) === count);
}

/**
 * Compare triangle topology while preserving winding. Cubism Core may reverse
 * every triangle in a layer because its Y axis differs from the authoring
 * coordinate system, but a mixed direct/reversed layer is never acceptable.
 */
export function classifyNativeTriangleWinding(actual, expected, { allowGlobalReverse = true } = {}) {
  assertIntegerArray(actual, 'actual triangle indices');
  assertIntegerArray(expected, 'expected triangle indices');
  if (actual.length !== expected.length || actual.length % 3 !== 0) {
    return { ok: false, reason: 'triangle-length-mismatch' };
  }
  const actualSet = triangleMultiset(actual), expectedDirect = triangleMultiset(expected), expectedReversed = triangleMultiset(expected, true);
  const directMatch = sameMultiset(actualSet, expectedDirect), reverseMatch = allowGlobalReverse && sameMultiset(actualSet, expectedReversed);
  if (directMatch && reverseMatch) return { ok: true, convention: 'symmetric' };
  if (directMatch) return { ok: true, convention: 'direct' };
  if (reverseMatch) return { ok: true, convention: 'reversed' };

  // Diagnose local mixing only when the orientation is unambiguous for the
  // affected triangle keys. Symmetric duplicate triangles remain a topology
  // mismatch rather than being incorrectly called ambiguous.
  const orientations = new Set();
  for (let index = 0; index < actual.length; index += 3) {
    const triangle = actual.slice(index, index + 3);
    const directPossible = expectedDirect.has(orientedTriangleKey(triangle));
    const reversePossible = expectedReversed.has(orientedTriangleKey(triangle));
    if (directPossible && !reversePossible) orientations.add('direct');
    if (reversePossible && !directPossible) orientations.add('reversed');
  }
  if (orientations.size > 1) return { ok: false, reason: 'mixed-triangle-winding' };
  return { ok: false, reason: allowGlobalReverse ? 'triangle-winding-mismatch' : 'source-map-winding-mismatch' };
}

/**
 * Derive the export vertex correspondence from canonical mesh topology.
 * Export compaction is deterministic: referenced canonical indices are kept in
 * ascending order. No source-map position array participates in this mapping.
 */
export function deriveNativeVertexMapping(sourceLayer, exportedVertexCount) {
  const mesh = sourceLayer?.mesh;
  const points = mesh?.points;
  const sourceTriangles = mesh?.triangles;
  if (!Array.isArray(points) || !Array.isArray(sourceTriangles)) throw new Error(`${sourceLayer?.id ?? 'layer'} canonical mesh is incomplete.`);
  if (!Number.isInteger(exportedVertexCount) || exportedVertexCount < 0) throw new Error('export vertex count must be a non-negative integer.');
  assertIntegerArray(sourceTriangles, `${sourceLayer?.id ?? 'layer'} canonical triangle indices`);
  if (sourceTriangles.length % 3 !== 0) throw new Error(`${sourceLayer?.id ?? 'layer'} canonical triangles are malformed.`);
  for (const index of sourceTriangles) {
    if (index < 0 || index >= points.length) throw new Error(`${sourceLayer.id} canonical triangle index is out of range.`);
  }
  if (exportedVertexCount === points.length) {
    const identity = points.map((_, index) => index);
    return { compacted: false, compactToOld: identity, oldToNew: identity.slice(), remappedTriangles: sourceTriangles.slice() };
  }
  const compactToOld = [...new Set(sourceTriangles)].sort((left, right) => left - right);
  if (exportedVertexCount !== compactToOld.length) {
    throw new Error(`${sourceLayer.id} export vertex count ${exportedVertexCount} disagrees with canonical referenced vertex count ${compactToOld.length}.`);
  }
  const oldToNew = points.map(() => -1);
  compactToOld.forEach((oldIndex, compactIndex) => { oldToNew[oldIndex] = compactIndex; });
  const remappedTriangles = sourceTriangles.map((oldIndex) => oldToNew[oldIndex]);
  if (remappedTriangles.some((index) => index < 0)) throw new Error(`${sourceLayer.id} canonical triangle references an unmapped vertex.`);
  return { compacted: true, compactToOld, oldToNew, remappedTriangles };
}

export function compactNativePositions(canonicalPositions, compactToOld) {
  assertFiniteArray(canonicalPositions, 'canonical sampler positions');
  assertIntegerArray(compactToOld, 'compact vertex mapping');
  if (canonicalPositions.length % 2 !== 0) throw new Error('canonical sampler positions must contain XY pairs.');
  if (new Set(compactToOld).size !== compactToOld.length) throw new Error('compact vertex mapping contains duplicate indices.');
  return compactToOld.flatMap((oldIndex) => {
    if (oldIndex < 0 || oldIndex >= canonicalPositions.length / 2) throw new Error(`compact vertex mapping index ${oldIndex} is out of range.`);
    return [canonicalPositions[oldIndex * 2], canonicalPositions[oldIndex * 2 + 1]];
  });
}

export function compareNativeScalar(actual, expected, label) {
  if (!Number.isFinite(actual)) return { ok: false, reason: `${label}-missing-or-nonfinite`, error: Number.POSITIVE_INFINITY };
  if (!Number.isFinite(expected)) throw new Error(`${label} expected value is not finite.`);
  return { ok: true, error: Math.abs(actual - expected) };
}

export function maxNativeArrayError(actual, expected, label) {
  assertFiniteArray(actual, `${label} actual`);
  assertFiniteArray(expected, `${label} expected`);
  if (actual.length !== expected.length) return Number.POSITIVE_INFINITY;
  let maximum = 0;
  for (let index = 0; index < actual.length; index += 1) maximum = Math.max(maximum, Math.abs(actual[index] - expected[index]));
  return maximum;
}

/**
 * Validate the exporter contract shared by canonical visible layers, the
 * source-map drawableIds, and export-status drawableIds. The exporter emits
 * one drawable for every project layer whose visible flag is not false.
 */
export function validateNativeDrawableMappings({ projectLayers, sourceMap, exportStatus }) {
  const failures = [];
  const visibleLayers = Array.isArray(projectLayers) ? projectLayers.filter((layer) => layer?.visible !== false) : [];
  if (!Array.isArray(projectLayers)) failures.push({ reason: 'canonical-layer-list-missing' });

  const readMap = (value, mapping) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      failures.push({ reason: 'drawable-map-missing', mapping });
      return new Map();
    }
    const entries = Object.entries(value);
    const seenCoreIds = new Map();
    for (const [sourceId, coreId] of entries) {
      if (!sourceId || typeof coreId !== 'string' || !coreId) {
        failures.push({ reason: 'drawable-map-entry-invalid', mapping, sourceId, coreId });
        continue;
      }
      const sources = seenCoreIds.get(coreId) ?? [];
      sources.push(sourceId);
      seenCoreIds.set(coreId, sources);
    }
    for (const [coreId, sourceIds] of seenCoreIds) {
      if (sourceIds.length > 1) failures.push({ reason: 'drawable-map-core-id-duplicate', mapping, coreId, sourceIds });
    }
    return new Map(entries);
  };

  const statusMap = readMap(exportStatus?.drawableIds, 'export-status');
  const sourceMapDrawableIds = readMap(sourceMap?.drawableIds, 'source-map');
  const visibleSourceIds = new Set();
  for (const layer of visibleLayers) {
    if (!layer || typeof layer.id !== 'string' || !layer.id) {
      failures.push({ reason: 'canonical-visible-id-missing' });
      continue;
    }
    if (visibleSourceIds.has(layer.id)) failures.push({ reason: 'canonical-visible-id-duplicate', sourceId: layer.id });
    visibleSourceIds.add(layer.id);
  }
  for (const sourceId of visibleSourceIds) {
    if (!statusMap.has(sourceId)) failures.push({ reason: 'drawable-map-missing', mapping: 'export-status', sourceId });
    if (!sourceMapDrawableIds.has(sourceId)) failures.push({ reason: 'drawable-map-missing', mapping: 'source-map', sourceId });
  }
  for (const sourceId of statusMap.keys()) {
    if (!visibleSourceIds.has(sourceId)) failures.push({ reason: 'drawable-map-unexpected-source', mapping: 'export-status', sourceId });
  }
  for (const sourceId of sourceMapDrawableIds.keys()) {
    if (!visibleSourceIds.has(sourceId)) failures.push({ reason: 'drawable-map-unexpected-source', mapping: 'source-map', sourceId });
  }
  const sourceIds = new Set([...statusMap.keys(), ...sourceMapDrawableIds.keys()]);
  for (const sourceId of sourceIds) {
    const statusId = statusMap.get(sourceId), sourceMapId = sourceMapDrawableIds.get(sourceId);
    if (statusId !== sourceMapId) failures.push({ reason: 'drawable-map-disagrees', sourceId, exportStatusId: statusId, sourceMapId });
  }

  const sourceMapLayers = sourceMap?.layers;
  if (!Array.isArray(sourceMapLayers)) {
    failures.push({ reason: 'source-map-layer-list-missing' });
  } else {
    const seenLayerIds = new Set();
    const seenLayerSources = new Set();
    const sourceMapLayerById = new Map();
    for (const layer of sourceMapLayers) {
      if (!layer || typeof layer.id !== 'string' || !layer.id) {
        failures.push({ reason: 'source-map-layer-id-invalid' });
        continue;
      }
      if (seenLayerIds.has(layer.id)) failures.push({ reason: 'source-map-layer-id-duplicate', coreId: layer.id });
      seenLayerIds.add(layer.id);
      sourceMapLayerById.set(layer.id, layer);
      if (typeof layer.sourceId !== 'string' || !layer.sourceId) {
        failures.push({ reason: 'source-map-layer-source-missing', coreId: layer.id });
        continue;
      }
      if (seenLayerSources.has(layer.sourceId)) failures.push({ reason: 'source-map-layer-source-duplicate', sourceId: layer.sourceId });
      seenLayerSources.add(layer.sourceId);
      if (sourceMapDrawableIds.get(layer.sourceId) !== layer.id) failures.push({ reason: 'source-map-layer-mapping-disagrees', sourceId: layer.sourceId, coreId: layer.id, mappedCoreId: sourceMapDrawableIds.get(layer.sourceId) });
    }
    for (const coreId of sourceMapDrawableIds.values()) if (!seenLayerIds.has(coreId)) failures.push({ reason: 'source-map-layer-missing', coreId });
    for (const layer of sourceMapLayers) if (layer?.sourceId && !sourceMapDrawableIds.has(layer.sourceId)) failures.push({ reason: 'source-map-layer-unexpected-source', sourceId: layer.sourceId, coreId: layer.id });

    for (const layer of visibleLayers) {
      if (!layer || typeof layer.id !== 'string' || !layer.id) continue;
      const coreId = sourceMapDrawableIds.get(layer.id), sourceMapLayer = sourceMapLayerById.get(coreId);
      if (!sourceMapLayer) continue;
      const clipLayerId = layer.clipLayerId;
      let expectedMasks = [];
      if (clipLayerId !== undefined && clipLayerId !== null && clipLayerId !== '') {
        if (!visibleSourceIds.has(clipLayerId)) {
          failures.push({ reason: 'canonical-mask-target-not-visible', sourceId: layer.id, clipLayerId });
        } else if (!sourceMapDrawableIds.has(clipLayerId)) {
          failures.push({ reason: 'canonical-mask-target-unmapped', sourceId: layer.id, clipLayerId });
        } else {
          expectedMasks = [sourceMapDrawableIds.get(clipLayerId)];
        }
      }
      if (!Array.isArray(sourceMapLayer.masks)) {
        failures.push({ reason: 'source-map-masks-missing', sourceId: layer.id, coreId });
        continue;
      }
      const unknownMasks = sourceMapLayer.masks.filter((maskId) => !new Set(sourceMapDrawableIds.values()).has(maskId));
      if (unknownMasks.length) failures.push({ reason: 'source-map-mask-unknown', sourceId: layer.id, coreId, maskIds: unknownMasks });
      if (sourceMapLayer.masks.length !== expectedMasks.length || sourceMapLayer.masks.some((maskId, index) => maskId !== expectedMasks[index])) {
        failures.push({ reason: 'source-map-masks-disagree', sourceId: layer.id, coreId, expectedMasks, actualMasks: sourceMapLayer.masks });
      }
    }
  }
  return { ok: failures.length === 0, failures };
}

async function findPwsh() {
  if (process.env.VTUBERTAILOR_PWSH) return process.env.VTUBERTAILOR_PWSH;
  const candidates = process.platform === 'win32' ? ['pwsh.exe', 'pwsh'] : ['pwsh'];
  return candidates[0];
}
function spawnChecked(command, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { ...options, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolvePromise() : reject(new Error(`Native Core probe exited with code ${code}.`)));
  });
}

export async function runNativeVerification({ project: projectDir, exportDir, core, output, engine, sharp }) {
  const { loadProject, loadCalibration, projectFingerprint, nativeLayerSampler, nativeArtPositions, neutralMotionState, renderProjectPoseWithSources } = engine;
  for (const path of [projectDir, exportDir, core, output]) if (!isAbsolute(path)) throw new Error(`Expected absolute path: ${path}`);
  const project = await loadProject(projectDir);
  const calibration = await loadCalibration(projectDir);
  const fingerprint = projectFingerprint(project);
  const exportStatus = await readJson(join(exportDir, 'export-status.json'));
  const model3Path = join(exportDir, 'model.model3.json');
  const sourceMapPath = join(exportDir, 'puppetloom-source', 'model.json');
  const model3 = await readJson(model3Path), sourceMap = await readJson(sourceMapPath);
  if (exportStatus.sourceRevision !== calibration.revision) throw new Error(`Project/export revision mismatch: ${calibration.revision} != ${exportStatus.sourceRevision}`);
  if (exportStatus.sourceFingerprint !== fingerprint) throw new Error('Project/export source fingerprint mismatch.');
  if (!Number.isFinite(exportStatus.parameterScale) || exportStatus.parameterScale !== sourceMap.parameterScale) throw new Error('Export parameter scale is missing or disagrees with exported source map.');
  const parameterMapping = validateNativeSourceMapParameters({ project, sourceMap, exportStatus });
  if (!parameterMapping.ok) throw new Error(`Native source-map parameter mapping is invalid: ${JSON.stringify(parameterMapping.failures.slice(0, 10))}`);
  if (sourceMap.width !== project.canvas.width || sourceMap.height !== project.canvas.height) throw new Error('Export source canvas does not match the canonical project.');
  if (!model3.FileReferences?.Moc || !Array.isArray(model3.FileReferences.Textures) || !model3.FileReferences.Textures.length) throw new Error('model.model3.json is missing MOC or texture references.');
  const mocPath = safeExportPath(exportDir, model3.FileReferences.Moc);
  assertRecordedMocPath(exportStatus, exportDir, mocPath);
  const mocBytes = await readFile(mocPath), mocSha = sha256(mocBytes);

  const { poses, features } = buildPoses(project, new Set(Object.keys(exportStatus.parameterIds ?? {})), activeNativeAxes(sourceMap, project));
  if (!poses.length) throw new Error('No supported pose parameters were found in this project.');
  const corePoses = poses.map(({ id, parameters }) => ({ id, parameters: Object.fromEntries(Object.entries(parameters).map(([sourceId, value]) => {
    const mapped = exportStatus.parameterIds?.[sourceId];
    if (!mapped) throw new Error(`Export is missing Core parameter mapping for ${sourceId}.`);
    return [mapped, value * exportStatus.parameterScale];
  })) }));
  const rawPath = join(output, 'core-poses-raw.json'), inputPath = join(output, 'poses-input.json');
  await mkdir(output, { recursive: false });
  await writeJson(inputPath, corePoses);
  const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'probe-core-render-contract.ps1');
  const pwsh = await findPwsh();
  await spawnChecked(pwsh, ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-MocPath', mocPath, '-OutputPath', rawPath, '-PoseInputPath', inputPath, '-CorePath', core], { cwd: dirname(scriptPath) });
  const rawBytes = await readFile(rawPath), readback = JSON.parse(rawBytes.toString('utf8'));
  if (readback.status !== 'loaded' || resolve(readback.mocPath ?? '').toLowerCase() !== mocPath.toLowerCase() || readback.mocSha256 !== mocSha || readback.mocBytes !== mocBytes.length) throw new Error('Fresh official Core readback does not match the selected export MOC.');
  if (readback.poses?.length !== poses.length || readback.poses.some((pose, index) => pose.id !== poses[index].id)) throw new Error('Official Core returned an unexpected pose set or order.');
  if (readback.mocVersion > readback.latestMocVersion) throw new Error(`Unsupported MOC version ${readback.mocVersion} (Core supports through ${readback.latestMocVersion}).`);

  const inputLayers = new Map((sourceMap.layers ?? []).map((layer) => [layer.id, layer]));
  const sourceLayers = new Map(project.layers.map((layer) => [layer.id, layer]));
  const coreIdToSourceId = new Map(Object.entries(exportStatus.drawableIds ?? {}).map(([sourceId, coreId]) => [coreId, sourceId]));
  const drawableMapping = validateNativeDrawableMappings({ projectLayers: project.layers, sourceMap, exportStatus });
  const samplers = new Map(project.layers.map((layer) => [layer.id, nativeLayerSampler(project, layer)]));
  const geometry = [], mappedPoses = [], failures = drawableMapping.failures.map((failure) => ({ pose: 'mapping', ...failure }));
  const maxima = { pixels: 0, sourceMapPositions: 0, opacity: 0, uv: 0, order: 0 };
  for (let pi = 0; pi < poses.length; pi++) {
    const pose = poses[pi], actualPose = readback.poses[pi], mappedLayers = [];
    const expectedCoreIds = new Set(inputLayers.keys());
    const actualIds = actualPose.layers.map((layer) => layer.id);
    if (new Set(actualIds).size !== actualIds.length || actualIds.length !== expectedCoreIds.size || actualIds.some((id) => !expectedCoreIds.has(id))) {
      failures.push({ pose: pose.id, reason: 'drawable-id-set-mismatch', expected: expectedCoreIds.size, actual: actualIds.length });
    }
    let matched = 0;
    for (const drawable of actualPose.layers) {
      const sourceId = coreIdToSourceId.get(drawable.id) ?? drawable.id;
      const input = inputLayers.get(drawable.id) ?? inputLayers.get(sourceId), source = sourceLayers.get(sourceId), sampler = samplers.get(sourceId);
      if (!input || !source || !sampler) {
        failures.push({ pose: pose.id, layer: drawable.id, reason: 'unmapped-core-drawable', sourceId, hasSourceMapLayer: Boolean(input), hasCanonicalLayer: Boolean(source), hasCanonicalSampler: Boolean(sampler) });
        continue;
      }
      matched++;
      const expected = sampler(pose.parameters);
      assertFiniteArray(expected.positions, `${sourceId} canonical sampler positions`);
      assertFiniteArray(drawable.positions, `${sourceId} Core positions`);
      assertFiniteArray(drawable.uvs, `${sourceId} Core UVs`);
      assertIntegerArray(drawable.indices, `${sourceId} Core triangle indices`);
      const positions = drawable.positions.map((value, i) => i % 2 === 0 ? value * readback.canvas.pixelsPerUnit + readback.canvas.originX : readback.canvas.originY - value * readback.canvas.pixelsPerUnit);
      assertFiniteArray(positions, `${sourceId} converted Core positions`);
      const vertexCount = drawable.vertexCount ?? positions.length / 2;
      const mapping = deriveNativeVertexMapping(source, vertexCount);
      const expectedPositions = compactNativePositions(expected.positions, mapping.compactToOld);
      const sourceMapPositions = input.positions;
      const sourceMapUvs = input.uvs;
      assertFiniteArray(sourceMapPositions, `${sourceId} export source-map positions`);
      assertFiniteArray(sourceMapUvs, `${sourceId} export source-map UVs`);
      assertIntegerArray(input.triangles, `${sourceId} export source-map triangle indices`);
      const sourceMapTopology = classifyNativeTriangleWinding(input.triangles, mapping.remappedTriangles, { allowGlobalReverse: false });
      if (sourceMapPositions.length !== expectedPositions.length || sourceMapUvs.length !== expectedPositions.length) {
        failures.push({ pose: pose.id, layer: sourceId, reason: 'source-map-vertex-array-length-mismatch', sourceMapPositions: sourceMapPositions.length / 2, sourceMapUvs: sourceMapUvs.length / 2, expectedVertices: mapping.compactToOld.length });
      }
      const expectedSourceMapPositions = compactNativePositions(nativeArtPositions(project, source), mapping.compactToOld);
      const sourceMapPositionError = maxNativeArrayError(sourceMapPositions, expectedSourceMapPositions, `${sourceId} source-map positions`);
      maxima.sourceMapPositions = Math.max(maxima.sourceMapPositions, sourceMapPositionError);
      if (sourceMapPositionError > 1e-6) failures.push({ pose: pose.id, layer: sourceId, reason: 'source-map-position-mismatch', sourceMapPositionError });
      if (sourceMapTopology.ok === false) failures.push({ pose: pose.id, layer: sourceId, reason: sourceMapTopology.reason ?? 'source-map-topology-mismatch' });
      if (sourceMapUvs.some((value) => value < -1e-6 || value > 1 + 1e-6)) failures.push({ pose: pose.id, layer: sourceId, reason: 'source-map-uv-out-of-range' });
      if (drawable.uvs.some((value) => value < -1e-6 || value > 1 + 1e-6)) failures.push({ pose: pose.id, layer: sourceId, reason: 'core-uv-out-of-range' });
      if (input.triangles.some((index) => index < 0 || index >= mapping.compactToOld.length)) failures.push({ pose: pose.id, layer: sourceId, reason: 'source-map-triangle-index-out-of-range' });
      if (drawable.indices.some((index) => index < 0 || index >= mapping.compactToOld.length)) failures.push({ pose: pose.id, layer: sourceId, reason: 'core-triangle-index-out-of-range' });
      if (drawable.vertexCount !== undefined && drawable.vertexCount !== mapping.compactToOld.length) failures.push({ pose: pose.id, layer: sourceId, reason: 'core-vertex-count-mismatch', actual: drawable.vertexCount, expected: mapping.compactToOld.length });
      if (positions.length !== expectedPositions.length || drawable.uvs.length !== sourceMapUvs.length) failures.push({ pose: pose.id, layer: sourceId, reason: 'core-vertex-array-length-mismatch', positions: positions.length / 2, uvs: drawable.uvs.length / 2, expectedVertices: mapping.compactToOld.length });
      let pixelError = 0, uvError = 0;
      if (positions.length === expectedPositions.length) for (let i = 0; i < positions.length; i += 2) pixelError = Math.max(pixelError, Math.hypot(positions[i] - expectedPositions[i], positions[i + 1] - expectedPositions[i + 1]));
      if (drawable.uvs.length === sourceMapUvs.length) for (let i = 0; i < drawable.uvs.length; i++) uvError = Math.max(uvError, Math.abs(drawable.uvs[i] - (i % 2 ? 1 - sourceMapUvs[i] : sourceMapUvs[i])));
      const opacityResult = compareNativeScalar(drawable.opacity, expected.opacity, `${sourceId} opacity`);
      const orderResult = compareNativeScalar(drawable.drawOrder, expected.order, `${sourceId} draw-order`);
      if (!opacityResult.ok) failures.push({ pose: pose.id, layer: sourceId, reason: opacityResult.reason });
      if (!orderResult.ok) failures.push({ pose: pose.id, layer: sourceId, reason: orderResult.reason });
      const opacityError = opacityResult.error, orderError = orderResult.error;
      const topologyResult = classifyNativeTriangleWinding(drawable.indices, mapping.remappedTriangles);
      const topology = topologyResult.ok;
      if (drawable.textureIndex !== input.texture) failures.push({ pose: pose.id, layer: sourceId, reason: 'texture-index-mismatch' });
      if (pixelError > 0.55 || (opacityResult.ok && opacityError > 0.03) || uvError > 2e-6 || (orderResult.ok && orderError > 1) || !topology) failures.push({ pose: pose.id, layer: sourceId, pixelError, opacityError, uvError, orderError, topology, topologyReason: topologyResult.reason });
      maxima.pixels = Math.max(maxima.pixels, pixelError); maxima.opacity = Math.max(maxima.opacity, opacityError); maxima.uv = Math.max(maxima.uv, uvError); maxima.order = Math.max(maxima.order, orderError);
      mappedLayers.push({ ...drawable, sourceId, positions });
    }
    if (!matched) failures.push({ pose: pose.id, reason: 'no-drawables-matched-to-export-map' });
    const ranks = actualPose.layers.map((layer) => layer.renderOrder);
    const validRanks = ranks.every(Number.isInteger) && new Set(ranks).size === ranks.length && Math.min(...ranks) === 0 && Math.max(...ranks) === ranks.length - 1;
    if (!validRanks) failures.push({ pose: pose.id, reason: 'render-order-not-permutation' });
    for (let a = 0; a < actualPose.layers.length; a++) for (let b = a + 1; b < actualPose.layers.length; b++) {
      if ((actualPose.layers[a].drawOrder - actualPose.layers[b].drawOrder) * (actualPose.layers[a].renderOrder - actualPose.layers[b].renderOrder) < 0) failures.push({ pose: pose.id, reason: 'render-order-reverses-authored-stack', left: actualPose.layers[a].id, right: actualPose.layers[b].id });
    }
    const geometryOnly = !pose.visual;
    geometry.push({ id: pose.id, family: pose.family, parameters: pose.parameters, verification: 'official-Core-readback-vs-native-sampler', visual: pose.visual, geometryOnly, matchedDrawables: matched });
    mappedPoses.push({ ...actualPose, layers: mappedLayers });
  }
  await writeJson(join(output, 'core-poses.json'), mappedPoses);

  const chosen = selectVisualPoses(poses);
  const textures = model3.FileReferences.Textures;
  const atlasFiles = await Promise.all(textures.map(async (path) => {
    const bytes = await readFile(safeExportPath(exportDir, path));
    return { path, sha256: sha256(bytes), bytes: bytes.length };
  }));
  const framesDir = join(output, 'atlas-frames'); await mkdir(framesDir);
  const cached = new Map(), rendered = [];
  for (const pose of chosen) {
    const poseData = mappedPoses.find((item) => item.id === pose.id);
    const clone = structuredClone(project);
    clone.model.bindings = []; clone.model.expressions = []; clone.model.behaviors = [];
    delete clone.runtime.poseField; delete clone.runtime.poseOcclusion; delete clone.runtime.collisionConstraints;
    for (const layer of clone.layers) {
      const exportId = exportStatus.drawableIds?.[layer.id] ?? layer.id;
      const input = inputLayers.get(exportId), coreLayer = poseData.layers.find((row) => row.sourceId === layer.id);
      if (!input || !coreLayer) { layer.visible = false; layer.texture = textures[0]; continue; }
      if (coreLayer.positions.length !== coreLayer.uvs.length || coreLayer.positions.length / 2 !== coreLayer.vertexCount) throw new Error(`Malformed official Core mesh arrays: ${exportId}`);
      layer.texture = textures[coreLayer.textureIndex];
      layer.mesh.points = Array.from({ length: coreLayer.positions.length / 2 }, (_, i) => ({ x: coreLayer.positions[i * 2] / project.canvas.width, y: coreLayer.positions[i * 2 + 1] / project.canvas.height }));
      layer.mesh.uvs = Array.from({ length: coreLayer.uvs.length / 2 }, (_, i) => ({ x: coreLayer.uvs[i * 2], y: 1 - coreLayer.uvs[i * 2 + 1] }));
      layer.mesh.triangles = [...coreLayer.indices]; layer.opacity = coreLayer.opacity; layer.order = coreLayer.renderOrder;
      layer.role = 'other'; layer.weights = { head: 0, body: 0, gaze: 0, physics: 0 }; layer.blinkMode = 'geometry';
      const masks = input.masks ?? [];
      if (masks.length > 1) throw new Error(`Cannot represent ${masks.length} exported masks for drawable ${exportId}.`);
      if (masks.length) {
        const maskSource = coreIdToSourceId.get(masks[0]) ?? sourceMap.layers.find((item) => item.id === masks[0])?.sourceId;
        if (!maskSource || !sourceLayers.has(maskSource)) throw new Error(`Export mask cannot map to project layer: ${masks[0]}`);
        layer.clipLayerId = maskSource;
      } else delete layer.clipLayerId;
    }
    const sourceBuffers = new Map();
    const renderLayerIds = new Set(clone.layers.filter((layer) => layer.visible).map((layer) => layer.id));
    for (const layer of clone.layers) if (renderLayerIds.has(layer.id) && layer.clipLayerId) renderLayerIds.add(layer.clipLayerId);
    for (const layer of clone.layers) {
      if (!renderLayerIds.has(layer.id)) continue;
      const abs = resolve(exportDir, layer.texture);
      if (!cached.has(abs)) {
        const image = await sharp(abs).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        cached.set(abs, { width: image.info.width, height: image.info.height, data: new Uint8ClampedArray(image.data) });
      }
      sourceBuffers.set(layer.id, cached.get(abs));
    }
    const size = pose.id === 'head-1-1' ? 2048 : ['yaw-blink', 'head-combined', 'head-grid'].includes(pose.family) ? 1536 : 768;
    const corePixels = renderProjectPoseWithSources(clone, sourceBuffers, neutralMotionState, size, size);
    const corePng = await sharp(Buffer.from(corePixels.data), { raw: { width: size, height: size, channels: 4 } }).png().toBuffer();
    const safeName = pose.id.replace(/[^A-Za-z0-9_-]/g, '_');
    const filename = `${safeName}-${size}.png`;
    await writeFile(join(framesDir, filename), corePng);
    const sourceClone = structuredClone(project);
    const sourceState = { ...neutralMotionState, parameters: { ...Object.fromEntries(project.model.parameters.map((p) => [p.id, p.default])), ...pose.parameters } };
    // Source comparison uses canonical texture buffers; decode them from the project paths.
    const canonicalBuffers = new Map();
    const canonicalLayerIds = new Set(sourceClone.layers.filter((l) => l.visible).map((l) => l.id));
    for (const layer of sourceClone.layers) if (canonicalLayerIds.has(layer.id) && layer.clipLayerId) canonicalLayerIds.add(layer.clipLayerId);
    for (const layer of sourceClone.layers.filter((l) => canonicalLayerIds.has(l.id))) {
      const abs = resolve(projectDir, layer.texture);
      if (!cached.has(abs)) { const image = await sharp(abs).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); cached.set(abs, { width: image.info.width, height: image.info.height, data: new Uint8ClampedArray(image.data) }); }
      canonicalBuffers.set(layer.id, cached.get(abs));
    }
    const canonicalPixels = renderProjectPoseWithSources(sourceClone, canonicalBuffers, sourceState, size, size);
    let sum = 0;
    for (let i = 0; i < corePixels.data.length; i += 4) {
      for (let c = 0; c < 3; c++) sum += Math.abs(corePixels.data[i + c] * corePixels.data[i + 3] / 255 - canonicalPixels.data[i + c] * canonicalPixels.data[i + 3] / 255);
      sum += Math.abs(corePixels.data[i + 3] - canonicalPixels.data[i + 3]);
    }
    const meanPremultipliedError = sum / corePixels.data.length;
    if (meanPremultipliedError > 1) failures.push({ pose: pose.id, reason: 'mean-premultiplied-image-error', meanPremultipliedError });
    rendered.push({ id: pose.id, family: pose.family, filename, size, sha256: sha256(corePng), meanPremultipliedError, origin: 'offline render using official Core geometry readback and exported model3 atlas; not a VTube Studio screenshot' });
  }
  const contacts = await writeContactSheets({ sharp, framesDir, rendered, output });
  const report = {
    status: failures.length ? 'failed' : 'passed', verifier: 'VTuberTailor official Core readback + exported-atlas offline render',
    sourceRevision: calibration.revision, sourceFingerprint: fingerprint,
    project: projectDir, export: exportDir, output,
    core: { path: core, version: readback.coreVersion, latestMocVersion: readback.latestMocVersion, mocVersion: readback.mocVersion },
    moc: { path: relative(exportDir, mocPath), bytes: mocBytes.length, sha256: mocSha },
    exportMetadata: { model3Sha256: sha256(await readFile(model3Path)), sourceMapSha256: sha256(await readFile(sourceMapPath)), atlases: atlasFiles },
    parameterScale: exportStatus.parameterScale, features,
    poseCoverage: { total: poses.length, visualPoseIds: chosen.map((p) => p.id), geometryOnlyPoseIds: geometry.filter((p) => p.geometryOnly).map((p) => p.id), poses: geometry },
    thresholds: { positionPixels: 0.55, sourceMapPositions: 1e-6, opacity: 0.03, uv: 2e-6, renderOrder: 1, meanPremultipliedImage: 1 },
    maxima, rendered, contacts, failures,
    rawCoreReadback: { path: 'core-poses-raw.json', sha256: sha256(rawBytes), bytes: rawBytes.length, freshThisRun: true },
    rendering: 'Frames use readback positions, UVs, indices, opacity, renderOrders from the supplied official Core DLL and textures referenced by model.model3.json. Images are offline renders, not VTube Studio screenshots.',
  };
  await writeJson(join(output, 'native-report.json'), report);
  console.log(JSON.stringify({ status: report.status, output, poses: poses.length, rendered: rendered.length, maxima, failures: failures.slice(0, 8) }, null, 2));
  if (failures.length) process.exitCode = 1;
}
