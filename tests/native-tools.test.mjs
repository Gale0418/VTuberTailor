import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoses } from '../scripts/native/poses.mjs';
import { engineModuleUrls } from '../scripts/native/engine-module-urls.mjs';
import { assertRecordedMocPath } from '../scripts/native/export-paths.mjs';

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

test('independent wink cases are generated only when every required axis is available', () => {
  const project = {
    model: { parameters: [parameter('Blink', 'blink', 0, 0, 1), parameter('L', 'blink-left', 0, 0, 1), parameter('R', 'blink-right', 0, 0, 1)] },
    runtime: { features: { asymmetricBlink: true } },
  };
  const result = buildPoses(project);
  assert.deepEqual(result.poses.filter((pose) => pose.family === 'winks').map((pose) => pose.id), ['wink-left-only', 'wink-right-only']);
  assert.equal(result.poses.some((pose) => pose.visual), true);
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
