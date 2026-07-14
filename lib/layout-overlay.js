/**
 * layout-overlay — render human-review overlays for the text-layout audit.
 *
 * On top of each full-page screenshot we draw two sets of boxes: the SOURCE
 * text boxes in green (at source coords) and the TARGET text boxes in red (at
 * target coords), each with its index label (source index to the LEFT, target
 * index to the RIGHT) and a polyline connecting consecutive boxes bottom-right →
 * top-left. Where a green and a red mark overlap the pixel is drawn BLUE, so a
 * perfectly-aligned (non-drifting) match reads as blue while drift shows as
 * separated green/red. The same green+red overlay is composited over both the
 * source and the target screenshot (only the background differs).
 */

const sharp = require('sharp');

function esc(s) {
  return String(s).replace(/[<&>]/g, (c) => ({ '<': '&lt;', '&': '&amp;', '>': '&gt;' }[c]));
}

/** SVG (transparent) of one colour's boxes + index labels + connector polyline. */
function layerSvg(items, color, side, width, height) {
  const parts = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
  ];
  for (let i = 1; i < items.length; i++) {
    const a = items[i - 1];
    const b = items[i];
    parts.push(
      `<line x1="${a.x + a.w}" y1="${a.y + a.h}" x2="${b.x}" y2="${b.y}" stroke="${color}" stroke-width="1"/>`
    );
  }
  for (const it of items) {
    parts.push(
      `<rect x="${it.x}" y="${it.y}" width="${it.w}" height="${it.h}" fill="none" stroke="${color}" stroke-width="2"/>`
    );
    const lx = side === 'left' ? Math.max(2, it.x - 3) : Math.min(width - 2, it.x + it.w + 3);
    const anchor = side === 'left' ? 'end' : 'start';
    parts.push(
      `<text x="${lx}" y="${it.y + Math.min(it.h, 13)}" font-family="monospace" font-size="12" font-weight="bold" fill="${color}" text-anchor="${anchor}">${esc(it.idx)}</text>`
    );
  }
  parts.push('</svg>');
  return parts.join('');
}

/**
 * Combine the green (source) and red (target) layers with blue-on-overlap, then
 * composite over `screenshotBuf`. Rendered at the screenshot's own dimensions.
 */
async function composeOverlay(screenshotBuf, sourceItems, targetItems) {
  const meta = await sharp(screenshotBuf).metadata();
  const W = meta.width;
  const H = meta.height;
  const greenSvg = layerSvg(sourceItems, '#00ff00', 'left', W, H);
  const redSvg = layerSvg(targetItems, '#ff0000', 'right', W, H);
  const [g, r] = await Promise.all([
    sharp(Buffer.from(greenSvg)).resize(W, H).ensureAlpha().raw().toBuffer(),
    sharp(Buffer.from(redSvg)).resize(W, H).ensureAlpha().raw().toBuffer(),
  ]);
  const px = W * H;
  const out = Buffer.alloc(px * 4);
  for (let p = 0; p < px; p++) {
    const i = p * 4;
    const ga = g[i + 3];
    const ra = r[i + 3];
    if (ga > 24 && ra > 24) {
      out[i] = 0;
      out[i + 1] = 0;
      out[i + 2] = 255;
      out[i + 3] = 255; // blue where both mark (aligned)
    } else if (ga > 24) {
      out[i + 1] = 255;
      out[i + 3] = 255; // green (source)
    } else if (ra > 24) {
      out[i] = 255;
      out[i + 3] = 255; // red (target)
    }
  }
  const overlay = await sharp(out, { raw: { width: W, height: H, channels: 4 } }).png().toBuffer();
  return sharp(screenshotBuf).composite([{ input: overlay, top: 0, left: 0 }]).png().toBuffer();
}

/**
 * Write source-overlay.png and target-overlay.png.
 * @param {{ sourceBuf: Buffer, targetBuf: Buffer, alignment: {source,target}, outDir: string }} o
 */
async function renderLayoutOverlays(o) {
  const { sourceBuf, targetBuf, alignment, outDir } = o;
  const srcOverlay = await composeOverlay(sourceBuf, alignment.source, alignment.target);
  const tgtOverlay = await composeOverlay(targetBuf, alignment.source, alignment.target);
  const path = require('path');
  const srcPath = path.join(outDir, 'source-overlay.png');
  const tgtPath = path.join(outDir, 'target-overlay.png');
  await sharp(srcOverlay).toFile(srcPath);
  await sharp(tgtOverlay).toFile(tgtPath);
  return { srcPath, tgtPath };
}

module.exports = { layerSvg, composeOverlay, renderLayoutOverlays };
