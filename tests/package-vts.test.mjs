import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packageVts } from '../scripts/package_vts.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'vtstailor-package-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const exp = join(root, 'export');
  await mkdir(exp, { recursive: true });
  const assets = {
    'model.moc3': 'SYNTHETIC MOC HEADER; NOT A REAL MODEL',
    'textures/texture_00.png': 'synthetic texture bytes',
    'physics/physics3.json': '{}',
    'pose/pose3.json': '{}',
    'display/displayInfo.json': '{}',
    'userdata/userData3.json': '{}',
    'expressions/smile.exp3.json': '{}',
    'motions/idle.motion3.json': '{}',
  };
  for (const [name, value] of Object.entries(assets)) {
    const path = join(exp, name);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(path, value);
  }
  const model = {
    Version: 3,
    FileReferences: {
      Moc: 'model.moc3', Textures: ['textures/texture_00.png'],
      Physics: 'physics/physics3.json', Pose: 'pose/pose3.json',
      DisplayInfo: 'display/displayInfo.json', UserData: 'userdata/userData3.json',
      Expressions: [{ Name: 'smile', File: 'expressions/smile.exp3.json' }],
      Motions: { Idle: [{ File: 'motions/idle.motion3.json' }] },
    },
  };
  await writeFile(join(exp, 'model.model3.json'), JSON.stringify(model));
  const fingerprint = 'export-fingerprint-fixture-123';
  await writeFile(join(exp, 'export-status.json'), JSON.stringify({
    sourceRevision: 17,
    sourceFingerprint: fingerprint,
    parameterIds: { angleX: 'ParamAngleX', eyeLeftOpen: 'ParamEyeLOpen' },
  }));
  const preset = {
    Version: 3,
    Name: 'Existing user name',
    ModelID: 'old-model-id',
    FileReferences: { Model: 'old.model3.json', Icon: 'old-icon.png', IdleAnimation: 'previous.motion3.json', IdleAnimationWhenTrackingLost: 'previous-lost.motion3.json' },
    ParameterSettings: [{ Input: 'FaceAngleX', Output: 'ParamAngleX', OutputLive2D: 'ParamAngleX', Multiplier: 1.25 }],
    Hotkeys: [{ Name: 'wave', KeyCombination: [1], Function: 'ToggleExpression', ExpressionFile: 'wave.exp3.json' }],
    ModelPosition: { PositionX: 15, PositionY: -8, Size: 0.72 },
    ModelScale: 1.17,
    Camera: { KeepThisUserField: true },
    SecuritySettings: { Keep: 'as-is' },
  };
  const presetPath = join(root, 'model.vtube.json');
  await writeFile(presetPath, `\uFEFF${JSON.stringify(preset)}`);
  const qaPath = join(root, 'native-qa.json');
  await writeFile(qaPath, JSON.stringify({ status: 'passed', sourceFingerprint: fingerprint, reportType: 'native' }));
  return { root, exp, presetPath, preset, qaPath, fingerprint, model };
}

const baseOptions = (f, output) => ({ '--export': f.exp, '--output': output, '--name': 'New model', '--preset': f.presetPath });

test('optional preset assets never reference uncopied files', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'runtime');
  await packageVts(baseOptions(f, output));
  const preset = JSON.parse(await readFile(join(output, 'model.vtube.json'), 'utf8'));
  for (const key of ['Icon', 'IdleAnimation', 'IdleAnimationWhenTrackingLost']) {
    assert.equal(preset.FileReferences[key], '', key);
  }
});

test('copies every nested FileReferences dependency and preserves preset settings', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'runtime');
  const receipt = await packageVts({ ...baseOptions(f, output), '--qa-report': f.qaPath });
  for (const ref of [
    'model.moc3', 'textures/texture_00.png', 'physics/physics3.json', 'pose/pose3.json',
    'display/displayInfo.json', 'userdata/userData3.json', 'expressions/smile.exp3.json', 'motions/idle.motion3.json',
  ]) await readFile(join(output, ref));
  const preset = JSON.parse(await readFile(join(output, 'model.vtube.json'), 'utf8'));
  assert.equal(preset.Name, 'New model');
  assert.notEqual(preset.ModelID, f.preset.ModelID);
  assert.equal(preset.FileReferences.Model, 'model.model3.json');
  assert.equal(preset.FileReferences.Icon, '');
  assert.equal(preset.FileReferences.IdleAnimation, '');
  assert.deepEqual(preset.ParameterSettings, f.preset.ParameterSettings);
  assert.deepEqual(preset.Hotkeys, f.preset.Hotkeys);
  assert.deepEqual(preset.ModelPosition, f.preset.ModelPosition);
  assert.deepEqual(preset.Camera, f.preset.Camera);
  assert.deepEqual(preset.SecuritySettings, f.preset.SecuritySettings);
  assert.equal(receipt.sourceFingerprint, f.fingerprint);
  assert.equal(receipt.sourceRevision, 17);
  assert.equal(receipt.qa.matchedFingerprint, true);
  assert.ok(receipt.runtimeFiles.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)));
});

test('rejects path traversal in a runtime reference', async (t) => {
  const f = await fixture(t);
  const model = { ...f.model, FileReferences: { ...f.model.FileReferences, Physics: '../outside.json' } };
  await writeFile(join(f.exp, 'model.model3.json'), JSON.stringify(model));
  await assert.rejects(packageVts(baseOptions(f, join(f.root, 'runtime'))), /escapes export directory/);
});

test('refuses to overwrite an existing output directory', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'runtime');
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'keep');
  await assert.rejects(packageVts(baseOptions(f, output)), /refusing to overwrite/);
  assert.equal(await readFile(join(output, 'keep.txt'), 'utf8'), 'keep');
});

test('rejects QA whose fingerprint does not match the export', async (t) => {
  const f = await fixture(t);
  const mismatchPath = join(f.root, 'mismatch.json');
  await writeFile(mismatchPath, JSON.stringify({ status: 'passed', sourceFingerprint: 'another-export' }));
  await assert.rejects(packageVts({ ...baseOptions(f, join(f.root, 'runtime')), '--qa-report': mismatchPath }), /exactly match/);
});

test('rejects a QA report directory with a clear JSON-file error', async (t) => {
  const f = await fixture(t);
  const reportDirectory = join(f.root, 'native-report');
  await mkdir(reportDirectory);
  await assert.rejects(
    packageVts({ ...baseOptions(f, join(f.root, 'runtime')), '--qa-report': reportDirectory }),
    /--qa-report must be a JSON file \(for example \.\.\.\/native-report\.json\), not a directory/,
  );
});

test('a package without preset records that tracking mappings are not configured', async (t) => {
  const f = await fixture(t);
  const output = join(f.root, 'runtime');
  const { '--preset': _preset, ...options } = baseOptions(f, output);
  const receipt = await packageVts(options);
  assert.equal(receipt.trackingMappingStatus, 'not-configured');
  assert.equal(receipt.trackingMappingsConfigured, false);
});

test('validates supplied idle motion loop, metadata, and parameter ids', async (t) => {
  const f = await fixture(t);
  const motionPath = join(f.root, 'candidate.motion3.json');
  await writeFile(motionPath, JSON.stringify({
    Meta: { Duration: 2, Fps: 30, Loop: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 },
    Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 1] }],
  }));
  const output = join(f.root, 'runtime');
  await packageVts({ ...baseOptions(f, output), '--idle': motionPath });
  const model = JSON.parse(await readFile(join(output, 'model.model3.json'), 'utf8'));
  const preset = JSON.parse(await readFile(join(output, 'model.vtube.json'), 'utf8'));
  assert.equal(Object.hasOwn(model, 'Parameters'), false, 'standard model3 must not be rewritten with a custom Parameters field');
  assert.equal(model.FileReferences.Motions.Idle[0].File, 'motions/idle.motion3.json');
  assert.equal(preset.FileReferences.IdleAnimation, 'idle.motion3.json');
});

test('rejects an idle curve ID absent from trusted export metadata', async (t) => {
  const f = await fixture(t);
  const motionPath = join(f.root, 'unknown-parameter.motion3.json');
  await writeFile(motionPath, JSON.stringify({
    Meta: { Duration: 2, Fps: 30, Loop: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 },
    Curves: [{ Target: 'Parameter', Id: 'ParamInvented', Segments: [0, 0, 0, 1, 1] }],
  }));
  await assert.rejects(
    packageVts({ ...baseOptions(f, join(f.root, 'runtime')), '--idle': motionPath }),
    /Motion references unknown parameter ParamInvented/,
  );
});

test('supplied optional assets all resolve inside the new package', async (t) => {
  const f = await fixture(t);
  const icon = join(f.root, 'provided.png'), motion = join(f.root, 'provided.motion3.json');
  await writeFile(icon, 'synthetic icon bytes');
  await writeFile(motion, JSON.stringify({
    Meta: { Duration: 2, Fps: 30, Loop: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 },
    Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 1] }],
  }));
  const output = join(f.root, 'runtime');
  await packageVts({ ...baseOptions(f, output), '--icon': icon, '--idle': motion, '--idle-lost': motion });
  const preset = JSON.parse(await readFile(join(output, 'model.vtube.json'), 'utf8'));
  for (const key of ['Icon', 'IdleAnimation', 'IdleAnimationWhenTrackingLost']) {
    assert.ok(preset.FileReferences[key]);
    await readFile(join(output, preset.FileReferences[key]));
  }
});

test('reports when motion parameter validation metadata is missing', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.exp, 'export-status.json'), JSON.stringify({ sourceRevision: 17, sourceFingerprint: f.fingerprint }));
  const motionPath = join(f.root, 'motion-without-id-metadata.motion3.json');
  await writeFile(motionPath, JSON.stringify({
    Meta: { Duration: 2, Fps: 30, Loop: true, CurveCount: 1, TotalSegmentCount: 1, TotalPointCount: 2 },
    Curves: [{ Target: 'Parameter', Id: 'ParamAngleX', Segments: [0, 0, 0, 1, 1] }],
  }));
  await assert.rejects(
    packageVts({ ...baseOptions(f, join(f.root, 'runtime')), '--idle': motionPath }),
    /export-status\.json\.parameterIds or referenced CDI3 Parameters\[\]\.Id metadata is required/,
  );
});
