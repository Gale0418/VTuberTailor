import { describe, expect, it } from "vitest";
import { meshPointAtUv, meshPointAtUvContinuous, reprojectMeshInfluences } from "../src/mesh.js";
import type { MeshBinding } from "../src/types.js";

describe("mesh influence reprojection", () => {
  it("clamps small silhouette extrapolations to the valid influence range", () => {
    const source: MeshBinding = {
      topology: "art",
      points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      triangles: [0, 1, 2],
      influences: {
        physics: [0, 1, 1],
        pin: [1, 0, 0]
      }
    };
    const target: MeshBinding = {
      topology: "art",
      points: [{ x: 0.6, y: 0.6 }],
      uvs: [{ x: 0.6, y: 0.6 }],
      triangles: []
    };

    const projected = reprojectMeshInfluences(source, target);

    expect(projected.physics).toEqual([1]);
    expect(projected.pin).toEqual([0]);
    expect(Object.values(projected).flat().every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});

describe("continuous dynamic surface sampling", () => {
  it("replaces the affine-to-edge jump with a bounded transition", () => {
    const mesh: MeshBinding = {
      topology: "art",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 1 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }],
      triangles: [0, 1, 2]
    };
    const beforeLimit = { x: -0.35 + 1e-7, y: 0.5 };
    const afterLimit = { x: -0.35 - 1e-7, y: 0.5 };
    const legacyJump = Math.abs(meshPointAtUv(mesh, beforeLimit).x - meshPointAtUv(mesh, afterLimit).x);
    const smoothJump = Math.abs(meshPointAtUvContinuous(mesh, beforeLimit).x - meshPointAtUvContinuous(mesh, afterLimit).x);

    expect(legacyJump).toBeGreaterThan(1);
    expect(smoothJump).toBeLessThan(1e-4);
    expect(meshPointAtUvContinuous(mesh, { x: -0.2, y: 0.5 }).x).toBeCloseTo(-2, 8);
    expect(meshPointAtUvContinuous(mesh, { x: -10, y: 0.5 })).toEqual({ x: 0, y: 0.5 });

    for (const uv of [{ x: -100, y: -100 }, { x: 100, y: 100 }, { x: -1, y: 0.5 }, { x: 2, y: 0.5 }]) {
      const point = meshPointAtUvContinuous(mesh, uv);
      expect(Number.isFinite(point.x) && Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(10);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(1);
    }
  });

  it("stays continuous when adjacent triangle boundaries change the nearest edge", () => {
    const mesh: MeshBinding = {
      topology: "grid",
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 20 }, { x: 100, y: 100 }],
      uvs: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }],
      triangles: [0, 1, 2, 1, 3, 2]
    };
    const point = (x: number, y: number) => meshPointAtUvContinuous(mesh, { x, y });
    const closeAcross = (left: { x: number; y: number }, right: { x: number; y: number }) =>
      Math.hypot(point(left.x, left.y).x - point(right.x, right.y).x,
        point(left.x, left.y).y - point(right.x, right.y).y);

    // Crosses the authored surface boundary at the top edge.
    expect(closeAcross({ x: 1.218, y: -1e-7 }, { x: 1.218, y: 1e-7 })).toBeLessThan(1e-4);
    // Crosses the top/right nearest-edge bisector with deliberately nonlinear
    // vertex values, where selecting only one triangle produces a visible jump.
    expect(closeAcross({ x: 1.218, y: 0.218 - 1e-7 }, { x: 1.218, y: 0.218 + 1e-7 })).toBeLessThan(1e-4);
  });
});
