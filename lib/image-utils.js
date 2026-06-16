const sharp = require('sharp');

const DEFAULT_MAX_LONG_EDGE = 1568;
/** Default max long edge for source crop image in match step (full target uses DEFAULT_MAX_LONG_EDGE unless overridden). */
const DEFAULT_MATCH_CROP_MAX_EDGE = 800;

function clampVisionEdgePx(parsed, fallback) {
  if (parsed == null || parsed === '') return fallback;
  const n = parseInt(String(parsed), 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(4096, Math.max(256, n));
}

/**
 * Env / overrides for vision API image downsampling (fewer pixels → faster/cheaper calls).
 * PPD_VISION_MAX_LONG_EDGE applies to segment + match target when specific vars unset.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {{ segmentMaxEdge?: string|number, matchTargetMaxEdge?: string|number, matchCropMaxEdge?: string|number }} [overrides]
 */
function resolveVisionMaxEdges(env = process.env, overrides = {}) {
  const fb = DEFAULT_MAX_LONG_EDGE;
  return {
    segmentMaxEdge: clampVisionEdgePx(
      overrides.segmentMaxEdge ?? env.PPD_SEGMENT_VISION_MAX_EDGE ?? env.PPD_VISION_MAX_LONG_EDGE,
      fb
    ),
    matchTargetMaxEdge: clampVisionEdgePx(
      overrides.matchTargetMaxEdge ?? env.PPD_MATCH_TARGET_MAX_EDGE ?? env.PPD_VISION_MAX_LONG_EDGE,
      fb
    ),
    matchCropMaxEdge: clampVisionEdgePx(
      overrides.matchCropMaxEdge ?? env.PPD_MATCH_CROP_MAX_EDGE,
      DEFAULT_MATCH_CROP_MAX_EDGE
    ),
  };
}

/**
 * Resize PNG buffer for API limits; returns buffer + scale factors back to original.
 */
async function resizeForVision(buffer, maxLongEdge = DEFAULT_MAX_LONG_EDGE) {
  const meta = await sharp(buffer).metadata();
  const w = meta.width || 1;
  const h = meta.height || 1;
  const longEdge = Math.max(w, h);
  if (longEdge <= maxLongEdge) {
    return {
      buffer,
      visionWidth: w,
      visionHeight: h,
      scaleToFullX: 1,
      scaleToFullY: 1,
    };
  }
  const scale = maxLongEdge / longEdge;
  const vw = Math.round(w * scale);
  const vh = Math.round(h * scale);
  const out = await sharp(buffer)
    .resize(vw, vh, { fit: 'fill' })
    .png()
    .toBuffer();
  return {
    buffer: out,
    visionWidth: vw,
    visionHeight: vh,
    scaleToFullX: w / vw,
    scaleToFullY: h / vh,
  };
}

/**
 * Normalized bbox (0-1) → pixel rect on full-size image.
 */
function normToPixelsFull(norm, fullWidth, fullHeight) {
  const x = Math.round(norm.x * fullWidth);
  const y = Math.round(norm.y * fullHeight);
  const width = Math.round(norm.width * fullWidth);
  const height = Math.round(norm.height * fullHeight);
  return clampRect({ x, y, width, height }, fullWidth, fullHeight);
}

function clampRect(rect, imgW, imgH) {
  let { x, y, width, height } = rect;
  x = Math.max(0, Math.min(x, imgW - 1));
  y = Math.max(0, Math.min(y, imgH - 1));
  width = Math.max(1, Math.min(width, imgW - x));
  height = Math.max(1, Math.min(height, imgH - y));
  return { x, y, width, height };
}

/**
 * Drop everything from the top through the bottom of `rect` (full image width),
 * so the result is shorter and starts with what was below the compared region.
 * Coordinates are in **current** image pixel space.
 */
async function cropBelowRect(buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const imgW = meta.width;
  const imgH = meta.height;
  const r = clampRect(rect, imgW, imgH);
  const newTop = r.y + r.height;
  if (newTop >= imgH) {
    return sharp({
      create: {
        width: imgW,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
  }
  return sharp(buffer)
    .extract({ left: 0, top: newTop, width: imgW, height: imgH - newTop })
    .png()
    .toBuffer();
}

async function extractCrop(buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const r = clampRect(rect, meta.width, meta.height);
  return sharp(buffer)
    .extract({ left: r.x, top: r.y, width: r.width, height: r.height })
    .png()
    .toBuffer();
}

/**
 * Normalized bbox (0–1) from pixel rect on a full-size image.
 */
function pixelsToNormBbox(rect, fullWidth, fullHeight) {
  const w = fullWidth || 1;
  const h = fullHeight || 1;
  return {
    x: rect.x / w,
    y: rect.y / h,
    width: rect.width / w,
    height: rect.height / h,
  };
}

/**
 * Remove a horizontal band and stitch the part above + below (no white gap).
 * Used when a matched target block must not be removed via top-only crop.
 */
async function stitchRemoveHorizontalBand(buffer, rect) {
  const meta = await sharp(buffer).metadata();
  const imgW = meta.width;
  const imgH = meta.height;
  const r = clampRect(rect, imgW, imgH);
  const topH = r.y;
  const bottomTop = r.y + r.height;
  const bottomH = imgH - bottomTop;
  if (topH <= 0 && bottomH <= 0) {
    return sharp({
      create: {
        width: imgW,
        height: 1,
        channels: 3,
        background: { r: 255, g: 255, b: 255 },
      },
    })
      .png()
      .toBuffer();
  }
  if (topH <= 0) {
    return sharp(buffer)
      .extract({ left: 0, top: bottomTop, width: imgW, height: bottomH })
      .png()
      .toBuffer();
  }
  if (bottomH <= 0) {
    return sharp(buffer)
      .extract({ left: 0, top: 0, width: imgW, height: topH })
      .png()
      .toBuffer();
  }
  const topBuf = await sharp(buffer)
    .extract({ left: 0, top: 0, width: imgW, height: topH })
    .png()
    .toBuffer();
  const bottomBuf = await sharp(buffer)
    .extract({ left: 0, top: bottomTop, width: imgW, height: bottomH })
    .png()
    .toBuffer();
  return sharp({
    create: {
      width: imgW,
      height: topH + bottomH,
      channels: 3,
      background: { r: 255, g: 255, b: 255 },
    },
  })
    .composite([
      { input: topBuf, top: 0, left: 0 },
      { input: bottomBuf, top: topH, left: 0 },
    ])
    .png()
    .toBuffer();
}

/**
 * Compare vertical position of the same logical block on source vs target full pages.
 * @returns {'aligned'|'lower_on_page'|'higher_on_page'}
 */
function classifyVerticalPlacement(sourcePageRect, targetPageRect, pageHeight) {
  const sourceMid = sourcePageRect.y + sourcePageRect.height / 2;
  const targetMid = targetPageRect.y + targetPageRect.height / 2;
  const delta = targetMid - sourceMid;
  const tolerance = Math.max(100, (pageHeight || 1) * 0.05);
  if (Math.abs(delta) <= tolerance) return 'aligned';
  if (delta > tolerance) return 'lower_on_page';
  return 'higher_on_page';
}

/**
 * Build a shorter target remainder by removing matched bands (full-page pixel coords).
 * Removes bottom-to-top so earlier bboxes stay valid on the shrinking buffer.
 * @param {Buffer} fullBuffer original full-page target capture
 * @param {{ bbox: { x: number, y: number, width: number, height: number } }[]} regions
 */
async function applyTargetStitchRemovals(fullBuffer, regions) {
  if (!regions || regions.length === 0) {
    return Buffer.from(fullBuffer);
  }
  const sorted = [...regions].sort((a, b) => b.bbox.y - a.bbox.y);
  let buf = Buffer.from(fullBuffer);
  for (const region of sorted) {
    buf = await stitchRemoveHorizontalBand(buf, region.bbox);
  }
  return buf;
}

module.exports = {
  resizeForVision,
  normToPixelsFull,
  pixelsToNormBbox,
  clampRect,
  cropBelowRect,
  extractCrop,
  stitchRemoveHorizontalBand,
  applyTargetStitchRemovals,
  classifyVerticalPlacement,
  resolveVisionMaxEdges,
  DEFAULT_MAX_LONG_EDGE,
  DEFAULT_MATCH_CROP_MAX_EDGE,
};
