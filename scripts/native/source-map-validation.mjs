/**
 * Pure validation for the parameter contract in PuppetLoom's native source map.
 *
 * The exporter currently writes parameter values in source units multiplied by
 * `parameterScale`; it does not, however, promise that every model parameter is
 * present as a layer axis.  Therefore axes are checked individually while the
 * source-map parameter table is checked against the complete canonical model.
 */

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isNonEmptyString = (value) => typeof value === 'string' && value.length > 0;

function readParameterIds(value, mapping, failures) {
  if (!isRecord(value)) {
    failures.push({ reason: 'parameter-mapping-missing', mapping });
    return new Map();
  }

  const result = new Map();
  const nativeToSource = new Map();
  for (const [sourceId, nativeId] of Object.entries(value)) {
    if (!isNonEmptyString(sourceId) || !isNonEmptyString(nativeId)) {
      failures.push({ reason: 'parameter-mapping-entry-invalid', mapping, sourceId, nativeId });
      continue;
    }
    result.set(sourceId, nativeId);
    const sourceIds = nativeToSource.get(nativeId) ?? [];
    sourceIds.push(sourceId);
    nativeToSource.set(nativeId, sourceIds);
  }
  for (const [nativeId, sourceIds] of nativeToSource) {
    if (sourceIds.length > 1) failures.push({ reason: 'parameter-mapping-native-id-duplicate', mapping, nativeId, sourceIds });
  }
  return result;
}

function compareMappings(statusIds, sourceMapIds, failures) {
  const sourceIds = new Set([...statusIds.keys(), ...sourceMapIds.keys()]);
  for (const sourceId of sourceIds) {
    const exportStatusId = statusIds.get(sourceId);
    const sourceMapId = sourceMapIds.get(sourceId);
    if (exportStatusId === undefined) {
      failures.push({ reason: 'parameter-mapping-missing', mapping: 'export-status', sourceId });
    } else if (sourceMapId === undefined) {
      failures.push({ reason: 'parameter-mapping-missing', mapping: 'source-map', sourceId });
    } else if (exportStatusId !== sourceMapId) {
      failures.push({ reason: 'parameter-mapping-disagrees', sourceId, exportStatusId, sourceMapId });
    }
  }
}

function validateScale(exportStatus, sourceMap, failures) {
  const exportStatusScale = exportStatus?.parameterScale;
  const sourceMapScale = sourceMap?.parameterScale;
  if (!Number.isFinite(exportStatusScale) || exportStatusScale <= 0) failures.push({ reason: 'parameter-scale-invalid', mapping: 'export-status', value: exportStatusScale });
  if (!Number.isFinite(sourceMapScale) || sourceMapScale <= 0) failures.push({ reason: 'parameter-scale-invalid', mapping: 'source-map', value: sourceMapScale });
  if (Number.isFinite(exportStatusScale) && Number.isFinite(sourceMapScale) && exportStatusScale !== sourceMapScale) {
    failures.push({ reason: 'parameter-scale-disagrees', exportStatusScale, sourceMapScale });
  }
  return Number.isFinite(sourceMapScale) ? sourceMapScale : exportStatusScale;
}

function validateCanonicalParameters(projectParameters, scale, statusIds, sourceMapIds, sourceMap, failures) {
  if (!Array.isArray(projectParameters)) {
    failures.push({ reason: 'canonical-parameter-list-missing' });
    return new Map();
  }

  const canonical = new Map();
  for (const [index, parameter] of projectParameters.entries()) {
    if (!isRecord(parameter) || !isNonEmptyString(parameter.id)) {
      failures.push({ reason: 'canonical-parameter-invalid', index });
      continue;
    }
    if (canonical.has(parameter.id)) {
      failures.push({ reason: 'canonical-parameter-id-duplicate', sourceId: parameter.id });
      continue;
    }
    canonical.set(parameter.id, parameter);
    for (const field of ['min', 'default', 'max']) {
      if (!Number.isFinite(parameter[field])) failures.push({ reason: 'canonical-parameter-value-invalid', sourceId: parameter.id, field, value: parameter[field] });
    }
  }

  for (const sourceId of canonical.keys()) {
    if (!statusIds.has(sourceId)) failures.push({ reason: 'parameter-mapping-missing', mapping: 'export-status', sourceId });
    if (!sourceMapIds.has(sourceId)) failures.push({ reason: 'parameter-mapping-missing', mapping: 'source-map', sourceId });
  }
  for (const sourceId of statusIds.keys()) {
    if (!canonical.has(sourceId)) failures.push({ reason: 'parameter-mapping-unexpected-source', mapping: 'export-status', sourceId });
  }
  for (const sourceId of sourceMapIds.keys()) {
    if (!canonical.has(sourceId)) failures.push({ reason: 'parameter-mapping-unexpected-source', mapping: 'source-map', sourceId });
  }

  if (!Array.isArray(sourceMap?.parameters)) {
    failures.push({ reason: 'source-map-parameter-list-missing' });
    return canonical;
  }

  const seenSourceIds = new Set();
  for (const [index, parameter] of sourceMap.parameters.entries()) {
    if (!isRecord(parameter) || !isNonEmptyString(parameter.sourceId)) {
      failures.push({ reason: 'source-map-parameter-invalid', index });
      continue;
    }
    const sourceId = parameter.sourceId;
    if (seenSourceIds.has(sourceId)) failures.push({ reason: 'source-map-parameter-duplicate', sourceId });
    seenSourceIds.add(sourceId);
    const expected = canonical.get(sourceId);
    if (!expected) {
      failures.push({ reason: 'source-map-parameter-unexpected-source', sourceId });
      continue;
    }

    const expectedNativeId = sourceMapIds.get(sourceId) ?? statusIds.get(sourceId);
    if (parameter.id !== expectedNativeId) {
      failures.push({ reason: 'source-map-parameter-id-disagrees', sourceId, expectedId: expectedNativeId, actualId: parameter.id });
    }
    for (const field of ['min', 'default', 'max']) {
      const actual = parameter[field];
      const expectedValue = Number.isFinite(scale) && Number.isFinite(expected[field]) ? expected[field] * scale : undefined;
      if (!Number.isFinite(actual)) {
        failures.push({ reason: 'source-map-parameter-value-nonfinite', sourceId, field, value: actual });
      } else if (Number.isFinite(expectedValue) && actual !== expectedValue) {
        failures.push({ reason: 'source-map-parameter-value-disagrees', sourceId, field, expected: expectedValue, actual });
      }
    }
  }
  for (const sourceId of canonical.keys()) {
    if (!seenSourceIds.has(sourceId)) failures.push({ reason: 'source-map-parameter-missing', sourceId });
  }
  return canonical;
}

function validateLayerAxes(sourceMap, canonical, parameterIds, failures) {
  if (!Array.isArray(sourceMap?.layers)) {
    failures.push({ reason: 'source-map-layer-list-missing' });
    return;
  }

  for (const [layerIndex, layer] of sourceMap.layers.entries()) {
    const layerRef = { layer: layer?.sourceId ?? layer?.id ?? layerIndex };
    if (!isRecord(layer) || !Array.isArray(layer.axes)) {
      failures.push({ reason: 'source-map-layer-axes-missing', ...layerRef });
      continue;
    }
    const seenSourceIds = new Set();
    for (const [axisIndex, axis] of layer.axes.entries()) {
      const axisRef = { ...layerRef, axis: axis?.sourceId ?? axis?.id ?? axisIndex };
      if (!isRecord(axis)) {
        failures.push({ reason: 'source-map-axis-invalid', ...axisRef });
        continue;
      }
      const sourceId = axis.sourceId;
      if (!isNonEmptyString(sourceId)) {
        failures.push({ reason: 'source-map-axis-source-id-invalid', ...axisRef, sourceId });
      } else {
        if (seenSourceIds.has(sourceId)) failures.push({ reason: 'source-map-axis-source-id-duplicate', ...layerRef, sourceId });
        seenSourceIds.add(sourceId);
        const expectedParameter = canonical.get(sourceId);
        const expectedNativeId = parameterIds.get(sourceId);
        if (!expectedParameter) failures.push({ reason: 'source-map-axis-source-id-unknown', ...layerRef, sourceId });
        if (axis.id !== expectedNativeId) failures.push({ reason: 'source-map-axis-id-disagrees', ...layerRef, sourceId, expectedId: expectedNativeId, actualId: axis.id });
      }

      if (!Array.isArray(axis.keys) || axis.keys.length === 0) {
        failures.push({ reason: 'source-map-axis-keys-missing-or-empty', ...axisRef, keys: axis.keys });
        continue;
      }
      const finite = axis.keys.every(Number.isFinite);
      if (!finite) {
        failures.push({ reason: 'source-map-axis-keys-nonfinite', ...axisRef, keys: axis.keys });
        continue;
      }
      for (let index = 1; index < axis.keys.length; index += 1) {
        if (axis.keys[index] <= axis.keys[index - 1]) {
          failures.push({ reason: 'source-map-axis-keys-unsorted', ...axisRef, keys: axis.keys });
          break;
        }
      }

    }
  }
}

/**
 * Validate source-map parameter IDs, scaled parameter values, and layer axes.
 * This function only inspects plain data and always returns structured failures.
 */
export function validateNativeSourceMapParameters({ project, projectParameters, sourceMap, exportStatus } = {}) {
  const failures = [];
  if (sourceMap?.version !== 1) failures.push({ reason: 'source-map-version-unsupported', value: sourceMap?.version });
  const statusIds = readParameterIds(exportStatus?.parameterIds, 'export-status', failures);
  const sourceMapIds = readParameterIds(sourceMap?.parameterIds, 'source-map', failures);
  compareMappings(statusIds, sourceMapIds, failures);
  const scale = validateScale(exportStatus, sourceMap, failures);
  const canonical = validateCanonicalParameters(
    projectParameters ?? project?.model?.parameters,
    scale,
    statusIds,
    sourceMapIds,
    sourceMap,
    failures,
  );
  validateLayerAxes(sourceMap, canonical, sourceMapIds, failures);
  return { ok: failures.length === 0, failures };
}
