import sharp from 'sharp';

/** PSD2Live AtlasPacker's deterministic shelf layout, with unscaled source pixels.
 * See THIRD_PARTY_NOTICES.md. Cubism atlas dimensions must be powers of two:
 * the Editor otherwise normalizes UVs to a padded size without padding the PNG.
 */
const DEFAULT_PADDING = 16;
const EDGE_SEED_ALPHA = 8;

interface AtlasRaster {
  id: string;
  width: number;
  height: number;
  pixels: Buffer;
}

interface AtlasPlacement {
  page: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Copy only RGB into transparent texels near this sprite's own visible pixels.
 * Alpha and every nontransparent source pixel remain byte-identical. The
 * padded tile is processed in isolation, so a neighboring sprite cannot seed
 * or contaminate its edge colors. An 8-neighbor BFS uses Chebyshev pixel
 * distance, matching the square padded gutter.
 */
function dilateTransparentRgb(sprite: AtlasRaster, padding: number): Buffer {
  const width = sprite.width + padding * 2;
  const height = sprite.height + padding * 2;
  const pixels = Buffer.alloc(width * height * 4);
  for (let row = 0; row < sprite.height; row += 1) {
    const sourceStart = row * sprite.width * 4;
    const targetStart = ((row + padding) * width + padding) * 4;
    sprite.pixels.copy(pixels, targetStart, sourceStart, sourceStart + sprite.width * 4);
  }

  const length = width * height;
  const visited = new Uint8Array(length);
  const owner = new Uint32Array(length);
  const queue = new Uint32Array(length);
  let tail = 0;
  const alphaAt = (index: number) => pixels[index * 4 + 3]!;
  // Alpha >= 8 excludes barely visible antialias noise as a color seed. A
  // sprite with no such pixel falls back to alpha >= 1 rather than staying
  // black when it contains only intentionally translucent art.
  const hasStrongSeed = pixels.some((_, index) => index % 4 === 3 && pixels[index]! >= EDGE_SEED_ALPHA);
  const seedAlpha = hasStrongSeed ? EDGE_SEED_ALPHA : 1;
  const enqueueSeed = (index: number) => {
    if (visited[index]) return;
    visited[index] = 1;
    queue[tail++] = index;
  };

  // Begin from visible boundary pixels only; interior opaque pixels cannot be
  // the nearest seed for a transparent texel. Alpha 1..7 pixels count as the
  // fringe boundary for strong seeds, but remain unmodified and traversable.
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = y * width + x;
      if (alphaAt(index) < seedAlpha) continue;
      let bordersTransparency = false;
      for (let dy = -1; dy <= 1 && !bordersTransparency; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height || alphaAt(ny * width + nx) < seedAlpha) {
            bordersTransparency = true;
            break;
          }
        }
      }
      if (bordersTransparency) enqueueSeed(index);
      if (visited[index]) owner[index] = index;
    }
  }

  // Multi-source 8-neighbor flood fill. `distance` is stored in a parallel
  // byte array; `owner` carries seed RGB through a low-alpha fringe without
  // rewriting any nonzero-alpha pixel.
  const distance = new Uint8Array(length);
  for (let head = 0; head < tail; head += 1) {
    const index = queue[head]!;
    const nextDistance = distance[index]! + 1;
    if (nextDistance > padding) continue;
    const x = index % width;
    const y = Math.floor(index / width);
    for (let dy = -1; dy <= 1; dy += 1) {
      const ny = y + dy;
      if (ny < 0 || ny >= height) continue;
      for (let dx = -1; dx <= 1; dx += 1) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        if (nx < 0 || nx >= width) continue;
        const neighbor = ny * width + nx;
        if (visited[neighbor] || alphaAt(neighbor) >= seedAlpha) continue;
        visited[neighbor] = 1;
        distance[neighbor] = nextDistance;
        owner[neighbor] = owner[index]!;
        const from = owner[index]! * 4;
        const to = neighbor * 4;
        if (alphaAt(neighbor) === 0) {
          pixels[to] = pixels[from]!;
          pixels[to + 1] = pixels[from + 1]!;
          pixels[to + 2] = pixels[from + 2]!;
        }
        queue[tail++] = neighbor;
      }
    }
  }

  return pixels;
}

export async function packCubismAtlas(items: { id: string; png: Buffer }[], requestedSize = 2048, padding = DEFAULT_PADDING) {
  if (!Number.isInteger(requestedSize) || requestedSize < 256 || requestedSize > 16384 || (requestedSize & (requestedSize - 1))) {
    throw new Error('Cubism 纹理图集尺寸必须是 256 到 16384 之间的二次幂。');
  }
  if (!Number.isInteger(padding) || padding < 0) {
    throw new Error('Cubism atlas padding 必须是非负整数。');
  }
  const rasters = await Promise.all(items.map(async item => {
    const decoded = await sharp(item.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    if (!decoded.info.width || !decoded.info.height) throw new Error(`${item.id} 缺少图像尺寸`);
    return {
      id: item.id,
      width: decoded.info.width,
      height: decoded.info.height,
      pixels: decoded.data,
    } satisfies AtlasRaster;
  }));
  rasters.sort((a, b) => b.height - a.height || b.width - a.width || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const largest = Math.max(requestedSize, ...rasters.map(item => Math.max(item.width, item.height) + padding * 2));
  const size = 2 ** Math.ceil(Math.log2(largest));
  if (size > 16384) throw new Error('图层超过 Cubism 图集容量，未缩小原画。');

  const pages: Buffer[] = [Buffer.alloc(size * size * 4)];
  const placements = new Map<string, AtlasPlacement>();
  let pageIndex = 0;
  let x = padding;
  let y = padding;
  let rowHeight = 0;
  for (const item of rasters) {
    if (x + item.width + padding > size) {
      x = padding;
      y += rowHeight + padding * 2;
      rowHeight = 0;
    }
    if (y + item.height + padding > size) {
      pages.push(Buffer.alloc(size * size * 4));
      pageIndex += 1;
      x = padding;
      y = padding;
      rowHeight = 0;
    }

    const paddedPixels = dilateTransparentRgb(item, padding);
    const paddedWidth = item.width + padding * 2;
    const paddedHeight = item.height + padding * 2;
    const page = pages[pageIndex]!;
    const tileX = x - padding;
    const tileY = y - padding;
    for (let row = 0; row < paddedHeight; row += 1) {
      const sourceStart = row * paddedWidth * 4;
      const targetStart = ((tileY + row) * size + tileX) * 4;
      paddedPixels.copy(page, targetStart, sourceStart, sourceStart + paddedWidth * 4);
    }

    placements.set(item.id, { page: pageIndex, x, y, width: item.width, height: item.height });
    x += item.width + padding * 2;
    rowHeight = Math.max(rowHeight, item.height);
  }

  const pngs: Buffer[] = [];
  for (const page of pages) {
    pngs.push(await sharp(page, { raw: { width: size, height: size, channels: 4 } }).png().toBuffer());
  }
  return { size, placements, pngs };
}
