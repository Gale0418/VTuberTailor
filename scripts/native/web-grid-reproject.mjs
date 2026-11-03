const DEFAULT_LIMITS = Object.freeze({
  maxSourcePoints: 16384,
  maxTargetPoints: 16384,
  maxTriangles: 32768,
  maxIntermediateSamples: 256,
  maxPoseValidationWork: 2000000,
  maxPoseOutputPoints: 262144,
  maxCoverageChecks: 8000000,
  maxCoverageEpsilon: 1e-8,
  maxCoordinateSystemIdLength: 256,
});

const POSE_AXIS = Object.freeze([-1, 0, 1]);
const DEFAULT_INTERMEDIATE_SAMPLES = Object.freeze([
  Object.freeze({ x: -0.5, y: -0.5 }),
  Object.freeze({ x: 0.5, y: -0.5 }),
  Object.freeze({ x: -0.5, y: 0.5 }),
  Object.freeze({ x: 0.5, y: 0.5 }),
]);

function fail(message, ErrorType = Error) {
  throw new ErrorType(`[web-grid-reproject] ${message}`);
}

function finiteNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${label} 必須是 finite number`, TypeError);
  return value;
}

function positiveLimit(value, label, fallback, hardCap = fallback) {
  const limit = value == null ? fallback : value;
  if (!Number.isSafeInteger(limit) || limit <= 0) fail(`${label} 必須是正整數`, TypeError);
  if (limit > hardCap) fail(`${label} 不可超過 hard cap ${hardCap}`, RangeError);
  return limit;
}

function coordinateSystemId(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > DEFAULT_LIMITS.maxCoordinateSystemIdLength) {
    fail(`${label} 必須是有限長度的明示字串`, TypeError);
  }
  return value;
}

function arrayLength(value, label) {
  if (Array.isArray(value)) return value.length;
  if (ArrayBuffer.isView(value) && !(value instanceof DataView)) return value.length;
  fail(`${label} 必須是 array 或 typed array`, TypeError);
}

function asArray(value, label, maxLength = null) {
  const length = arrayLength(value, label);
  if (maxLength != null && length > maxLength) fail(`${label} 數量超出有限規模`, RangeError);
  if (Array.isArray(value)) return value;
  return Array.from(value);
}

function point(value, label) {
  let x;
  let y;
  if (Array.isArray(value) || (ArrayBuffer.isView(value) && value.length >= 2)) {
    x = value[0];
    y = value[1];
  } else if (value && typeof value === 'object') {
    x = value.x;
    y = value.y;
  } else {
    fail(`${label} 必須是 [x,y] 或 {x,y}`, TypeError);
  }
  return [finiteNumber(x, `${label}.x`), finiteNumber(y, `${label}.y`)];
}

function points(raw, label, limit) {
  const values = asArray(raw, label, limit);
  if (values.length === 0 || values.length > limit) fail(`${label} 數量超出有限規模`, RangeError);
  return values.map((value, index) => point(value, `${label}[${index}]`));
}

function triangles(raw, pointCount, limit, label) {
  const rawLength = arrayLength(raw, label);
  const first = rawLength > 0 ? raw[0] : null;
  const nested = rawLength > 0 && (Array.isArray(first)
    || (ArrayBuffer.isView(first) && !(first instanceof DataView)));
  if (rawLength === 0) fail(`${label} 必須是非空三角形 index 三元組`, TypeError);
  if (nested && rawLength > limit) fail(`${label} 三角形數量超出有限規模`, RangeError);
  if (!nested && rawLength / 3 > limit) fail(`${label} 三角形數量超出有限規模`, RangeError);
  if (!nested && rawLength % 3 !== 0) fail(`${label} 必須是非空三角形 index 三元組`, TypeError);

  // 先以原始容器長度拒絕超限，才允許 Array.from／slice 或展平配置記憶體。
  const values = asArray(raw, label, nested ? limit : limit * 3);
  let flat;
  if (nested) {
    flat = new Array(values.length * 3);
    let offset = 0;
    for (const [index, triangle] of values.entries()) {
      const tripletLength = arrayLength(triangle, `${label}[${index}]`);
      if (tripletLength !== 3) fail(`${label}[${index}] 必須剛好有三個 index`, TypeError);
      const triplet = asArray(triangle, `${label}[${index}]`, 3);
      flat[offset++] = triplet[0];
      flat[offset++] = triplet[1];
      flat[offset++] = triplet[2];
    }
  } else {
    flat = Array.isArray(raw) ? values.slice() : values;
  }
  for (const [index, value] of flat.entries()) {
    if (!Number.isSafeInteger(value) || value < 0 || value >= pointCount) {
      fail(`${label}[${index}] index 越界或不是整數`, RangeError);
    }
  }
  return flat;
}

function area(a, b, c) {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (!Number.isFinite(value)) fail('triangle area 不是 finite number', RangeError);
  return value;
}

function validateTriangles(pointsValue, trianglesValue, label, minArea) {
  const signs = [];
  for (let index = 0; index < trianglesValue.length; index += 3) {
    const triangleArea = area(
      pointsValue[trianglesValue[index]],
      pointsValue[trianglesValue[index + 1]],
      pointsValue[trianglesValue[index + 2]],
    );
    if (Math.abs(triangleArea) <= minArea) fail(`${label} triangle ${index / 3} 退化`, RangeError);
    signs.push(Math.sign(triangleArea));
  }
  return signs;
}

function gridSpec(raw, pointCount, label) {
  if (!raw || typeof raw !== 'object') fail(`${label}.grid 必須明示 columns/rows`, TypeError);
  const columns = raw.columns;
  const rows = raw.rows;
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 2 || rows < 2) {
    fail(`${label}.grid columns/rows 必須是至少 2 的 safe integer`, TypeError);
  }
  if (columns * rows !== pointCount) fail(`${label}.grid 尺寸與 points 不一致`, RangeError);
  return { columns, rows };
}

function sameTriangleSet(actual, expected) {
  return actual.slice().sort((a, b) => a - b).every((value, index) => value === expected[index]);
}

function validateRectangularGrid(pointsValue, trianglesValue, rawGrid, label, minArea) {
  const grid = gridSpec(rawGrid, pointsValue.length, label);
  const { columns, rows } = grid;
  const expectedTriangleCount = (columns - 1) * (rows - 1) * 2;
  if (trianglesValue.length / 3 !== expectedTriangleCount) {
    fail(`${label} 必須每個 cell 恰好有兩個 triangle`, RangeError);
  }

  const xAxis = pointsValue.slice(0, columns).map((value) => value[0]);
  const yAxis = pointsValue.filter((_value, index) => index % columns === 0).map((value) => value[1]);
  const xDirection = Math.sign(xAxis[1] - xAxis[0]);
  const yDirection = Math.sign(yAxis[1] - yAxis[0]);
  if (xDirection === 0 || yDirection === 0) fail(`${label} grid 軸不可退化`, RangeError);
  for (let column = 1; column < columns; column += 1) {
    if (Math.sign(xAxis[column] - xAxis[column - 1]) !== xDirection) fail(`${label} grid x 軸必須單調`, RangeError);
  }
  for (let row = 1; row < rows; row += 1) {
    if (Math.sign(yAxis[row] - yAxis[row - 1]) !== yDirection) fail(`${label} grid y 軸必須單調`, RangeError);
  }
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    const index = row * columns + column;
    if (pointsValue[index][0] !== xAxis[column] || pointsValue[index][1] !== yAxis[row]) {
      fail(`${label} 必須是明示 axis-aligned row-major rectangular grid`, RangeError);
    }
  }

  const signs = validateTriangles(pointsValue, trianglesValue, label, minArea);
  const winding = signs[0];
  let diagonal = null;
  const seen = new Set();
  for (let row = 0; row < rows - 1; row += 1) for (let column = 0; column < columns - 1; column += 1) {
    const a = row * columns + column;
    const b = a + 1;
    const c = a + columns;
    const d = c + 1;
    const cell = row * (columns - 1) + column;
    const actual = [
      trianglesValue.slice(cell * 6, cell * 6 + 3),
      trianglesValue.slice(cell * 6 + 3, cell * 6 + 6),
    ];
    const first = new Set(actual[0]);
    const second = new Set(actual[1]);
    let cellDiagonal;
    if (first.size === 3 && second.size === 3 && sameTriangleSet(actual[0], [a, b, c].sort((x, y) => x - y)) && sameTriangleSet(actual[1], [b, c, d].sort((x, y) => x - y))) {
      cellDiagonal = 'b-c';
    } else if (first.size === 3 && second.size === 3 && sameTriangleSet(actual[0], [a, b, d].sort((x, y) => x - y)) && sameTriangleSet(actual[1], [a, c, d].sort((x, y) => x - y))) {
      cellDiagonal = 'a-d';
    } else {
      fail(`${label} cell(${column},${row}) triangle index 不符合 rectangular grid`, RangeError);
    }
    if (diagonal == null) diagonal = cellDiagonal;
    if (diagonal !== cellDiagonal) fail(`${label} cells 不可混用 diagonal`, RangeError);
    for (const triangle of actual) {
      const key = triangle.slice().sort((x, y) => x - y).join(',');
      if (seen.has(key)) fail(`${label} triangle index 重複，拒絕洞／重疊`, RangeError);
      seen.add(key);
      const triangleIndex = cell * 2 + actual.indexOf(triangle);
      if (signs[triangleIndex] !== winding) fail(`${label} triangle winding 不一致`, RangeError);
    }
  }
  return { ...grid, xAxis, yAxis, xDirection, yDirection, diagonal, winding };
}

function barycentric(target, a, b, c, epsilon) {
  const denominator = area(a, b, c);
  if (denominator === 0) return null;
  const w0 = ((b[0] - target[0]) * (c[1] - target[1]) - (b[1] - target[1]) * (c[0] - target[0])) / denominator;
  const w1 = ((c[0] - target[0]) * (a[1] - target[1]) - (c[1] - target[1]) * (a[0] - target[0])) / denominator;
  const w2 = 1 - w0 - w1;
  if (![w0, w1, w2].every(Number.isFinite)) return null;
  if (w0 < -epsilon || w1 < -epsilon || w2 < -epsilon) return null;
  return [w0, w1, w2];
}

function axisInterval(axis, value, direction, epsilon) {
  const first = axis[0];
  const last = axis[axis.length - 1];
  const minimum = Math.min(first, last);
  const maximum = Math.max(first, last);
  const minimumCell = direction > 0 ? 0 : axis.length - 2;
  const maximumCell = direction > 0 ? axis.length - 2 : 0;
  if (value < minimum) return minimum - value <= epsilon ? minimumCell : -1;
  if (value > maximum) return value - maximum <= epsilon ? maximumCell : -1;
  if (value === maximum) return maximumCell;
  let low = 0;
  let high = axis.length - 1;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const before = direction > 0 ? axis[middle] <= value : axis[middle] >= value;
    if (before) low = middle;
    else high = middle;
  }
  return low;
}

function equivalentWeights(first, second, epsilon) {
  const byIndex = new Map();
  first.triangle.forEach((index, corner) => byIndex.set(index, first.weights[corner]));
  second.triangle.forEach((index, corner) => byIndex.set(index, byIndex.has(index) ? byIndex.get(index) : 0));
  for (const index of second.triangle) {
    const firstWeight = first.triangle.includes(index) ? first.weights[first.triangle.indexOf(index)] : 0;
    const secondWeight = second.weights[second.triangle.indexOf(index)];
    if (Math.abs(firstWeight - secondWeight) > Math.max(1e-12, epsilon * 4)) return false;
  }
  for (const index of first.triangle) {
    const firstWeight = first.weights[first.triangle.indexOf(index)];
    const secondWeight = second.triangle.includes(index) ? second.weights[second.triangle.indexOf(index)] : 0;
    if (Math.abs(firstWeight - secondWeight) > Math.max(1e-12, epsilon * 4)) return false;
  }
  return true;
}

function buildCoverage(sourcePoints, sourceGrid, sourceTriangles, targetPoints, epsilon, coverageBudget) {
  const { columns, rows, xAxis, yAxis, xDirection, yDirection } = sourceGrid;
  return targetPoints.map((target, targetIndex) => {
    const column = axisInterval(xAxis, target[0], xDirection, epsilon);
    const row = axisInterval(yAxis, target[1], yDirection, epsilon);
    if (column < 0 || row < 0) fail(`target point ${targetIndex} 沒有 strict triangle coverage`, RangeError);
    const cell = row * (columns - 1) + column;
    const matches = [];
    for (let triangleOffset = 0; triangleOffset < 2; triangleOffset += 1) {
      coverageBudget.used += 1;
      if (coverageBudget.used > coverageBudget.limit) fail('coverageChecks 超出 hard budget', RangeError);
      const index = cell * 6 + triangleOffset * 3;
      const triangle = sourceTriangles.slice(index, index + 3);
      const weights = barycentric(target, sourcePoints[triangle[0]], sourcePoints[triangle[1]], sourcePoints[triangle[2]], epsilon);
      if (weights) matches.push({ triangle, weights });
    }
    if (matches.length === 0) fail(`target point ${targetIndex} 沒有 strict triangle coverage`, RangeError);
    if (matches.length === 2 && !equivalentWeights(matches[0], matches[1], epsilon)) {
      fail(`target point ${targetIndex} 落在 ambiguous source triangles`, RangeError);
    }
    return matches[0];
  });
}

function poseKey(x, y) {
  return `${x}:${y}`;
}

function validateKeyforms(raw, sourceRest, limits) {
  const values = asArray(raw, 'poses', 9);
  if (values.length !== 9) fail('poses 必須是完整且唯一的 3×3 九格', RangeError);
  const byKey = new Map();
  for (const [index, record] of values.entries()) {
    if (!record || typeof record !== 'object') fail(`poses[${index}] 必須是 object`, TypeError);
    const x = finiteNumber(record.x, `poses[${index}].x`);
    const y = finiteNumber(record.y, `poses[${index}].y`);
    if (!POSE_AXIS.includes(x) || !POSE_AXIS.includes(y)) fail(`poses[${index}] 的 x/y 必須落在 -1/0/1`, RangeError);
    const key = poseKey(x, y);
    if (byKey.has(key)) fail(`poses 含有重複格點 ${key}`, RangeError);
    const valuesAtPose = points(record.points, `poses[${index}].points`, limits.maxSourcePoints);
    if (valuesAtPose.length !== sourceRest.length) fail(`poses[${index}].points 數量必須與 source rest 一致`, RangeError);
    if (x === 0 && y === 0) {
      valuesAtPose.forEach((value, pointIndex) => {
        if (value[0] !== sourceRest[pointIndex][0] || value[1] !== sourceRest[pointIndex][1]) {
          fail(`neutral pose point ${pointIndex} 的 delta 必須精確為零`, RangeError);
        }
      });
    }
    byKey.set(key, { x, y, points: valuesAtPose });
  }
  for (const y of POSE_AXIS) for (const x of POSE_AXIS) {
    if (!byKey.has(poseKey(x, y))) fail(`poses 缺少完整格點 ${poseKey(x, y)}`, RangeError);
  }
  return byKey;
}

function bracket(value) {
  if (value <= -1) return [-1, -1, 0];
  if (value >= 1) return [1, 1, 0];
  if (value < 0) return [-1, 0, value + 1];
  if (value > 0) return [0, 1, value];
  return [0, 0, 0];
}

function interpolatePose(byKey, x, y, pointCount) {
  const [x0, x1, tx] = bracket(x);
  const [y0, y1, ty] = bracket(y);
  const a = byKey.get(poseKey(x0, y0)).points;
  const b = byKey.get(poseKey(x1, y0)).points;
  const c = byKey.get(poseKey(x0, y1)).points;
  const d = byKey.get(poseKey(x1, y1)).points;
  const output = new Array(pointCount);
  for (let index = 0; index < pointCount; index += 1) {
    const bottomX = a[index][0] + (b[index][0] - a[index][0]) * tx;
    const bottomY = a[index][1] + (b[index][1] - a[index][1]) * tx;
    const topX = c[index][0] + (d[index][0] - c[index][0]) * tx;
    const topY = c[index][1] + (d[index][1] - c[index][1]) * tx;
    output[index] = [bottomX + (topX - bottomX) * ty, bottomY + (topY - bottomY) * ty];
  }
  return output;
}

function mapDelta(sourceRest, sourcePose, targetRest, coverage) {
  return targetRest.map((target, index) => {
    const { triangle, weights } = coverage[index];
    let dx = 0;
    let dy = 0;
    for (let corner = 0; corner < 3; corner += 1) {
      const sourceIndex = triangle[corner];
      dx += weights[corner] * (sourcePose[sourceIndex][0] - sourceRest[sourceIndex][0]);
      dy += weights[corner] * (sourcePose[sourceIndex][1] - sourceRest[sourceIndex][1]);
    }
    const delta = [dx, dy];
    if (!delta.every(Number.isFinite)) fail(`target point ${index} 的 barycentric delta 不是 finite number`, RangeError);
    return delta;
  });
}

function addDelta(rest, deltas) {
  return rest.map((value, index) => {
    const output = [value[0] + deltas[index][0], value[1] + deltas[index][1]];
    if (!output.every(Number.isFinite)) fail(`target point ${index} 的 reprojected position 不是 finite number`, RangeError);
    return output;
  });
}

function validateTargetPose(targetRest, targetTriangles, restSigns, pointsAtPose, minArea, poseLabel) {
  let minimumArea = Infinity;
  let maximumArea = -Infinity;
  for (let index = 0; index < targetTriangles.length; index += 3) {
    const triangleIndex = index / 3;
    const current = area(
      pointsAtPose[targetTriangles[index]],
      pointsAtPose[targetTriangles[index + 1]],
      pointsAtPose[targetTriangles[index + 2]],
    );
    if (Math.abs(current) <= minArea || Math.sign(current) !== restSigns[triangleIndex]) {
      fail(`target triangle ${triangleIndex} 在 ${poseLabel} 翻面或退化`, RangeError);
    }
    minimumArea = Math.min(minimumArea, current);
    maximumArea = Math.max(maximumArea, current);
  }
  return { triangleCount: targetTriangles.length / 3, minimumArea, maximumArea };
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

export function reprojectWebGrid(input = {}) {
  if (!input || typeof input !== 'object') fail('input 必須是 object', TypeError);
  const source = input.source;
  const target = input.target;
  if (!source || !target || typeof source !== 'object' || typeof target !== 'object') fail('source 與 target 必須明示提供', TypeError);
  const sourceId = coordinateSystemId(source.coordinateSystemId, 'source.coordinateSystemId');
  const targetId = coordinateSystemId(target.coordinateSystemId, 'target.coordinateSystemId');
  if (sourceId !== targetId) fail('source／target coordinateSystemId 不一致；拒絕猜測座標轉換', RangeError);

  const options = input.options || {};
  const limits = {
    maxSourcePoints: positiveLimit(options.maxSourcePoints, 'maxSourcePoints', DEFAULT_LIMITS.maxSourcePoints, DEFAULT_LIMITS.maxSourcePoints),
    maxTargetPoints: positiveLimit(options.maxTargetPoints, 'maxTargetPoints', DEFAULT_LIMITS.maxTargetPoints, DEFAULT_LIMITS.maxTargetPoints),
    maxTriangles: positiveLimit(options.maxTriangles, 'maxTriangles', DEFAULT_LIMITS.maxTriangles, DEFAULT_LIMITS.maxTriangles),
    maxIntermediateSamples: positiveLimit(options.maxIntermediateSamples, 'maxIntermediateSamples', DEFAULT_LIMITS.maxIntermediateSamples, DEFAULT_LIMITS.maxIntermediateSamples),
    maxPoseValidationWork: positiveLimit(options.maxPoseValidationWork, 'maxPoseValidationWork', DEFAULT_LIMITS.maxPoseValidationWork, DEFAULT_LIMITS.maxPoseValidationWork),
    maxPoseOutputPoints: positiveLimit(options.maxPoseOutputPoints, 'maxPoseOutputPoints', DEFAULT_LIMITS.maxPoseOutputPoints, DEFAULT_LIMITS.maxPoseOutputPoints),
    maxCoverageChecks: positiveLimit(options.maxCoverageChecks, 'maxCoverageChecks', DEFAULT_LIMITS.maxCoverageChecks, DEFAULT_LIMITS.maxCoverageChecks),
  };
  const minTriangleArea = options.minTriangleArea == null ? 0 : finiteNumber(options.minTriangleArea, 'minTriangleArea');
  if (minTriangleArea < 0) fail('minTriangleArea 不可小於 0', RangeError);
  const coverageEpsilon = options.coverageEpsilon == null ? 1e-10 : finiteNumber(options.coverageEpsilon, 'coverageEpsilon');
  if (coverageEpsilon < 0 || coverageEpsilon > DEFAULT_LIMITS.maxCoverageEpsilon) {
    fail(`coverageEpsilon 必須介於 0 與 ${DEFAULT_LIMITS.maxCoverageEpsilon} 之間`, RangeError);
  }
  const sourceRest = points(source.points, 'source.points', limits.maxSourcePoints);
  const targetRest = points(target.points, 'target.points', limits.maxTargetPoints);
  const sourceTriangles = triangles(source.triangles, sourceRest.length, limits.maxTriangles, 'source.triangles');
  const targetTriangles = triangles(target.triangles, targetRest.length, limits.maxTriangles, 'target.triangles');
  const sourceGrid = validateRectangularGrid(sourceRest, sourceTriangles, source.grid, 'source', minTriangleArea);
  const targetRestSigns = validateTriangles(targetRest, targetTriangles, 'target rest', minTriangleArea);
  const coverageBudget = { used: 0, limit: limits.maxCoverageChecks };
  const coverage = buildCoverage(sourceRest, sourceGrid, sourceTriangles, targetRest, coverageEpsilon, coverageBudget);
  const poseMap = validateKeyforms(input.poses, sourceRest, limits);

  const rawSamples = input.intermediateSamples == null ? DEFAULT_INTERMEDIATE_SAMPLES : asArray(input.intermediateSamples, 'intermediateSamples', limits.maxIntermediateSamples);
  if (rawSamples.length > limits.maxIntermediateSamples) fail('intermediateSamples 超出有限規模', RangeError);
  const poseCount = POSE_AXIS.length * POSE_AXIS.length;
  const targetTriangleCount = targetTriangles.length / 3;
  const poseSampleCount = poseCount + rawSamples.length;
  const poseValidationWork = poseSampleCount * targetTriangleCount;
  if (poseValidationWork > limits.maxPoseValidationWork) {
    fail(`pose validation work ${poseValidationWork} 超出 hard cap ${limits.maxPoseValidationWork}`, RangeError);
  }
  // intermediate samples 也會短暫建立完整 target mesh；總量一併計入，避免
  // 以 256 samples × 大 mesh 繞過輸出記憶體上限。此數值受 fixed hard cap 限制，
  // options 只能收緊，不能放寬。
  const poseOutputPoints = poseSampleCount * targetRest.length;
  if (poseOutputPoints > limits.maxPoseOutputPoints) {
    fail(`pose output points ${poseOutputPoints} 超出 hard cap ${limits.maxPoseOutputPoints}`, RangeError);
  }
  const intermediateSamples = rawSamples.map((value, index) => {
    const sample = point(value, `intermediateSamples[${index}]`);
    if (sample[0] < -1 || sample[0] > 1 || sample[1] < -1 || sample[1] > 1) fail(`intermediateSamples[${index}] 超出姿態範圍`, RangeError);
    return { x: sample[0], y: sample[1] };
  });

  const poseOutputs = [];
  const validationSamples = [];
  const addSample = (x, y, label, includeOutput) => {
    const sourceAtPose = interpolatePose(poseMap, x, y, sourceRest.length);
    const deltas = mapDelta(sourceRest, sourceAtPose, targetRest, coverage);
    const pointsAtPose = addDelta(targetRest, deltas);
    const validation = validateTargetPose(targetRest, targetTriangles, targetRestSigns, pointsAtPose, minTriangleArea, label);
    validationSamples.push({ x, y, label, ...validation });
    if (includeOutput) poseOutputs.push({ x, y, deltas, points: pointsAtPose });
  };
  for (const y of POSE_AXIS) for (const x of POSE_AXIS) addSample(x, y, `pose(${x},${y})`, true);
  for (const sample of intermediateSamples) addSample(sample.x, sample.y, `sample(${sample.x},${sample.y})`, false);

  const output = {
    version: 1,
    coordinateSystemId: sourceId,
    source: { pointCount: sourceRest.length, triangleCount: sourceTriangles.length / 3 },
    target: { pointCount: targetRest.length, triangleCount: targetTriangles.length / 3, triangles: targetTriangles.slice() },
    poses: poseOutputs,
    validation: {
      intermediateSamples,
      samples: validationSamples,
      coverageChecks: coverageBudget.used,
      finiteSampledOnly: true,
      continuousDomainGuarantee: false,
      note: '純資料重投影與有限姿態／幾何取樣 invariant；不保證未取樣連續域，不是自動 patch，也不宣稱 VTS／視覺兼容。',
    },
  };
  return deepFreeze(output);
}

export { DEFAULT_LIMITS, DEFAULT_INTERMEDIATE_SAMPLES, POSE_AXIS };
