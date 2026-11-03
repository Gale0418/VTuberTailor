import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoses, selectVisualPoses } from '../scripts/native/poses.mjs';
import { engineModuleUrls } from '../scripts/native/engine-module-urls.mjs';
import { assertRecordedMocPath } from '../scripts/native/export-paths.mjs';
import { writeContactSheets } from '../scripts/native/contact-sheets.mjs';
import { nativeArtPositions } from '../vendor/puppetloom/packages/core/dist/cubism-native.js';
import {
  classifyNativeTriangleWinding,
  compareNativeScalar,
  compactNativePositions,
  deriveNativeVertexMapping,
  maxNativeArrayError,
  validateNativeDrawableMappings,
} from '../scripts/native/verify.mjs';

const require = createRequire(new URL('../vendor/puppetloom/package.json', import.meta.url));

test('recorded MOC paths remain valid when the export directory moves', () => {
  const oldRoot = resolve('old-export'), movedRoot = resolve('moved-export');
  assert.doesNotThrow(() => assertRecordedMocPath(
    { outputDirectory: oldRoot, moc3: join(oldRoot, 'model.moc3') }, movedRoot, join(movedRoot, 'model.moc3'),
  ));
  assert.doesNotThrow(() => assertRecordedMocPath(
    { outputDirectory: oldRoot, moc3: 'model.moc3' }, movedRoot, join(movedRoot, 'model.moc3'),
  ));
});

test('recorded MOC paths reject a different directory even when basenames match', () => {
  const root = resolve('export');
  assert.throws(() => assertRecordedMocPath(
    { outputDirectory: root, moc3: join(root, 'other', 'model.moc3') }, root, join(root, 'model.moc3'),
  ), /MOC path disagrees/);
  assert.throws(() => assertRecordedMocPath(
    { outputDirectory: root, moc3: '../model.moc3' }, root, join(root, 'model.moc3'),
  ), /MOC path disagrees/);
});

test('recorded MOC metadata rejects present empty or non-string paths', () => {
  const root = resolve('export'), moc = join(root, 'model.moc3');
  assert.doesNotThrow(() => assertRecordedMocPath({}, root, moc));
  for (const moc3 of [undefined, null, false, 0, '', {}, []]) {
    assert.throws(() => assertRecordedMocPath({ moc3 }, root, moc), /MOC path disagrees/);
  }
  for (const outputDirectory of [null, false, 0, '', {}, []]) {
    assert.throws(() => assertRecordedMocPath({ moc3: moc, outputDirectory }, root, moc), /MOC path disagrees/);
  }
});

test('recorded MOC path casing follows the host platform path contract', () => {
  const root = resolve('export');
  const check = () => assertRecordedMocPath(
    { outputDirectory: root, moc3: join(root, 'MODEL.moc3') }, root, join(root, 'model.moc3'),
  );
  if (process.platform === 'win32') assert.doesNotThrow(check);
  else assert.throws(check, /MOC path disagrees/);
});

test('recorded MOC paths keep case distinctions under the POSIX platform contract', () => {
  const root = resolve('export');
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  try {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    assert.throws(() => assertRecordedMocPath(
      { outputDirectory: root, moc3: join(root, 'MODEL.moc3') }, root, join(root, 'model.moc3'),
    ), /MOC path disagrees/);
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});

const parameter = (id, semantic, min, defaultValue, max) => ({ id, semantic, min, default: defaultValue, max });

test('native pose plan adapts to available axes and records optional winks', () => {
  const project = {
    model: { parameters: [parameter('Yaw', 'head-yaw', -30, 0, 20), parameter('Pitch', 'head-pitch', -10, 3, 25), parameter('Blink', 'blink', 0, 0, 1)] },
    runtime: { features: { asymmetricBlink: false } },
  };
  const result = buildPoses(project);
  assert.equal(result.poses.filter((pose) => pose.family === 'nine-way').length, 9);
  assert.equal(result.poses.some((pose) => pose.id.startsWith('wink-')), false);
  assert.deepEqual(result.features, {
    headYaw: true, headPitch: true, blink: true, blinkLeft: false, blinkRight: false, asymmetricBlink: false,
    availableParameters: [{ id: 'Yaw', semantic: 'head-yaw' }, { id: 'Pitch', semantic: 'head-pitch' }, { id: 'Blink', semantic: 'blink' }],
  });
  const extremes = result.poses.filter((pose) => pose.family === 'parameter-extremes');
  assert.deepEqual(extremes.slice(0, 3).map((pose) => Object.values(pose.parameters)[0]), [-30, 0, 20]);
  assert.ok(result.poses.some((pose) => pose.id === 'blink-1' && Object.values(pose.parameters)[0] === 0.5));
});

test('compact-aware verifier derives a non-prefix canonical vertex mapping', () => {
  const layer = {
    id: 'synthetic-eye',
    mesh: {
      points: Array.from({ length: 6 }, (_, index) => ({ x: index, y: -index })),
      triangles: [4, 2, 0, 0, 2, 4],
    },
  };
  const mapping = deriveNativeVertexMapping(layer, 3);
  assert.equal(mapping.compacted, true);
  assert.deepEqual(mapping.compactToOld, [0, 2, 4]);
  assert.deepEqual(mapping.oldToNew, [0, -1, 1, -1, 2, -1]);
  assert.deepEqual(mapping.remappedTriangles, [2, 1, 0, 0, 1, 2]);
  assert.deepEqual(compactNativePositions([0, 0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5], mapping.compactToOld), [0, 0, 2, -2, 4, -4]);
  assert.deepEqual(deriveNativeVertexMapping(layer, 6).compactToOld, [0, 1, 2, 3, 4, 5]);
});

test('compact-aware verifier preserves winding and rejects mixed Core winding', () => {
  const expected = [2, 1, 0, 0, 3, 2];
  assert.deepEqual(classifyNativeTriangleWinding(expected, expected), { ok: true, convention: 'direct' });
  assert.deepEqual(classifyNativeTriangleWinding([2, 0, 1, 0, 2, 3], expected), { ok: true, convention: 'reversed' });
  const mixed = classifyNativeTriangleWinding([2, 0, 1, 0, 3, 2], expected);
  assert.equal(mixed.ok, false);
  assert.equal(mixed.reason, 'mixed-triangle-winding');
  assert.equal(classifyNativeTriangleWinding(expected, expected, { allowGlobalReverse: false }).ok, true);
  assert.equal(classifyNativeTriangleWinding([2, 0, 1, 0, 2, 3], expected, { allowGlobalReverse: false }).ok, false);
  const symmetric = classifyNativeTriangleWinding([0, 1, 2, 2, 1, 0], [0, 1, 2, 2, 1, 0]);
  assert.deepEqual(symmetric, { ok: true, convention: 'symmetric' });
});

test('compact-aware verifier fails closed for bad mapping and non-finite geometry', () => {
  const layer = { id: 'synthetic', mesh: { points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }], triangles: [0, 1, 2] } };
  assert.throws(() => deriveNativeVertexMapping(layer, 2), /disagrees with canonical referenced vertex count/);
  assert.throws(() => compactNativePositions([0, Number.NaN, 1, 1], [0]), /finite array/);
  assert.throws(() => compactNativePositions([0, 0], [1]), /out of range/);
  assert.throws(() => compactNativePositions([0, 0, 1, 1], [0, 0]), /duplicate indices/);
  assert.deepEqual(compareNativeScalar(1, 1.25, 'opacity'), { ok: true, error: 0.25 });
  assert.deepEqual(compareNativeScalar(undefined, 0, 'opacity'), { ok: false, reason: 'opacity-missing-or-nonfinite', error: Number.POSITIVE_INFINITY });
  assert.deepEqual(compareNativeScalar(Number.NaN, 0, 'draw-order'), { ok: false, reason: 'draw-order-missing-or-nonfinite', error: Number.POSITIVE_INFINITY });
  assert.ok(maxNativeArrayError([10, 20, 30, 40], [10, 20, 30.0000001, 40], 'source-map') < 2e-7);
  assert.equal(maxNativeArrayError([10, 20], [10, 20, 30, 40], 'source-map'), Number.POSITIVE_INFINITY);
  assert.equal(classifyNativeTriangleWinding([0, 1, 2], [0, 1, 2, 0, 2, 1]).reason, 'triangle-length-mismatch');
});

test('source-map positions follow nativeArtPositions UV/bounds mapping, not neutral sampler output', () => {
  const project = { canvas: { width: 1000, height: 800 } };
  const layer = {
    bounds: { x: 0.1, y: 0.2, width: 0.4, height: 0.5 },
    mesh: { uvs: [{ x: 0, y: 0 }, { x: 0.5, y: 0.25 }, { x: 1, y: 1 }] },
  };
  assert.deepEqual(nativeArtPositions(project, layer).map((value, index) => Math.abs(value - [100, 160, 300, 260, 500, 560][index]) <= 1e-9), [true, true, true, true, true, true]);
});

test('native verifier rejects missing, unknown, duplicate, and disagreeing drawable mappings', () => {
  const projectLayers = [{ id: 'visible-a' }, { id: 'visible-b' }, { id: 'hidden', visible: false }];
  const valid = {
    projectLayers,
    exportStatus: { drawableIds: { 'visible-a': 'core-a', 'visible-b': 'core-b' } },
    sourceMap: {
      drawableIds: { 'visible-a': 'core-a', 'visible-b': 'core-b' },
      layers: [{ id: 'core-a', sourceId: 'visible-a', masks: [] }, { id: 'core-b', sourceId: 'visible-b', masks: [] }],
    },
  };
  assert.deepEqual(validateNativeDrawableMappings(valid), { ok: true, failures: [] });

  const missing = validateNativeDrawableMappings({
    ...valid,
    exportStatus: { drawableIds: { 'visible-a': 'core-a' } },
    sourceMap: { ...valid.sourceMap, drawableIds: { 'visible-a': 'core-a' }, layers: [{ id: 'core-a', sourceId: 'visible-a' }] },
  });
  assert.ok(missing.failures.some((failure) => failure.reason === 'drawable-map-missing' && failure.sourceId === 'visible-b'));

  const duplicate = validateNativeDrawableMappings({
    ...valid,
    exportStatus: { drawableIds: { 'visible-a': 'core-a', 'visible-b': 'core-a' } },
  });
  assert.ok(duplicate.failures.some((failure) => failure.reason === 'drawable-map-core-id-duplicate' && failure.mapping === 'export-status'));

  const unknown = validateNativeDrawableMappings({
    ...valid,
    sourceMap: { ...valid.sourceMap, drawableIds: { ...valid.sourceMap.drawableIds, unknown: 'core-x' }, layers: [...valid.sourceMap.layers, { id: 'core-x', sourceId: 'unknown' }] },
  });
  assert.ok(unknown.failures.some((failure) => failure.reason === 'drawable-map-unexpected-source' && failure.sourceId === 'unknown'));

  const disagrees = validateNativeDrawableMappings({
    ...valid,
    sourceMap: { ...valid.sourceMap, drawableIds: { ...valid.sourceMap.drawableIds, 'visible-a': 'core-other' }, layers: [{ id: 'core-other', sourceId: 'visible-a' }, valid.sourceMap.layers[1]] },
  });
  assert.ok(disagrees.failures.some((failure) => failure.reason === 'drawable-map-disagrees' && failure.sourceId === 'visible-a'));
});

test('native verifier rejects duplicate or missing visible IDs and enforces canonical clip masks', () => {
  const base = {
    projectLayers: [{ id: 'visible-a' }, { id: 'visible-b', clipLayerId: 'visible-a' }, { id: 'hidden', visible: false }],
    exportStatus: { drawableIds: { 'visible-a': 'core-a', 'visible-b': 'core-b' } },
    sourceMap: {
      drawableIds: { 'visible-a': 'core-a', 'visible-b': 'core-b' },
      layers: [{ id: 'core-a', sourceId: 'visible-a', masks: [] }, { id: 'core-b', sourceId: 'visible-b', masks: ['core-a'] }],
    },
  };
  assert.equal(validateNativeDrawableMappings(base).ok, true, 'normal no-mask layer and canonical clip mask should pass');

  const duplicateVisible = validateNativeDrawableMappings({ ...base, projectLayers: [{ id: 'visible-a' }, { id: 'visible-a' }, base.projectLayers[1]] });
  assert.ok(duplicateVisible.failures.some((failure) => failure.reason === 'canonical-visible-id-duplicate' && failure.sourceId === 'visible-a'));

  const missingVisible = validateNativeDrawableMappings({ ...base, projectLayers: [{ id: 'visible-a' }, {}, base.projectLayers[1]] });
  assert.ok(missingVisible.failures.some((failure) => failure.reason === 'canonical-visible-id-missing'));

  const hiddenMaskTarget = validateNativeDrawableMappings({ ...base, projectLayers: [{ id: 'visible-a', visible: false }, base.projectLayers[1]] });
  assert.ok(hiddenMaskTarget.failures.some((failure) => failure.reason === 'canonical-mask-target-not-visible' && failure.clipLayerId === 'visible-a'));

  const wrongMasks = validateNativeDrawableMappings({ ...base, sourceMap: { ...base.sourceMap, layers: [{ id: 'core-a', sourceId: 'visible-a', masks: ['core-b'] }, base.sourceMap.layers[1]] } });
  assert.ok(wrongMasks.failures.some((failure) => failure.reason === 'source-map-masks-disagree' && failure.sourceId === 'visible-a'));

  const unknownMask = validateNativeDrawableMappings({ ...base, sourceMap: { ...base.sourceMap, layers: [{ id: 'core-a', sourceId: 'visible-a', masks: ['core-unknown'] }, base.sourceMap.layers[1]] } });
  assert.ok(unknownMask.failures.some((failure) => failure.reason === 'source-map-mask-unknown' && failure.sourceId === 'visible-a'));
});

test('compact-aware verifier handles the dense r69 orphan fixture', () => {
  const points = Array.from({ length: 1069 }, (_, index) => ({ x: index, y: index }));
  const triangles = [];
  for (let index = 0; index < 69; index += 3) triangles.push(index, index + 1, index + 2);
  triangles.push(69, 70, 0);
  for (let index = triangles.length / 3; index < 110; index += 1) triangles.push(index % 71, (index * 7 + 1) % 71, (index * 13 + 2) % 71);
  const mapping = deriveNativeVertexMapping({ id: 'r69-eye-underlay', mesh: { points, triangles } }, 71);
  assert.equal(mapping.compactToOld.length, 71);
  assert.equal(points.length - mapping.compactToOld.length, 998);
  assert.equal(mapping.remappedTriangles.length, triangles.length);
  assert.ok(mapping.remappedTriangles.every((index) => index >= 0 && index < 71));
});

test('independent wink cases are generated only when every required axis is available', () => {
  const project = {
    model: { parameters: [parameter('Blink', 'blink', 0, 0, 1), parameter('L', 'blink-left', 0, 0, 1), parameter('R', 'blink-right', 0, 0, 1)] },
    runtime: { features: { asymmetricBlink: true } },
  };
  const result = buildPoses(project);
  assert.deepEqual(result.poses.filter((pose) => pose.family === 'winks').map((pose) => pose.id), ['wink-left-only', 'wink-right-only']);
  assert.equal(result.poses.some((pose) => pose.visual), true);
});

test('yaw-blink cases use asymmetric closed endpoints and remain uniquely selected', () => {
  const project = {
    model: {
      parameters: [
        parameter('Yaw', 'head-yaw', -1, 0, 1), parameter('Pitch', 'head-pitch', -1, 0, 1),
        parameter('Blink', 'blink', -1, 0.25, 0.5), parameter('L', 'blink-left', 0, 0.7, 1), parameter('R', 'blink-right', 0, 0.8, 1),
      ],
    },
    runtime: { features: { asymmetricBlink: true } },
  };
  const result = buildPoses(project);
  const yawBlink = result.poses.filter((pose) => pose.family === 'yaw-blink');
  assert.equal(yawBlink.length, 6);
  assert.equal(new Set(result.poses.map((pose) => pose.id)).size, result.poses.length);
  assert.deepEqual(yawBlink.map((pose) => pose.parameters), [
    { Yaw: -1, Pitch: 0, Blink: 0.25, L: 0, R: 0 },
    { Yaw: -1, Pitch: 0, Blink: 0.25, L: 0, R: 0.8 },
    { Yaw: -1, Pitch: 0, Blink: 0.25, L: 0.7, R: 0 },
    { Yaw: 1, Pitch: 0, Blink: 0.25, L: 0, R: 0 },
    { Yaw: 1, Pitch: 0, Blink: 0.25, L: 0, R: 0.8 },
    { Yaw: 1, Pitch: 0, Blink: 0.25, L: 0.7, R: 0 },
  ]);
  const selected = selectVisualPoses(result.poses);
  assert.equal(selected.length, 29);
  assert.equal(selected.filter((pose) => pose.family === 'yaw-blink').length, 6);
  assert.equal(selected.filter((pose) => pose.family === 'mixed').length, 8);
  assert.deepEqual(
    selected.filter((pose) => pose.family !== 'yaw-blink').map((pose) => pose.id),
    selectVisualPoses(result.poses.filter((pose) => pose.family !== 'yaw-blink')).map((pose) => pose.id),
    'cross-pose coverage must not displace the original visual poses',
  );
  assert.ok(selected.some((pose) => pose.id === 'yaw-blink--1-both-closed'));
  assert.ok(selected.some((pose) => pose.id === 'yaw-blink-1-right-closed'));
});

test('yaw-blink uses global closed endpoint and feature/mapping gating', () => {
  const project = {
    model: { parameters: [parameter('Yaw', 'head-yaw', -2, 0, 3), parameter('Pitch', 'head-pitch', -7, 3, 9), parameter('Blink', 'blink', -1, 0.2, 0.5), parameter('L', 'blink-left', 0, 0, 1), parameter('R', 'blink-right', 0, 0, 1)] },
    runtime: { features: { asymmetricBlink: true } },
  };
  const globalOnly = buildPoses(project, new Set(['Yaw', 'Pitch', 'Blink']));
  const yawBlink = globalOnly.poses.filter((pose) => pose.family === 'yaw-blink');
  assert.deepEqual(yawBlink.map((pose) => pose.parameters), [
    { Yaw: -2, Pitch: 3, Blink: -1 },
    { Yaw: 3, Pitch: 3, Blink: -1 },
  ]);
  assert.equal(globalOnly.features.asymmetricBlink, false);
  const gated = buildPoses({ ...project, runtime: { features: { asymmetricBlink: false } } });
  assert.equal(gated.poses.filter((pose) => pose.family === 'yaw-blink').length, 2);
});

test('combined head coverage retains every three-axis corner with open and closed eyes', () => {
  const project = {
    model: { parameters: [
      parameter('Yaw', 'head-yaw', -2, 0, 3), parameter('Pitch', 'head-pitch', -7, 3, 9),
      parameter('Roll', 'head-roll', -4, 1, 6), parameter('Blink', 'blink', -1, 0.2, 0.5),
      parameter('L', 'blink-left', 0, 0.8, 1), parameter('R', 'blink-right', 0, 0.7, 1),
    ] },
    runtime: { features: { asymmetricBlink: true } },
  };
  const result = buildPoses(project), combined = result.poses.filter(pose => pose.family === 'head-combined');
  assert.equal(combined.length, 16);
  assert.equal(new Set(result.poses.map(pose => pose.id)).size, result.poses.length);
  const corners = new Set();
  for (const pose of combined) {
    const p = pose.parameters;
    assert.ok([-2, 3].includes(p.Yaw) && [-7, 9].includes(p.Pitch) && [-4, 6].includes(p.Roll));
    corners.add([p.Yaw, p.Pitch, p.Roll].join(','));
    assert.equal(p.Blink, 0.2);
    assert.deepEqual([p.L, p.R], pose.id.endsWith('-open') ? [0.8, 0.7] : [0, 0]);
  }
  assert.equal(corners.size, 8);
  const selected = selectVisualPoses(result.poses);
  assert.equal(selected.length, 74);
  assert.equal(selected.filter(pose => pose.family === 'head-combined').length, 16);
  assert.equal(selected.filter(pose => pose.family === 'mixed').length, 8);
  const baselineFamilies = new Set(['head-combined', 'head-grid']);
  assert.deepEqual(selected.filter(pose => !baselineFamilies.has(pose.family)).map(pose => pose.id),
    selectVisualPoses(result.poses.filter(pose => !baselineFamilies.has(pose.family))).map(pose => pose.id));
  const missingRoll = buildPoses(project, new Set(['Yaw', 'Pitch', 'Blink', 'L', 'R']));
  assert.equal(missingRoll.poses.some(pose => pose.family === 'head-combined'), false);
});

test('combined head coverage works with a global blink or without an eye axis', () => {
  const head = [parameter('X', 'head-yaw', -1, 0, 1), parameter('Y', 'head-pitch', -1, 0, 1), parameter('Z', 'head-roll', -1, 0, 1)];
  const project = { model: { parameters: [...head, parameter('B', 'blink', -1, 0.2, 0.5)] }, runtime: { features: { asymmetricBlink: false } } };
  const combined = buildPoses(project).poses.filter(pose => pose.family === 'head-combined');
  assert.equal(combined.length, 16);
  assert.ok(combined.filter(pose => pose.id.endsWith('-closed')).every(pose => pose.parameters.B === -1));
  const withoutEyes = buildPoses({ model: { parameters: head } }).poses.filter(pose => pose.family === 'head-combined');
  assert.equal(withoutEyes.length, 8);
  assert.ok(withoutEyes.every(pose => Object.keys(pose.parameters).length === 3));
});

test('head grid covers all 27 joint states with both eye states without duplicating the nine-way plane', () => {
  const project = {
    model: { parameters: [
      parameter('X', 'head-yaw', -1, 0, 1), parameter('Y', 'head-pitch', -2, 0.5, 3),
      parameter('Z', 'head-roll', -4, 1, 6), parameter('B', 'blink', 0, 0, 1),
    ] }, runtime: { features: { asymmetricBlink: false } },
  };
  const result = buildPoses(project);
  const head = result.poses.filter(pose => ['nine-way', 'head-combined', 'head-grid'].includes(pose.family));
  const signatures = head.map(pose => {
    const p = pose.parameters;
    return [p.X ?? 0, p.Y ?? 0.5, p.Z ?? 1, p.B ?? 0].join(',');
  });
  assert.equal(head.length, 54);
  assert.equal(new Set(signatures).size, 54);
  const grid = result.poses.filter(pose => pose.family === 'head-grid');
  assert.equal(grid.length, 29);
  const selected = new Set(selectVisualPoses(result.poses).map(pose => pose.id));
  assert.ok(head.every(pose => selected.has(pose.id)));
  assert.equal(buildPoses(project, new Set(['X', 'Y', 'B'])).poses.some(pose => pose.family === 'head-grid'), false);
});

test('engine dist import specifiers are file URLs that round-trip Windows drive paths', () => {
  const engineRoot = resolve('D:\\VTuberTailor fixture path\\vendor\\puppetloom');
  const urls = engineModuleUrls(engineRoot, './dist/index.js');
  const coreRoot = resolve(engineRoot, 'packages', 'core');
  const expected = {
    entry: resolve(coreRoot, 'dist', 'index.js'),
    projectStore: resolve(coreRoot, 'dist', 'project-store.js'),
    calibrationStore: resolve(coreRoot, 'dist', 'calibration-store.js'),
  };
  for (const [key, url] of Object.entries(urls)) {
    assert.equal(new URL(url).protocol, 'file:');
    assert.equal(fileURLToPath(url).toLowerCase(), expected[key].toLowerCase());
  }
  assert.match(urls.entry, /^file:\/\//);
});

test('native contact sheets preserve alpha semantics for white, dark, and green backgrounds', async (t) => {
  const sharp = require('sharp');
  const root = await mkdtemp(join(tmpdir(), 'vtuber-tailor-contact-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const framesDir = join(root, 'frames'), output = join(root, 'output');
  await mkdir(framesDir);
  await mkdir(output);
  const framePath = join(framesDir, 'synthetic.png');
  const pixels = Buffer.from([
    0, 0, 0, 0,       0, 0, 0, 0,       255, 0, 0, 255,     255, 0, 0, 255,
    0, 0, 0, 0,       0, 0, 0, 0,       255, 0, 0, 255,     255, 0, 0, 255,
    0, 0, 255, 255,   0, 0, 255, 255,   12, 34, 56, 255,    12, 34, 56, 255,
    0, 0, 255, 255,   0, 0, 255, 255,   12, 34, 56, 255,    12, 34, 56, 255,
  ]);
  await sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toFile(framePath);
  const before = await readFile(framePath);
  const contacts = await writeContactSheets({ sharp, framesDir, rendered: [{ filename: 'synthetic.png' }], output });
  assert.deepEqual(contacts, { white: 'contact-white.png', dark: 'contact-dark.png', green: 'contact-green.png' });
  assert.deepEqual(await readFile(framePath), before, 'source PNG bytes must remain unchanged');

  const sample = async (label, x, y) => {
    const path = join(output, contacts[label]);
    const image = await sharp(path).raw().toBuffer({ resolveWithObject: true });
    const offset = (y * image.info.width + x) * image.info.channels;
    return [...image.data.subarray(offset, offset + 4)];
  };
  assert.deepEqual(await sample('green', 32, 32), [0, 255, 0, 255]);
  assert.deepEqual(await sample('green', 160, 32), [255, 0, 0, 255]);
  assert.deepEqual(await sample('white', 32, 32), [255, 255, 255, 255]);
  assert.deepEqual(await sample('dark', 32, 32), [36, 36, 36, 255]);
  assert.deepEqual(await sample('white', 160, 32), [255, 0, 0, 255]);
  assert.deepEqual(await sample('dark', 160, 32), [255, 0, 0, 255]);
  assert.deepEqual(await sample('green', 32, 160), [0, 0, 255, 255]);
  assert.deepEqual(await sample('green', 160, 160), [12, 34, 56, 255]);
});
