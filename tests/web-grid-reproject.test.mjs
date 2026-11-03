import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_LIMITS, reprojectWebGrid } from '../scripts/native/web-grid-reproject.mjs';

function gridPoints(columns, rows) {
  const points = [];
  for (let row = 0; row < rows; row += 1) for (let column = 0; column < columns; column += 1) {
    points.push([column / (columns - 1), row / (rows - 1)]);
  }
  return points;
}

function gridTriangles(columns, rows, omitCell = null) {
  const triangles = [];
  for (let row = 0; row < rows - 1; row += 1) for (let column = 0; column < columns - 1; column += 1) {
    const omitted = Array.isArray(omitCell?.[0])
      ? omitCell.some(([omitColumn, omitRow]) => omitColumn === column && omitRow === row)
      : omitCell && omitCell[0] === column && omitCell[1] === row;
    if (omitted) continue;
    const a = row * columns + column, b = a + 1, c = a + columns, d = c + 1;
    triangles.push(a, b, c, b, d, c);
  }
  return triangles;
}

function grid(columns, rows) {
  return { columns, rows };
}

const sourceRest = gridPoints(5, 7); // 35 points
const sourceTriangles = gridTriangles(5, 7);
const targetRest = gridPoints(13, 13); // 169 points
const targetTriangles = gridTriangles(13, 13);
const poseKeys = [-1, 0, 1];

function makePoses(displacement, rest = sourceRest) {
  return poseKeys.flatMap((y) => poseKeys.map((x) => ({
    x, y,
    points: rest.map(([px, py]) => {
      if (x === 0 && y === 0) return [px, py];
      const [dx, dy] = displacement(px, py, x, y);
      return [px + dx, py + dy];
    }),
  })));
}

function baseInput(overrides = {}) {
  return {
    source: { coordinateSystemId: 'synthetic/xy-v1', grid: grid(5, 7), points: sourceRest.map((point) => point.slice()), triangles: sourceTriangles.slice() },
    target: { coordinateSystemId: 'synthetic/xy-v1', grid: grid(13, 13), points: targetRest.map((point) => point.slice()), triangles: targetTriangles.slice() },
    poses: makePoses((px, py, x, y) => [0.05 * x + 0.03 * y, -0.04 * x + 0.02 * y]),
    intermediateSamples: [{ x: -0.25, y: 0.25 }, { x: 0.25, y: -0.25 }],
    ...overrides,
  };
}

test('reprojects 35-point source to 169-point target with exact constant displacement', () => {
  const result = reprojectWebGrid(baseInput());
  assert.equal(result.source.pointCount, 35);
  assert.equal(result.target.pointCount, 169);
  assert.deepEqual(result.poses.find((pose) => pose.x === 0 && pose.y === 0).deltas[168], [0, 0]);
  for (const pose of result.poses) {
    if (pose.x === 0 && pose.y === 0) continue;
    const expected = [0.05 * pose.x + 0.03 * pose.y, -0.04 * pose.x + 0.02 * pose.y];
    for (const delta of pose.deltas) assert.ok(Math.abs(delta[0] - expected[0]) < 1e-14 && Math.abs(delta[1] - expected[1]) < 1e-14);
  }
  assert.equal(result.validation.samples.length, 11);
  assert.equal(result.validation.finiteSampledOnly, true);
  assert.equal(result.validation.continuousDomainGuarantee, false);
});

test('barycentric reprojection preserves an affine displacement exactly', () => {
  const displacement = (px, py, x, y) => [x * (0.03 + 0.11 * px + 0.07 * py), y * (-0.02 + 0.05 * px - 0.09 * py)];
  const result = reprojectWebGrid(baseInput({ poses: makePoses(displacement) }));
  for (const pose of result.poses) {
    const expected = displacement(targetRest[120][0], targetRest[120][1], pose.x, pose.y);
    assert.ok(Math.abs(pose.deltas[120][0] - expected[0]) < 1e-14);
    assert.ok(Math.abs(pose.deltas[120][1] - expected[1]) < 1e-14);
  }
  assert.ok(result.validation.samples.every((sample) => sample.triangleCount === targetTriangles.length / 3
    && Number.isFinite(sample.minimumArea) && Number.isFinite(sample.maximumArea)));
});

test('handles ascending and descending source axes at minimum, maximum, and interior boundaries', () => {
  const target = {
    coordinateSystemId: 'synthetic/xy-v1',
    points: [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0.5]],
    triangles: [0, 1, 4, 0, 4, 2, 1, 3, 4, 2, 4, 3],
  };
  for (const descending of [false, true]) {
    const rest = descending ? sourceRest.map(([x, y]) => [1 - x, 1 - y]) : sourceRest.map((point) => point.slice());
    const result = reprojectWebGrid(baseInput({
      source: { coordinateSystemId: 'synthetic/xy-v1', grid: grid(5, 7), points: rest, triangles: sourceTriangles.slice() },
      target,
      poses: makePoses((_px, _py, x, y) => [0.01 * x, -0.02 * y], rest),
      intermediateSamples: [],
    }));
    for (const pose of result.poses) {
      const expected = [0.01 * pose.x, -0.02 * pose.y];
      for (const delta of pose.deltas) assert.ok(Math.abs(delta[0] - expected[0]) < 1e-14 && Math.abs(delta[1] - expected[1]) < 1e-14);
    }
  }
});

test('does not mutate inputs and returns review-only frozen data', () => {
  const input = baseInput();
  const before = JSON.stringify(input);
  const result = reprojectWebGrid(input);
  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.poses[0].points), true);
  assert.match(result.validation.note, /不是自動 patch/);
});

test('requires a unique complete nine-pose grid and exact neutral identity', () => {
  const poses = makePoses(() => [0, 0]);
  assert.throws(() => reprojectWebGrid(baseInput({ poses: poses.slice(1) })), /完整且唯一/);
  assert.throws(() => reprojectWebGrid(baseInput({ poses: [...poses.slice(0, 8), poses[0]] })), /重複格點/);
  const neutralMismatch = baseInput();
  neutralMismatch.poses.find((pose) => pose.x === 0 && pose.y === 0).points[0][0] += 1e-12;
  assert.throws(() => reprojectWebGrid(neutralMismatch), /neutral pose point/);
});

test('fails closed for coordinate mismatch, out-of-bounds target, and uncovered holes', () => {
  const otherTarget = { ...baseInput().target, coordinateSystemId: 'other/xy-v1' };
  assert.throws(() => reprojectWebGrid(baseInput({ target: otherTarget })), /coordinateSystemId 不一致/);
  const outsideTarget = { points: [[2, 2], [3, 2], [2, 3], [3, 3]], triangles: [0, 1, 2, 1, 3, 2], grid: grid(2, 2), coordinateSystemId: 'synthetic/xy-v1' };
  assert.throws(() => reprojectWebGrid(baseInput({ target: outsideTarget })), /strict triangle coverage/);
  const holeSource = { points: sourceRest.map((point) => point.slice()), triangles: gridTriangles(5, 7, [[1, 2], [2, 2], [1, 3], [2, 3]]), grid: grid(5, 7), coordinateSystemId: 'synthetic/xy-v1' };
  assert.throws(() => reprojectWebGrid(baseInput({ source: holeSource })), /恰好有兩個 triangle/);
});

test('requires explicit rectangular topology, one diagonal, and consistent winding', () => {
  const missingCell = baseInput({ source: {
    ...baseInput().source,
    triangles: gridTriangles(5, 7, [1, 2]),
  } });
  assert.throws(() => reprojectWebGrid(missingCell), /恰好有兩個 triangle/);

  const duplicateCell = baseInput();
  duplicateCell.source.triangles.splice(6, 6, ...duplicateCell.source.triangles.slice(0, 6));
  assert.throws(() => reprojectWebGrid(duplicateCell), /triangle index 不符合 rectangular grid/);

  const mixedDiagonal = baseInput();
  mixedDiagonal.source.triangles.splice(6, 6, 1, 2, 7, 1, 7, 6);
  assert.throws(() => reprojectWebGrid(mixedDiagonal), /不可混用 diagonal/);

  const reversedWinding = baseInput();
  reversedWinding.source.triangles.splice(6, 3, 6, 2, 1);
  assert.throws(() => reprojectWebGrid(reversedWinding), /winding 不一致/);
});

test('fails closed for degenerate, nonfinite, and over-limit geometry', () => {
  assert.throws(() => reprojectWebGrid(baseInput({ options: { minTriangleArea: 1 } })), /退化/);
  const degenerateTarget = { points: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]], triangles: [0, 1, 2, 3, 4, 5], grid: grid(3, 2), coordinateSystemId: 'synthetic/xy-v1' };
  assert.throws(() => reprojectWebGrid(baseInput({ target: degenerateTarget })), /退化/);
  const nonfinite = baseInput();
  nonfinite.source.points[0][0] = Number.NaN;
  assert.throws(() => reprojectWebGrid(nonfinite), /finite number/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxSourcePoints: 34 } })), /有限規模/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxTriangles: 1 } })), /有限規模/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxSourcePoints: DEFAULT_LIMITS.maxSourcePoints + 1 } })), /hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxPoseValidationWork: 100 } })), /pose validation work.*hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxPoseOutputPoints: 8 } })), /pose output points.*hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxPoseValidationWork: DEFAULT_LIMITS.maxPoseValidationWork + 1 } })), /hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxPoseOutputPoints: DEFAULT_LIMITS.maxPoseOutputPoints + 1 } })), /hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxIntermediateSamples: DEFAULT_LIMITS.maxIntermediateSamples + 1 } })), /hard cap/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { maxCoverageChecks: 1 } })), /coverageChecks 超出/);
  assert.throws(() => reprojectWebGrid(baseInput({ options: { coverageEpsilon: 1e-8 + Number.EPSILON } })), /coverageEpsilon/);
  const justOutside = baseInput({ target: {
    ...baseInput().target,
    points: targetRest.map(([x, y]) => [x + (x === 1 ? 2e-8 : 0), y]),
  } });
  assert.throws(() => reprojectWebGrid(justOutside), /strict triangle coverage/);
});

test('rejects oversized typed containers before copying them', () => {
  const originalArrayFrom = Array.from;
  Array.from = () => { throw new Error('unexpected typed-array copy'); };
  try {
    const oversizedPoints = new Float64Array(DEFAULT_LIMITS.maxSourcePoints + 1);
    assert.throws(() => reprojectWebGrid(baseInput({ source: {
      ...baseInput().source,
      points: oversizedPoints,
    } })), /有限規模/);

    const oversizedTriangles = new Uint32Array(DEFAULT_LIMITS.maxTriangles * 3 + 1);
    assert.throws(() => reprojectWebGrid(baseInput({ source: {
      ...baseInput().source,
      triangles: oversizedTriangles,
    } })), /有限規模/);

    const oversizedPoses = new Float64Array(10);
    assert.throws(() => reprojectWebGrid(baseInput({ poses: oversizedPoses })), /有限規模/);

    const oversizedSamples = new Float64Array(DEFAULT_LIMITS.maxIntermediateSamples + 1);
    assert.throws(() => reprojectWebGrid(baseInput({ intermediateSamples: oversizedSamples })), /有限規模/);
  } finally {
    Array.from = originalArrayFrom;
  }
});

test('checks nested triangle container size before flattening or copying rows', () => {
  const oversized = [];
  oversized.length = DEFAULT_LIMITS.maxTriangles + 1;
  oversized[0] = new Uint32Array([0, 1, 2]);
  assert.throws(() => reprojectWebGrid(baseInput({ source: {
    ...baseInput().source,
    triangles: oversized,
  } })), /有限規模/);

  const malformed = baseInput({ source: {
    ...baseInput().source,
    triangles: [0, 1],
  } });
  const originalSlice = Array.prototype.slice;
  Array.prototype.slice = () => { throw new Error('unexpected triangle copy'); };
  try {
    assert.throws(() => reprojectWebGrid(malformed), /三元組/);
  } finally {
    Array.prototype.slice = originalSlice;
  }
});

test('counts intermediate samples in the fixed output budget and preserves normal input', () => {
  const input = baseInput();
  const before = JSON.stringify(input);
  const expected = reprojectWebGrid(input);
  const withExplicitHardLimits = reprojectWebGrid(baseInput({ options: {
    maxPoseValidationWork: DEFAULT_LIMITS.maxPoseValidationWork,
    maxPoseOutputPoints: DEFAULT_LIMITS.maxPoseOutputPoints,
    maxIntermediateSamples: DEFAULT_LIMITS.maxIntermediateSamples,
  } }));
  assert.deepEqual(withExplicitHardLimits, expected);
  assert.equal(JSON.stringify(input), before);

  const oversizedOutput = baseInput({
    target: {
      coordinateSystemId: 'synthetic/xy-v1',
      grid: grid(45, 45),
      points: gridPoints(45, 45),
      triangles: gridTriangles(45, 45),
    },
    intermediateSamples: Array.from({ length: DEFAULT_LIMITS.maxIntermediateSamples }, () => ({ x: 0, y: 0 })),
  });
  assert.throws(() => reprojectWebGrid(oversizedOutput), /pose output points.*hard cap/);

  const oversizedWork = baseInput({
    target: {
      coordinateSystemId: 'synthetic/xy-v1',
      grid: grid(128, 128),
      points: gridPoints(128, 128),
      triangles: gridTriangles(128, 128),
    },
    intermediateSamples: Array.from({ length: DEFAULT_LIMITS.maxIntermediateSamples }, () => ({ x: 0, y: 0 })),
  });
  assert.throws(() => reprojectWebGrid(oversizedWork), /pose validation work.*hard cap/);
});

test('rejects a keyform that flips a target triangle and keeps valid outputs finite', () => {
  const poses = makePoses((px, py, x, y) => [0.05 * x + 0.03 * y, -0.04 * x + 0.02 * y]);
  const flipped = poses.find((pose) => pose.x === 1 && pose.y === 1);
  for (const point of flipped.points) point[0] = 1 - point[0];
  assert.throws(() => reprojectWebGrid(baseInput({ poses })), /翻面或退化/);
  const result = reprojectWebGrid(baseInput());
  for (const pose of result.poses) for (const point of pose.points) assert.ok(point.every(Number.isFinite));
});

test('reports finite sampling and can catch a fold only when the missing sample is requested', () => {
  const smallRest = gridPoints(2, 2);
  const smallTriangles = gridTriangles(2, 2);
  const poses = poseKeys.flatMap((y) => poseKeys.map((x) => ({
    x, y,
    points: smallRest.map((point) => point.slice()),
  })));
  const xMinusOne = poses.filter((pose) => pose.x === -1);
  for (const pose of xMinusOne) {
    pose.points[1] = [1, 0.5];
  }
  // 2×2 source uses point 2 as the third corner; keep the test local and synthetic.
  for (const pose of xMinusOne) pose.points[2] = [-3.571428571428571, -1.6785714285714286];
  const smallInput = {
    source: { coordinateSystemId: 'synthetic/xy-v1', grid: grid(2, 2), points: smallRest.map((point) => point.slice()), triangles: smallTriangles.slice() },
    target: { coordinateSystemId: 'synthetic/xy-v1', points: smallRest.map((point) => point.slice()), triangles: smallTriangles.slice() },
    poses,
  };
  const sampled = reprojectWebGrid(smallInput);
  assert.equal(sampled.validation.continuousDomainGuarantee, false);
  assert.throws(() => reprojectWebGrid({ ...smallInput, intermediateSamples: [{ x: -0.75, y: 0 }] }), /翻面或退化/);
});

console.log('web-grid-reproject: synthetic 35→169 constant/affine, strict coverage, neutral, limits, winding, finite, and immutability invariants passed');
