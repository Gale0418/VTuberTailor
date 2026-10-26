import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildPoses } from './poses.mjs';
import { assertRecordedMocPath } from './export-paths.mjs';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
const writeJson = (path, data) => writeFile(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
const safeExportPath = (root, path) => {
  if (typeof path !== 'string' || !path || isAbsolute(path)) throw new Error(`Invalid relative export asset path: ${path}`);
  const full = resolve(root, path), rel = relative(root, full);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`Export asset escapes export directory: ${path}`);
  return full;
};
const triangles = (indices) => Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3).sort((a,b) => a-b).join(',')).sort();

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
  const { loadProject, loadCalibration, projectFingerprint, nativeLayerSampler, neutralMotionState, renderProjectPoseWithSources } = engine;
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
  if (sourceMap.width !== project.canvas.width || sourceMap.height !== project.canvas.height) throw new Error('Export source canvas does not match the canonical project.');
  if (!model3.FileReferences?.Moc || !Array.isArray(model3.FileReferences.Textures) || !model3.FileReferences.Textures.length) throw new Error('model.model3.json is missing MOC or texture references.');
  const mocPath = safeExportPath(exportDir, model3.FileReferences.Moc);
  assertRecordedMocPath(exportStatus, exportDir, mocPath);
  const mocBytes = await readFile(mocPath), mocSha = sha256(mocBytes);

  const { poses, features } = buildPoses(project, new Set(Object.keys(exportStatus.parameterIds ?? {})));
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
  const samplers = new Map(project.layers.map((layer) => [layer.id, nativeLayerSampler(project, layer)]));
  const geometry = [], mappedPoses = [], failures = [];
  const maxima = { pixels: 0, opacity: 0, uv: 0, order: 0 };
  for (let pi = 0; pi < poses.length; pi++) {
    const pose = poses[pi], actualPose = readback.poses[pi], mappedLayers = [];
    const actualById = new Map(actualPose.layers.map((layer) => [layer.id, layer]));
    let matched = 0;
    for (const drawable of actualPose.layers) {
      const sourceId = coreIdToSourceId.get(drawable.id) ?? drawable.id;
      const input = inputLayers.get(drawable.id) ?? inputLayers.get(sourceId), source = sourceLayers.get(sourceId), sampler = samplers.get(sourceId);
      if (!input || !source || !sampler) continue;
      matched++;
      const expected = sampler(pose.parameters);
      const positions = drawable.positions.map((value, i) => i % 2 === 0 ? value * readback.canvas.pixelsPerUnit + readback.canvas.originX : readback.canvas.originY - value * readback.canvas.pixelsPerUnit);
      let pixelError = 0, uvError = 0;
      for (let i = 0; i < positions.length; i += 2) pixelError = Math.max(pixelError, Math.hypot(positions[i] - expected.positions[i], positions[i + 1] - expected.positions[i + 1]));
      for (let i = 0; i < drawable.uvs.length; i++) uvError = Math.max(uvError, Math.abs(drawable.uvs[i] - (i % 2 ? 1 - input.uvs[i] : input.uvs[i])));
      const opacityError = Math.abs(drawable.opacity - expected.opacity), orderError = Math.abs(drawable.drawOrder - expected.order);
      const topology = JSON.stringify(triangles(drawable.indices)) === JSON.stringify(triangles(input.triangles));
      if (drawable.textureIndex !== input.texture) failures.push({ pose: pose.id, layer: sourceId, reason: 'texture-index-mismatch' });
      if (pixelError > 0.55 || opacityError > 0.03 || uvError > 2e-6 || orderError > 1 || !topology) failures.push({ pose: pose.id, layer: sourceId, pixelError, opacityError, uvError, orderError, topology });
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
    const size = pose.id === 'head-1-1' ? 2048 : 768;
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
  const contacts = {};
  for (const background of ['white', '#242424']) {
    const label = background === 'white' ? 'white' : 'dark';
    const cell = 256, cols = 4, rows = Math.ceil(rendered.length / cols), comps = [];
    for (let i = 0; i < rendered.length; i++) {
      const png = await sharp(join(framesDir, rendered[i].filename)).flatten({ background }).resize(cell, cell, { fit: 'contain', background }).png().toBuffer();
      comps.push({ input: png, left: (i % cols) * cell, top: Math.floor(i / cols) * cell });
    }
    const path = join(output, `contact-${label}.png`);
    await sharp({ create: { width: cols * cell, height: rows * cell, channels: 4, background } }).composite(comps).png().toFile(path);
    contacts[label] = `contact-${label}.png`;
  }
  const report = {
    status: failures.length ? 'failed' : 'passed', verifier: 'VTuberTailor official Core readback + exported-atlas offline render',
    sourceRevision: calibration.revision, sourceFingerprint: fingerprint,
    project: projectDir, export: exportDir, output,
    core: { path: core, version: readback.coreVersion, latestMocVersion: readback.latestMocVersion, mocVersion: readback.mocVersion },
    moc: { path: relative(exportDir, mocPath), bytes: mocBytes.length, sha256: mocSha },
    exportMetadata: { model3Sha256: sha256(await readFile(model3Path)), sourceMapSha256: sha256(await readFile(sourceMapPath)), atlases: atlasFiles },
    parameterScale: exportStatus.parameterScale, features,
    poseCoverage: { total: poses.length, visualPoseIds: chosen.map((p) => p.id), geometryOnlyPoseIds: geometry.filter((p) => p.geometryOnly).map((p) => p.id), poses: geometry },
    thresholds: { positionPixels: 0.55, opacity: 0.03, uv: 2e-6, renderOrder: 1, meanPremultipliedImage: 1 },
    maxima, rendered, contacts, failures,
    rawCoreReadback: { path: 'core-poses-raw.json', sha256: sha256(rawBytes), bytes: rawBytes.length, freshThisRun: true },
    rendering: 'Frames use readback positions, UVs, indices, opacity, renderOrders from the supplied official Core DLL and textures referenced by model.model3.json. Images are offline renders, not VTube Studio screenshots.',
  };
  await writeJson(join(output, 'native-report.json'), report);
  console.log(JSON.stringify({ status: report.status, output, poses: poses.length, rendered: rendered.length, maxima, failures: failures.slice(0, 8) }, null, 2));
  if (failures.length) process.exitCode = 1;
}

function selectVisualPoses(poses) {
  const wanted = ['head-0-0', 'head-0-1', 'head-0-2', 'head-1-0', 'head-1-1', 'head-1-2', 'head-2-0', 'head-2-1', 'head-2-2', 'blink-1', 'head-center-blink-1', 'wink-left-only', 'wink-right-only', 'mixed-1'];
  const selected = wanted.map((id) => poses.find((pose) => pose.id === id)).filter(Boolean);
  const remaining = poses.filter((pose) => pose.visual && !selected.includes(pose));
  while (selected.length < Math.min(16, poses.filter((pose) => pose.visual).length) && remaining.length) selected.push(remaining.shift());
  return selected.slice(0, 16);
}
