import { describe, expect, it } from "vitest";
import { assetRegistrationSchema, canonicalizeReferencePixel, mapAssetPoint, rasterizeRegisteredAsset, solveAssetRegistration } from "../src/asset-registration.js";

describe("asset registration", () => {
  it("canonicalizes only integer edges explainable by six-decimal normalized-bound storage", () => {
    const inside = 12 + 0.002;
    const outside = 12 + 0.00205;
    expect(canonicalizeReferencePixel(inside / 4096, 4096)).toBe(12);
    expect(canonicalizeReferencePixel(outside / 4096, 4096)).toBeCloseTo(outside, 12);
    expect(canonicalizeReferencePixel(outside / 4096, 4096)).not.toBe(12);
    expect(canonicalizeReferencePixel(12.25 / 4096, 4096)).toBe(12.25);
    expect(() => canonicalizeReferencePixel(12 / 4096, 0)).toThrow();
  });
  it("maps padded/resized image frames into source canvas coordinates and rejects accidental stretching", () => {
    const { matrix } = solveAssetRegistration({ kind: "frame", generatedRect: { x: 20, y: 40, width: 200, height: 100 }, sourceRect: { x: 100, y: 80, width: 100, height: 50 } }, { width: 240, height: 180 });
    expect(mapAssetPoint(matrix, { x: 20, y: 40 })).toEqual({ x: 100, y: 80 });
    expect(mapAssetPoint(matrix, { x: 220, y: 140 })).toEqual({ x: 200, y: 130 });
    expect(() => solveAssetRegistration({ kind: "frame", generatedRect: { x: 0, y: 0, width: 100, height: 100 }, sourceRect: { x: 0, y: 0, width: 100, height: 50 } }, { width: 100, height: 100 })).toThrow(/非等比/);
  });
  it("solves rotation and scale from landmarks and requires explicit reflection", () => {
    const anchors = [{ generated: { x: 10, y: 10 }, source: { x: 80, y: 30 } }, { generated: { x: 30, y: 10 }, source: { x: 80, y: 70 } }, { generated: { x: 10, y: 30 }, source: { x: 40, y: 30 } }];
    const solved = solveAssetRegistration({ kind: "landmarks", anchors, maxErrorPixels: 0.01 }, { width: 40, height: 40 });
    expect(solved.rmsErrorPixels).toBeLessThan(1e-10);
    expect(mapAssetPoint(solved.matrix, { x: 20, y: 20 }).x).toBeCloseTo(60);
    const reflected = anchors.map((anchor) => ({ ...anchor, source: { ...anchor.source, x: 120 - anchor.source.x } }));
    expect(() => solveAssetRegistration({ kind: "landmarks", anchors: reflected, maxErrorPixels: 0.01 }, { width: 40, height: 40 })).toThrow(/配准误差/);
    expect(solveAssetRegistration({ kind: "landmarks", anchors: reflected, mirrorX: true, maxErrorPixels: 0.01 }, { width: 40, height: 40 }).rmsErrorPixels).toBeLessThan(1e-10);
  });
  it("preserves premultiplied color and refuses clipping instead of silently discarding pixels", () => {
    const pixels = new Uint8Array([255, 80, 20, 128]);
    const matrix = { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 3 };
    const result = rasterizeRegisteredAsset(pixels, 1, 1, matrix, { width: 10, height: 10 });
    expect([...result.data]).toEqual([...pixels]);
    expect(result.bounds).toEqual({ x: 2, y: 3, width: 1, height: 1 });
    expect(() => rasterizeRegisteredAsset(pixels, 1, 1, { ...matrix, tx: -1 }, { width: 10, height: 10 })).toThrow(/超出角色画布/);
  });
  it("keeps alpha-cropped bounds while increasing PNG sampling density", () => {
    const pixels = new Uint8Array(4 * 2 * 4);
    for (let y = 0; y < 2; y++) for (let x = 1; x <= 2; x++) pixels[(y * 4 + x) * 4 + 3] = 255;
    const input = { kind: "frame" as const, generatedRect: { x: 0, y: 0, width: 4, height: 2 }, sourceRect: { x: 10, y: 12, width: 4, height: 2 }, textureScale: 1, preserveFrame: true };
    const solved = solveAssetRegistration(input, { width: 4, height: 2 });
    const one = rasterizeRegisteredAsset(pixels, 4, 2, solved.matrix, { width: 30, height: 30 });
    const two = rasterizeRegisteredAsset(pixels, 4, 2, solved.matrix, { width: 30, height: 30 }, { textureScale: 2 });
    const preserved = rasterizeRegisteredAsset(pixels, 4, 2, solved.matrix, { width: 30, height: 30 }, { textureScale: 2, preserveFrame: true, frameBounds: input.sourceRect });
    expect(one.bounds).toEqual(two.bounds);
    expect(preserved.bounds).toEqual(input.sourceRect);
    expect([one.width, one.height]).toEqual([one.bounds.width, one.bounds.height]);
    expect([two.width, two.height]).toEqual([one.bounds.width * 2, one.bounds.height * 2]);
    expect([preserved.width, preserved.height]).toEqual([8, 4]);
    expect(solved.rmsErrorPixels).toBe(0);
    expect(mapAssetPoint(solved.matrix, { x: 1, y: 1 })).toEqual({ x: 11, y: 13 });
  });
  it("validates density opt-in, limits the pixel budget, and keeps landmarks density-independent", () => {
    const frame = { kind: "frame", generatedRect: { x: 0, y: 0, width: 2, height: 2 }, sourceRect: { x: 0, y: 0, width: 2, height: 2 } };
    expect(assetRegistrationSchema.parse(frame)).toMatchObject({ textureScale: 1, preserveFrame: false });
    for (const textureScale of [0, 1.5, 5]) expect(() => assetRegistrationSchema.parse({ ...frame, textureScale })).toThrow();
    const landmarks = { kind: "landmarks" as const, anchors: [{ generated: { x: 0, y: 0 }, source: { x: 0, y: 0 } }, { generated: { x: 1, y: 0 }, source: { x: 1, y: 0 } }] };
    expect(assetRegistrationSchema.parse(landmarks)).toMatchObject({ textureScale: 1 });
    expect(assetRegistrationSchema.parse({ ...landmarks, textureScale: 2 })).toMatchObject({ textureScale: 2 });
    expect(() => assetRegistrationSchema.parse({ ...landmarks, textureScale: 5 })).toThrow();
    expect(() => assetRegistrationSchema.parse({ ...landmarks, preserveFrame: true })).toThrow();
    expect(() => rasterizeRegisteredAsset(new Uint8Array([0, 0, 0, 255]), 1, 1, { a: 100000, b: 0, c: 0, d: 1, tx: 0, ty: 0 }, { width: 100000, height: 1 }, { textureScale: 4 })).toThrow(/尺寸預算/);
    const anchors = [{ generated: { x: 1, y: 1 }, source: { x: 3, y: 4 } }, { generated: { x: 2, y: 1 }, source: { x: 5, y: 4 } }, { generated: { x: 1, y: 2 }, source: { x: 3, y: 6 } }];
    const solved = solveAssetRegistration({ kind: "landmarks", anchors }, { width: 4, height: 4 });
    expect(solved.rmsErrorPixels).toBeLessThan(1e-10);
    expect(solved.matrix.a).toBeCloseTo(2);
    expect(solved.matrix.d).toBeCloseTo(2);
    expect(solved.matrix.b).toBeCloseTo(0);
    expect(solved.matrix.c).toBeCloseTo(0);
    expect(solved.matrix.tx).toBeCloseTo(1);
    expect(solved.matrix.ty).toBeCloseTo(2);
  });
});
