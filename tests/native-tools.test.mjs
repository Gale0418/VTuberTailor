import test from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPoses } from '../scripts/native/poses.mjs';
import { engineModuleUrls } from '../scripts/native/engine-module-urls.mjs';

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
