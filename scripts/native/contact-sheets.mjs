import { join } from 'node:path';

/**
 * Render the selected nativeQA frames over the diagnostic backgrounds.
 * The frame bytes are read only; this helper writes contact sheets separately.
 */
export async function writeContactSheets({ sharp, framesDir, rendered, output }) {
  const contacts = {};
  for (const background of ['white', '#242424', '#00ff00']) {
    const label = background === 'white' ? 'white' : background === '#242424' ? 'dark' : 'green';
    const cell = 256, cols = 4, rows = Math.ceil(rendered.length / cols), comps = [];
    for (let i = 0; i < rendered.length; i++) {
      const png = await sharp(join(framesDir, rendered[i].filename))
        .flatten({ background })
        .resize(cell, cell, { fit: 'contain', background })
        .png()
        .toBuffer();
      comps.push({ input: png, left: (i % cols) * cell, top: Math.floor(i / cols) * cell });
    }
    const path = join(output, `contact-${label}.png`);
    await sharp({ create: { width: cols * cell, height: rows * cell, channels: 4, background } })
      .composite(comps)
      .png()
      .toFile(path);
    contacts[label] = `contact-${label}.png`;
  }
  return contacts;
}
