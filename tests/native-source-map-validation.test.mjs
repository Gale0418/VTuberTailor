import test from 'node:test';
import assert from 'node:assert/strict';
import { validateNativeSourceMapParameters } from '../scripts/native/source-map-validation.mjs';

const project = {
  model: {
    parameters: [
      { id: 'Yaw', semantic: 'head-yaw', min: -1, default: 0, max: 1 },
      { id: 'Blink', semantic: 'blink', min: 0, default: 0, max: 1 },
    ],
  },
};

function fixture() {
  const parameterIds = { Yaw: 'ParamYaw', Blink: 'ParamBlink' };
  return {
    project: structuredClone(project),
    exportStatus: { parameterScale: 100, parameterIds: { ...parameterIds } },
    sourceMap: {
      version: 1,
      parameterScale: 100,
      parameterIds: { ...parameterIds },
      parameters: [
        { sourceId: 'Yaw', id: 'ParamYaw', min: -100, default: 0, max: 100 },
        { sourceId: 'Blink', id: 'ParamBlink', min: 0, default: 0, max: 100 },
      ],
      layers: [
        { id: 'DrawableFace', sourceId: 'face', axes: [{ sourceId: 'Yaw', id: 'ParamYaw', keys: [-100, 0, 100] }] },
        { id: 'DrawableEye', sourceId: 'eye', axes: [{ sourceId: 'Blink', id: 'ParamBlink', keys: [0, 50, 100] }] },
      ],
    },
  };
}

test('valid synthetic native source map parameter contract passes', () => {
  assert.deepEqual(validateNativeSourceMapParameters(fixture()), { ok: true, failures: [] });
});

test('rejects a missing or unsupported native source-map version', () => {
  for (const version of [undefined, 999]) {
    const input = fixture();
    input.sourceMap.version = version;
    assert.ok(validateNativeSourceMapParameters(input).failures.some((failure) => failure.reason === 'source-map-version-unsupported'));
  }
});

test('parameter mappings detect disagreement and missing entries', () => {
  const wrong = fixture();
  wrong.exportStatus.parameterIds.Yaw = 'ParamWrong';
  delete wrong.sourceMap.parameterIds.Blink;
  const result = validateNativeSourceMapParameters(wrong);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.reason === 'parameter-mapping-disagrees' && failure.sourceId === 'Yaw'));
  assert.ok(result.failures.some((failure) => failure.reason === 'parameter-mapping-missing' && failure.mapping === 'source-map' && failure.sourceId === 'Blink'));
});

test('source-map parameter values are checked against canonical values and scale', () => {
  const wrong = fixture();
  wrong.sourceMap.parameters[0].max = 99;
  wrong.sourceMap.parameters[1].default = Number.NaN;
  const result = validateNativeSourceMapParameters(wrong);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-parameter-value-disagrees' && failure.sourceId === 'Yaw' && failure.field === 'max'));
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-parameter-value-nonfinite' && failure.sourceId === 'Blink' && failure.field === 'default'));
  const zero = fixture();
  zero.exportStatus.parameterScale = 0;
  zero.sourceMap.parameterScale = 0;
  assert.ok(validateNativeSourceMapParameters(zero).failures.some((failure) => failure.reason === 'parameter-scale-invalid'));
});

test('each layer axis requires the source mapping, finite keys, and strict sorting', () => {
  const wrong = fixture();
  wrong.sourceMap.layers[0].axes[0].sourceId = 'Missing';
  wrong.sourceMap.layers[0].axes[0].id = 'ParamWrong';
  wrong.sourceMap.layers[0].axes[0].keys = [100, Number.POSITIVE_INFINITY, 0];
  wrong.sourceMap.layers[1].axes[0].keys = [0, 100, 50];
  const result = validateNativeSourceMapParameters(wrong);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-axis-source-id-unknown' && failure.sourceId === 'Missing'));
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-axis-id-disagrees' && failure.sourceId === 'Missing'));
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-axis-keys-nonfinite' && failure.layer === 'face'));
  assert.ok(result.failures.some((failure) => failure.reason === 'source-map-axis-keys-unsorted' && failure.layer === 'eye'));
});

test('accepts sorted supplemental keys emitted outside a narrow parameter range', () => {
  const input = fixture();
  // The exporter adds mouth transition knots unconditionally; a narrow
  // authoring range can therefore leave supplemental keys outside that range.
  input.sourceMap.layers[0].axes[0].keys = [-101, 0, 100];
  assert.deepEqual(validateNativeSourceMapParameters(input), { ok: true, failures: [] });
});
