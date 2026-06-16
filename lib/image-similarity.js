/**
 * Downscaled pixel comparison for full-page PNG buffers (local screening).
 */

const sharp = require('sharp');
const pixelmatch = require('pixelmatch');

const DEFAULT_COMPARE_WIDTH = 512;
const DEFAULT_MAX_LONG_EDGE = 1024;
const PAD_COLOR = { r: 200, g: 200, b: 200, alpha: 255 };

/**
 * @param {Buffer} buffer
 * @param {number} targetWidth
 * @param {number} maxLongEdge
 * @returns {Promise<{ data: Buffer, width: number, height: number }>}
 */
async function resizeForCompare(buffer, targetWidth, maxLongEdge) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const longEdge = Math.max(w, h);
  let scale = targetWidth / w;
  if (longEdge * scale > maxLongEdge) {
    scale = maxLongEdge / longEdge;
  }
  const vw = Math.max(1, Math.round(w * scale));
  const vh = Math.max(1, Math.round(h * scale));
  const { data, info } = await sharp(buffer)
    .resize(vw, vh, { fit: 'inside' })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

/**
 * Pad two images to the same canvas size (letterbox).
 * @param {{ data: Buffer, width: number, height: number }} a
 * @param {{ data: Buffer, width: number, height: number }} b
 */
function padToSameSize(a, b) {
  const width = Math.max(a.width, b.width);
  const height = Math.max(a.height, b.height);

  async function padOne(img) {
    if (img.width === width && img.height === height) {
      return img.data;
    }
    return sharp(img.data, {
      raw: { width: img.width, height: img.height, channels: 4 },
    })
      .extend({
        top: 0,
        bottom: height - img.height,
        left: 0,
        right: width - img.width,
        background: PAD_COLOR,
      })
      .ensureAlpha()
      .raw()
      .toBuffer();
  }

  return Promise.all([padOne(a), padOne(b)]).then(([dataA, dataB]) => ({
    dataA,
    dataB,
    width,
    height,
  }));
}

/**
 * @param {Buffer} sourceBuffer
 * @param {Buffer} targetBuffer
 * @param {{ compareWidth?: number, maxLongEdge?: number }} [opts]
 * @returns {Promise<{ similarity: number, diffRatio: number, compareWidth: number, compareHeight: number, ms: number }>}
 */
async function compareImages(sourceBuffer, targetBuffer, opts = {}) {
  const t0 = Date.now();
  const compareWidth = opts.compareWidth ?? DEFAULT_COMPARE_WIDTH;
  const maxLongEdge = opts.maxLongEdge ?? DEFAULT_MAX_LONG_EDGE;

  const [imgA, imgB] = await Promise.all([
    resizeForCompare(sourceBuffer, compareWidth, maxLongEdge),
    resizeForCompare(targetBuffer, compareWidth, maxLongEdge),
  ]);

  const { dataA, dataB, width, height } = await padToSameSize(imgA, imgB);
  const diff = Buffer.alloc(width * height * 4);
  const diffPixels = pixelmatch(dataA, dataB, diff, width, height, {
    threshold: 0.1,
    includeAA: true,
  });
  const total = width * height;
  const diffRatio = total > 0 ? diffPixels / total : 0;
  const similarity = 1 - diffRatio;

  return {
    similarity,
    diffRatio,
    compareWidth: width,
    compareHeight: height,
    ms: Date.now() - t0,
  };
}

module.exports = {
  compareImages,
  DEFAULT_COMPARE_WIDTH,
  DEFAULT_MAX_LONG_EDGE,
};
