import test from 'node:test';
import assert from 'node:assert/strict';
import { activeNativeAxes, buildPoses } from '../scripts/native/poses.mjs';

const parameter = (id, semantic, min, defaultValue, max) => ({ id, semantic, min, default: defaultValue, max });
const project = {
  model: { parameters: [
    parameter('Yaw', 'head-yaw', -1, 0, 1), parameter('Pitch', 'head-pitch', -1, 0, 1),
    parameter('Blink', 'blink', 0, 0, 1), parameter('L', 'blink-left', 0, 0, 1), parameter('R', 'blink-right', -1, 0, 0),
  ] },
  runtime: { features: { asymmetricBlink: true } },
};

test('native bilateral blink poses drive both side channels across their own ranges', () => {
  const poses = buildPoses(project).poses;
  assert.deepEqual(poses.find((pose) => pose.id === 'blink-0').parameters, { Blink: 0, L: 0, R: 0 });
  assert.deepEqual(poses.find((pose) => pose.id === 'blink-1').parameters, { Blink: 0, L: 0.5, R: -0.5 });
  assert.deepEqual(poses.find((pose) => pose.id === 'blink-2').parameters, { Blink: 0, L: 1, R: -1 });
  assert.deepEqual(poses.find((pose) => pose.id === 'head-center-blink-1').parameters, { Yaw: 0, Pitch: 0, Blink: 0, L: 1, R: -1 });
});

test('native blink poses fall back to the global channel if side channels are unavailable', () => {
  const poses = buildPoses(project, new Set(['Yaw', 'Pitch', 'Blink'])).poses;
  assert.deepEqual(poses.find((pose) => pose.id === 'blink-1').parameters, { Blink: 0.5 });
  assert.deepEqual(poses.find((pose) => pose.id === 'blink-2').parameters, { Blink: 1 });
});

test('explicitly disabled blink emits no blink combinations while preserving legacy omission behavior', () => {
  const withRoll = { ...project, model: { parameters: [...project.model.parameters, parameter('Roll', 'head-roll', -1, 0, 1)] } };
  const disabled = buildPoses({ ...withRoll, runtime: { features: { blink: false, asymmetricBlink: true } } });
  assert.deepEqual(disabled.features, {
    headYaw: true, headPitch: true, blink: false, blinkLeft: false, blinkRight: false, asymmetricBlink: false,
    availableParameters: withRoll.model.parameters.map(({ id, semantic }) => ({ id, semantic })),
  });
  assert.equal(disabled.poses.some((pose) => ['blink', 'nine-way-blink', 'yaw-blink', 'winks'].includes(pose.family)), false);
  const combined = disabled.poses.filter((pose) => pose.family === 'head-combined');
  assert.equal(combined.length, 8);
  assert.ok(combined.every((pose) => Object.keys(pose.parameters).sort().join(',') === 'Pitch,Roll,Yaw'));
  assert.equal(buildPoses(withRoll).features.blink, true, 'an omitted flag keeps legacy parameter-driven blink support');
});

test('native poses use exported axes, not just parameter-table entries', () => {
  const mapped = new Set(['Yaw', 'Pitch', 'Blink', 'L', 'R']);
  const withBlink = { ...project, layers: [{ id: 'eye', role: 'eyeWhite', side: 'center' }, { id: 'mouth', role: 'mouth', side: 'center' }], runtime: { features: { asymmetricBlink: true, blink: true } } };
  const axes = activeNativeAxes({ layers: [
    { sourceId: 'eye', axes: [{ sourceId: 'Blink' }] },
    { sourceId: 'mouth', axes: [{ sourceId: 'L' }, { sourceId: 'R' }] },
  ] }, withBlink);
  const result = buildPoses(withBlink, mapped, axes);
  assert.equal(result.features.asymmetricBlink, false);
  assert.deepEqual(result.poses.find((pose) => pose.id === 'blink-2').parameters, { Blink: 1 });
  assert.throws(() => buildPoses(withBlink, mapped, new Set(['L'])), /neither the global axis nor both side axes/);
  assert.throws(() => buildPoses(withBlink, new Set(['L', 'R']), new Set(['L', 'R'])), /requires a mapped global blink/);
  assert.throws(() => activeNativeAxes({ layers: [{ axes: [{ id: 'L' }] }] }, withBlink), /sourceId is missing/);
  const sideAxes = activeNativeAxes({ layers: [{ sourceId: 'eye', axes: [{ sourceId: 'L' }, { sourceId: 'R' }] }] }, withBlink);
  assert.equal(buildPoses(withBlink, mapped, sideAxes).features.asymmetricBlink, true);
  const oneEyeProject = { ...withBlink, layers: [{ id: 'left-eye', role: 'eyeWhite', side: 'left' }] };
  const wrongSideAxes = activeNativeAxes({ layers: [{ sourceId: 'left-eye', axes: [{ sourceId: 'L' }, { sourceId: 'R' }] }] }, oneEyeProject);
  assert.deepEqual([...wrongSideAxes], ['L']);
});

test('bilateral changes preserve wink and head-corner coverage', () => {
  const withRoll = { ...project, model: { parameters: [...project.model.parameters, parameter('Roll', 'head-roll', -1, 0, 1)] } };
  const poses = buildPoses(withRoll).poses;
  assert.equal(new Set(poses.map((pose) => pose.id)).size, poses.length);
  assert.equal(poses.filter((pose) => pose.family === 'winks').length, 2);
  const corners = poses.filter((pose) => pose.family === 'head-combined');
  assert.equal(corners.length, 16);
  assert.equal(new Set(corners.map(({ parameters: p }) => [p.Yaw, p.Pitch, p.Roll].join(','))).size, 8);
  assert.ok(corners.filter((pose) => pose.id.endsWith('-closed')).every(({ parameters: p }) => p.L === 1 && p.R === -1));
});
