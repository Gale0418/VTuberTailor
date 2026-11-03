'use strict';

// Synthetic fixtures only. No PSD, model, VTS, or character asset is read.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const KeyformStore = require('../lib/keyform-store.js');

const mesh = (shift) => [[shift, 0], [1 + shift, 0], [shift, 1], [1 + shift, 1]];
const manifest = (id = 'face') => ({ layerId: id, nx: 1, ny: 1, vertexCount: 4,
  indicesFingerprint: 'indices-v1-face', vertexOrderFingerprint: 'vertices-v1-face' });
const fixture = () => ({ version: 1, modelId: 'synthetic-model', layers: [
  { ...manifest('face'), keyforms: [{ yaw: -1, vertices: mesh(-0.25) }, { yaw: 1, vertices: mesh(0.25) }] },
  { ...manifest('hair'), indicesFingerprint: 'indices-v1-hair', vertexOrderFingerprint: 'vertices-v1-hair' }
] });

const store = KeyformStore.createKeyformStore(fixture(), { expectedLayers: [manifest(),
  { ...manifest('hair'), indicesFingerprint: 'indices-v1-hair', vertexOrderFingerprint: 'vertices-v1-hair' }] });
assert.equal(store.version, 1);
assert.equal(store.modelId, 'synthetic-model');
assert.deepEqual(store.getKeyform('face', -1).vertices, mesh(-0.25));
assert.equal(store.hasKeyform('face', 0), false);
assert.equal(store.getKeyform('hair', 0), null);
assert.deepEqual(store.getKeyformOrIdentity('hair', 0), { type: 'identity', modelId: 'synthetic-model', layerId: 'hair', yaw: 0 });
assert.ok(Object.isFrozen(store));
assert.ok(Object.isFrozen(store.layers[0].keyforms[0].vertices));

// Caller-owned input cannot mutate the stored fixture; vertex order is kept verbatim.
const original = fixture();
const isolated = KeyformStore.createKeyformStore(original);
original.layers[0].keyforms[0].vertices[0][0] = 99;
assert.equal(isolated.getKeyform('face', -1).vertices[0][0], -0.25);

// Browser-script UMD export is present and uses the same synthetic fixture.
const browserRoot = {};
vm.runInNewContext(fs.readFileSync(require.resolve('../lib/keyform-store.js'), 'utf8'), { self: browserRoot });
assert.equal(typeof browserRoot.KeyformStore.createKeyformStore, 'function');
assert.equal(browserRoot.KeyformStore.createKeyformStore(fixture()).getKeyform('face', 1).yaw, 1);

// Missing, duplicate, mismatched, non-finite, and oversized data fail closed.
assert.throws(() => KeyformStore.createKeyformStore({ modelId: 'm', layers: [manifest()] }), /version.*缺少/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 2, modelId: 'm', layers: [manifest()] }), /不支援.*version/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), layerId: '' }] }), /非空字串/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), nx: 2 }] }), /不匹配/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), indicesFingerprint: '' }] }), /非空字串/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [manifest(), manifest()] }), /重複.*layerId/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), keyforms: [{ yaw: NaN, vertices: mesh(0) }] }] }), /有限數字/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), keyforms: [{ yaw: 0, vertices: [[0, 0]] }] }] }), /vertexCount/);
assert.throws(() => KeyformStore.createKeyformStore(fixture(), { expectedLayers: [{ ...manifest(), indicesFingerprint: 'wrong' }, { ...manifest('hair'), indicesFingerprint: 'indices-v1-hair', vertexOrderFingerprint: 'vertices-v1-hair' }] }), /manifest.*不匹配/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), keyforms: Array.from({ length: 33 }, (_, yaw) => ({ yaw, vertices: mesh(0) })) }] }), /數量上限/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), keyforms: [{ yaw: 0, vertices: mesh(0) }, { yaw: 0, vertices: mesh(1) }] }] }), /重複 yaw/);
assert.throws(() => KeyformStore.createKeyformStore({ version: 1, modelId: 'm', layers: [{ ...manifest(), keyforms: [{ yaw: 0, vertices: mesh(0) }] }] }, { limits: { maxTotalStoredVertices: 3 } }), /總量上限/);

console.log('keyform-store: v1, same-model layers, exact topology fingerprints, safe no-keyform identity, limits, immutability, and UMD passed');
