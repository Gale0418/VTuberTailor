import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { packCubismAtlas } from '../src/cubism-atlas.js';

describe('Cubism source texture atlas', () => {
  it('keeps asymmetric small layers at full scale, without overwriting earlier layers', async () => {
    const rgba = Buffer.alloc(25 * 9 * 4);
    for (let i = 0; i < 25 * 9; i++) {
      rgba.set([i % 25 * 10, Math.floor(i / 25) * 28, 255, 255], i * 4);
    }
    const mouth = await sharp(rgba, { raw: { width: 25, height: 9, channels: 4 } }).png().toBuffer();
    const face = await sharp({ create: { width: 198, height: 185, channels: 4, background: '#ff8040' } }).png().toBuffer();
    const result = await packCubismAtlas([{ id: 'mouth', png: mouth }, { id: 'face', png: face }], 256);
    expect(result.size).toBe(256);
    for (const [id, png] of [['mouth', mouth], ['face', face]] as const) {
      const p = result.placements.get(id)!;
      const pixels = await sharp(result.pngs[p.page]).extract({ left: p.x, top: p.y, width: p.width, height: p.height }).raw().toBuffer();
      expect(pixels).toEqual(await sharp(png).raw().toBuffer());
    }
    expect([...result.placements.values()].every(p => p.x >= 16 && p.y >= 16)).toBe(true);
  });

  it('accepts explicit 4px padding and preserves every source alpha and visible RGB byte', async () => {
    const width = 5, height = 3;
    const source = Buffer.alloc(width * height * 4);
    for (let i = 0; i < width * height; i += 1) source.set([0, 0, 0, 0], i * 4);
    source.set([221, 142, 93, 255], (1 * width + 1) * 4);
    source.set([87, 64, 42, 128], (1 * width + 2) * 4);
    source.set([9, 16, 25, 1], (1 * width + 3) * 4);
    const png = await sharp(source, { raw: { width, height, channels: 4 } }).png().toBuffer();
    const result = await packCubismAtlas([{ id: 'skin-context', png }], 256, 4);
    const placement = result.placements.get('skin-context')!;
    expect(placement.x).toBe(4);
    expect(placement.y).toBe(4);
    const page = await sharp(result.pngs[placement.page]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => Buffer.from(page.data.subarray((y * result.size + x) * 4, (y * result.size + x) * 4 + 4));

    for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
      const original = source.subarray((y * width + x) * 4, (y * width + x) * 4 + 4);
      const packed = at(placement.x + x, placement.y + y);
      expect(packed[3]).toBe(original[3]);
      if (original[3]! > 0) expect(packed.subarray(0, 3)).toEqual(original.subarray(0, 3));
    }
    // Alpha-zero neighbors and the 4px external gutter inherit local skin RGB.
    expect(at(placement.x, placement.y)).toEqual(Buffer.from([221, 142, 93, 0]));
    expect(at(placement.x + 2, placement.y + 1)).toEqual(Buffer.from([87, 64, 42, 128]));
    expect(at(placement.x + 1, placement.y + 1)).toEqual(Buffer.from([221, 142, 93, 255]));
    expect(at(placement.x - 1, placement.y + 1)).toEqual(Buffer.from([221, 142, 93, 0]));
    expect(at(placement.x + width, placement.y + 1)).toEqual(Buffer.from([87, 64, 42, 0]));
    expect(at(placement.x - 3, placement.y - 3)).toEqual(Buffer.from([221, 142, 93, 0]));
    expect([...result.placements.values()].every(p => p.x >= 4 && p.y >= 4)).toBe(true);
  });

  it('keeps edge colors isolated between adjacent sprites and reduces a minified gray edge', async () => {
    const makeSprite = (color: [number, number, number]) => {
      const pixels = Buffer.alloc(4 * 4 * 4);
      for (let i = 0; i < 16; i += 1) pixels.set([0, 0, 0, 0], i * 4);
      pixels.set([...color, 255], 0);
      return sharp(pixels, { raw: { width: 4, height: 4, channels: 4 } }).png().toBuffer();
    };
    const redPng = await makeSprite([240, 200, 180]);
    const bluePng = await makeSprite([40, 80, 240]);
    const result = await packCubismAtlas([{ id: 'red', png: redPng }, { id: 'blue', png: bluePng }], 256);
    const decoded = await sharp(result.pngs[0]).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x: number, y: number) => Buffer.from(decoded.data.subarray((y * result.size + x) * 4, (y * result.size + x) * 4 + 4));
    const red = result.placements.get('red')!;
    const blue = result.placements.get('blue')!;
    expect(red.page).toBe(blue.page);
    expect(pixel(red.x - 1, red.y)).toEqual(Buffer.from([240, 200, 180, 0]));
    expect(pixel(blue.x - 1, blue.y)).toEqual(Buffer.from([40, 80, 240, 0]));

    // A 2x2 straight-channel minification footprint has one visible texel and
    // three transparent texels. Compare the actual packed RGBA pixels using
    // the same independent-channel average the mip level stores.
    const source = await sharp(redPng).ensureAlpha().raw().toBuffer();
    const packed = Buffer.alloc(4 * 4 * 4);
    for (let y = 0; y < 4; y += 1) for (let x = 0; x < 4; x += 1) {
      packed.set(pixel(red.x + x, red.y + y), (y * 4 + x) * 4);
    }
    const compositeOverWhite = (rgba: Buffer) => Math.round((rgba[0]! / 255) * (rgba[3]! / 255) * 255 + 255 * (1 - rgba[3]! / 255));
    const averaged = (pixels: Buffer) => {
      const rgba = [0, 0, 0, 0];
      for (const index of [0, 1, 4, 5]) for (let channel = 0; channel < 4; channel += 1) rgba[channel]! += pixels[index * 4 + channel]! / 4;
      return Buffer.from(rgba.map(Math.round));
    };
    const sourceMipSample = compositeOverWhite(averaged(source));
    const packedMipSample = compositeOverWhite(averaged(packed));
    expect(sourceMipSample).toBeLessThan(220);
    expect(packedMipSample).toBeGreaterThan(245);
    expect(packedMipSample - sourceMipSample).toBeGreaterThan(25);
  });

  it('splits full pages and deterministically preserves every layer', async () => {
    const png = await sharp({ create: { width: 240, height: 240, channels: 4, background: '#ffffff' } }).png().toBuffer();
    const result = await packCubismAtlas([{ id: 'b', png }, { id: 'a', png }], 256);
    expect(result.pngs).toHaveLength(2);
    expect(result.placements.get('a')?.page).toBe(0);
    expect(result.placements.get('b')?.page).toBe(1);
    expect([...result.placements.values()].every(p => p.x >= 16 && p.y >= 16)).toBe(true);
    await expect(packCubismAtlas([], 358)).rejects.toThrow('二次幂');
    const pixel = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ffffff' } }).png().toBuffer();
    await expect(packCubismAtlas([{ id: 'negative-padding', png: pixel }], 256, -1)).rejects.toThrow('padding 必须是非负整数');
    await expect(packCubismAtlas([{ id: 'fractional-padding', png: pixel }], 256, 1.5)).rejects.toThrow('padding 必须是非负整数');
  });
});
