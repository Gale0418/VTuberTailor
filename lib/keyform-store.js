(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.KeyformStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /*
   * Small, format-only keyform validator for the planned manual yaw editor.
   * This is intentionally not a Cubism, VTS, renderer, or model loader. It
   * stores synthetic mesh positions only after the caller has supplied exact
   * layer/topology identities. It never sorts, guesses, or remaps vertices.
   *
   * API: createKeyformStore({ version: 1, modelId, layers }, options?)
   * (The `records` property or an array of records is also accepted.)
   * A layer is { layerId, nx, ny, vertexCount, indicesFingerprint,
   * vertexOrderFingerprint, keyforms: [{ yaw, vertices: [[x, y], ...] }] }.
   * `keyforms` is optional in v1. Missing keyforms are safe identity: lookup
   * returns null, and getKeyformOrIdentity() returns an explicit identity.
   *
   * Structural memory limits: 256 layers, 32 keyforms/layer, 65,536 vertices
   * per mesh, 1,048,576 stored vertices total, and bounded strings. These
   * limits can be lowered with options.limits, never raised above HARD_LIMITS.
   * This module is only a basic data contract, not Cubism/VTS integration.
   */

  var hasOwn = Object.prototype.hasOwnProperty;
  var VERSION = 1;
  var HARD_LIMITS = Object.freeze({
    maxLayers: 256,
    maxKeyformsPerLayer: 32,
    maxVertexCount: 65536,
    maxTotalStoredVertices: 1048576,
    maxIdLength: 256,
    maxFingerprintLength: 512
  });
  var DEFAULT_LIMITS = Object.freeze({
    maxLayers: 256,
    maxKeyformsPerLayer: 32,
    maxVertexCount: 65536,
    maxTotalStoredVertices: 1048576,
    maxIdLength: 256,
    maxFingerprintLength: 512
  });

  function fail(Type, message) { throw new Type(message); }

  function finiteNumber(value, name) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(TypeError, name + ' 必須是有限數字');
    }
    return value;
  }

  function positiveInteger(value, name) {
    finiteNumber(value, name);
    if (!Number.isInteger(value) || value < 1) fail(RangeError, name + ' 必須是正整數');
    return value;
  }

  function boundedInteger(value, name, maximum) {
    var result = positiveInteger(value, name);
    if (result > maximum) fail(RangeError, name + ' 超過安全上限 ' + maximum);
    return result;
  }

  function boundedString(value, name, maximum) {
    if (typeof value !== 'string' || value.length === 0) fail(TypeError, name + ' 必須是非空字串');
    if (value.length > maximum) fail(RangeError, name + ' 超過字串長度上限 ' + maximum);
    return value;
  }

  function object(value, name) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail(TypeError, name + ' 必須是物件');
    return value;
  }

  function listOf(value, name) {
    if (!Array.isArray(value)) fail(TypeError, name + ' 必須是陣列');
    return value;
  }

  function copyAndFreeze(value) {
    if (Array.isArray(value)) return Object.freeze(value.map(copyAndFreeze));
    if (value && typeof value === 'object') {
      var out = {};
      Object.keys(value).forEach(function (key) { out[key] = copyAndFreeze(value[key]); });
      return Object.freeze(out);
    }
    return value;
  }

  function readLimit(source, name, hardMaximum) {
    if (source[name] == null) return DEFAULT_LIMITS[name];
    return boundedInteger(source[name], 'limits.' + name, hardMaximum);
  }

  function normalizeLimits(options) {
    var source = options && options.limits;
    if (source == null) return DEFAULT_LIMITS;
    object(source, 'limits');
    return Object.freeze({
      maxLayers: readLimit(source, 'maxLayers', HARD_LIMITS.maxLayers),
      maxKeyformsPerLayer: readLimit(source, 'maxKeyformsPerLayer', HARD_LIMITS.maxKeyformsPerLayer),
      maxVertexCount: readLimit(source, 'maxVertexCount', HARD_LIMITS.maxVertexCount),
      maxTotalStoredVertices: readLimit(source, 'maxTotalStoredVertices', HARD_LIMITS.maxTotalStoredVertices),
      maxIdLength: readLimit(source, 'maxIdLength', HARD_LIMITS.maxIdLength),
      maxFingerprintLength: readLimit(source, 'maxFingerprintLength', HARD_LIMITS.maxFingerprintLength)
    });
  }

  function versionOf(value, name) {
    if (!hasOwn.call(value, 'version')) fail(TypeError, name + '.version 缺少');
    if (value.version !== VERSION) fail(Error, '不支援 keyform version ' + String(value.version) + '；僅支援 version 1');
  }

  function aliases(value, names, name) {
    var found = [];
    names.forEach(function (key) { if (hasOwn.call(value, key)) found.push(value[key]); });
    if (found.length === 0) fail(TypeError, name + ' 缺少');
    for (var i = 1; i < found.length; i += 1) {
      if (found[i] !== found[0]) fail(RangeError, name + ' 的別名值不一致');
    }
    return found[0];
  }

  function topologySource(record) {
    if (record.topology == null) return record;
    return object(record.topology, 'layer.topology');
  }

  function readTopology(record, limits) {
    var source = topologySource(record);
    var nx = boundedInteger(aliases(source, ['nx'], 'layer.nx'), 'layer.nx', limits.maxVertexCount - 1);
    var ny = boundedInteger(aliases(source, ['ny'], 'layer.ny'), 'layer.ny', limits.maxVertexCount - 1);
    var vertexCount = boundedInteger(aliases(source, ['vertexCount'], 'layer.vertexCount'), 'layer.vertexCount', limits.maxVertexCount);
    var indicesFingerprint = boundedString(aliases(source, ['indicesFingerprint', 'indexFingerprint'], 'layer.indicesFingerprint'), 'layer.indicesFingerprint', limits.maxFingerprintLength);
    var vertexOrderFingerprint = boundedString(aliases(source, ['vertexOrderFingerprint', 'vertexOrderingFingerprint', 'vertexOrder'], 'layer.vertexOrderFingerprint'), 'layer.vertexOrderFingerprint', limits.maxFingerprintLength);
    if ((nx + 1) * (ny + 1) !== vertexCount) fail(RangeError, 'layer nx/ny 與 vertexCount 不匹配');
    return { nx: nx, ny: ny, vertexCount: vertexCount, indicesFingerprint: indicesFingerprint, vertexOrderFingerprint: vertexOrderFingerprint };
  }

  function readLayerId(record, limits) {
    var value;
    if (hasOwn.call(record, 'layerId')) value = record.layerId;
    else if (hasOwn.call(record, 'id')) value = record.id;
    else fail(TypeError, 'layer.layerId 缺少');
    return boundedString(value, 'layer.layerId', limits.maxIdLength);
  }

  function readVertices(value, name, vertexCount) {
    listOf(value, name);
    if (value.length !== vertexCount) fail(RangeError, name + ' vertexCount 不匹配');
    return value.map(function (point, index) {
      var x; var y;
      if (Array.isArray(point)) {
        if (point.length !== 2) fail(TypeError, name + '[' + index + '] 必須是 [x, y]');
        x = point[0]; y = point[1];
      } else {
        object(point, name + '[' + index + ']');
        x = point.x; y = point.y;
      }
      return [finiteNumber(x, name + '[' + index + '].x'), finiteNumber(y, name + '[' + index + '].y')];
    });
  }

  function readKeyforms(record, topology, limits) {
    if (!hasOwn.call(record, 'keyforms') || record.keyforms == null) return [];
    var raw = listOf(record.keyforms, 'layer.keyforms');
    if (raw.length > limits.maxKeyformsPerLayer) fail(RangeError, 'layer.keyforms 超過數量上限 ' + limits.maxKeyformsPerLayer);
    var seenYaw = Object.create(null);
    return raw.map(function (keyform, index) {
      object(keyform, 'layer.keyforms[' + index + ']');
      if (!hasOwn.call(keyform, 'yaw')) fail(TypeError, 'layer.keyforms[' + index + '].yaw 缺少');
      var yaw = finiteNumber(keyform.yaw, 'layer.keyforms[' + index + '].yaw');
      var seenKey = String(yaw);
      if (hasOwn.call(seenYaw, seenKey)) fail(RangeError, 'layer.keyforms 含有重複 yaw ' + seenKey);
      seenYaw[seenKey] = true;
      var vertices;
      if (hasOwn.call(keyform, 'vertices')) vertices = keyform.vertices;
      else if (hasOwn.call(keyform, 'points')) vertices = keyform.points;
      else fail(TypeError, 'layer.keyforms[' + index + '].vertices 缺少');
      return { yaw: yaw, vertices: readVertices(vertices, 'layer.keyforms[' + index + '].vertices', topology.vertexCount) };
    });
  }

  function normalizeLayer(record, modelId, limits) {
    object(record, 'layer');
    var layerId = readLayerId(record, limits);
    var topology = readTopology(record, limits);
    var keyforms = readKeyforms(record, topology, limits);
    if (hasOwn.call(record, 'modelId') && record.modelId !== modelId) fail(RangeError, 'layer.modelId 與 store modelId 不匹配');
    return { layerId: layerId, nx: topology.nx, ny: topology.ny, vertexCount: topology.vertexCount, indicesFingerprint: topology.indicesFingerprint, vertexOrderFingerprint: topology.vertexOrderFingerprint, keyforms: keyforms };
  }

  function expectedById(expected, layerId) {
    if (expected == null) return null;
    if (Array.isArray(expected)) {
      for (var i = 0; i < expected.length; i += 1) {
        if (expected[i] && (expected[i].layerId === layerId || expected[i].id === layerId)) return expected[i];
      }
      fail(RangeError, 'caller mesh manifest 缺少 layer ' + layerId);
    }
    object(expected, 'caller mesh manifest');
    if (!hasOwn.call(expected, layerId)) fail(RangeError, 'caller mesh manifest 缺少 layer ' + layerId);
    return expected[layerId];
  }

  function compareExpected(layer, expected, limits) {
    if (expected == null) return;
    var wanted = normalizeLayer(expected, '__manifest__', limits);
    if (wanted.layerId !== layer.layerId || wanted.nx !== layer.nx || wanted.ny !== layer.ny || wanted.vertexCount !== layer.vertexCount || wanted.indicesFingerprint !== layer.indicesFingerprint || wanted.vertexOrderFingerprint !== layer.vertexOrderFingerprint) {
      fail(RangeError, 'layer ' + layer.layerId + ' mesh manifest 不匹配');
    }
  }

  function normalizeInput(input) {
    var source; var records;
    if (Array.isArray(input)) {
      if (input.length === 0) fail(TypeError, 'records 不可為空');
      source = input[0]; object(source, 'records[0]'); records = input;
    } else {
      object(input, 'store spec'); source = input;
      records = input.layers;
      if (records == null) records = input.records;
      if (records == null) fail(TypeError, 'store spec.layers 或 records 缺少');
    }
    versionOf(source, 'store spec');
    var modelId = boundedString(source.modelId, 'modelId', DEFAULT_LIMITS.maxIdLength);
    return { modelId: modelId, records: listOf(records, 'layers') };
  }

  function createKeyformStore(input, options) {
    var normalized = normalizeInput(input);
    var limits = normalizeLimits(options);
    if (normalized.records.length === 0) fail(TypeError, 'layers 不可為空');
    if (normalized.records.length > limits.maxLayers) fail(RangeError, 'layers 超過數量上限 ' + limits.maxLayers);
    var manifest = options && (options.expectedLayers || options.meshManifest || options.expected);
    var seenLayers = Object.create(null); var totalVertices = 0;
    var layers = normalized.records.map(function (raw) {
      var layer = normalizeLayer(raw, normalized.modelId, limits);
      if (hasOwn.call(seenLayers, layer.layerId)) fail(RangeError, 'layers 含有重複 layerId ' + layer.layerId);
      seenLayers[layer.layerId] = true;
      totalVertices += layer.vertexCount * layer.keyforms.length;
      if (totalVertices > limits.maxTotalStoredVertices) fail(RangeError, 'keyform vertices 超過總量上限 ' + limits.maxTotalStoredVertices);
      compareExpected(layer, expectedById(manifest, layer.layerId), limits);
      return copyAndFreeze(layer);
    });
    var byId = Object.create(null);
    layers.forEach(function (layer) { byId[layer.layerId] = layer; });
    function requireLayer(layerId) {
      boundedString(layerId, 'layerId', limits.maxIdLength);
      if (!hasOwn.call(byId, layerId)) fail(RangeError, '找不到 layer ' + layerId);
      return byId[layerId];
    }
    function getKeyform(layerId, yaw) {
      var layer = requireLayer(layerId); finiteNumber(yaw, 'yaw');
      for (var i = 0; i < layer.keyforms.length; i += 1) if (Object.is(layer.keyforms[i].yaw, yaw)) return layer.keyforms[i];
      return null;
    }
    var store = {
      version: VERSION, modelId: normalized.modelId, limits: limits, layers: layers,
      getLayer: requireLayer, getKeyform: getKeyform,
      hasKeyform: function (layerId, yaw) { return getKeyform(layerId, yaw) !== null; },
      getKeyformOrIdentity: function (layerId, yaw) {
        var keyform = getKeyform(layerId, yaw);
        if (keyform) return keyform;
        return Object.freeze({ type: 'identity', modelId: normalized.modelId, layerId: layerId, yaw: yaw });
      }
    };
    store.layer = store.getLayer; store.get = store.getKeyform;
    return Object.freeze(store);
  }

  return Object.freeze({ VERSION: VERSION, HARD_LIMITS: HARD_LIMITS, DEFAULT_LIMITS: DEFAULT_LIMITS,
    createKeyformStore: createKeyformStore, validateKeyformStore: createKeyformStore });
});
