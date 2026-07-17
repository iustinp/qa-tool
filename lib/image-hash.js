/**
 * image-hash — perceptual (dHash) hashing of image regions, cropped straight
 * from the full-page screenshot. Hashing the *rendered pixels* (not the file)
 * makes matches robust to the migration's resizing / re-cropping / reformatting
 * and to EDS's opaque asset filenames — validated at distance 0 on real pairs.
 *
 * A dHash is 64 bits (8×8 row-wise gradient), stored as a 16-char hex string;
 * similarity is Hamming distance. Small icons/SVG chrome hash unreliably and
 * aren't "content", so images below a size floor are tagged `icon` and skipped.
 */

const sharp = require('sharp');

/** Hamming distance between two 16-hex-char dHashes (0..64; 64 if incomparable). */
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      d += x & 1;
      x >>= 1;
    }
  }
  return d;
}

/**
 * Compute a dHash for every non-text node of a CLM by sampling its bbox from the
 * screenshot. Mutates nodes in place: sets `hash` (hex) for content images,
 * `icon: true` for sub-floor ones, `flat: true` for blank/solid crops.
 * @param {string} pngPath full-page screenshot
 * @param {Array} nodes clm.nodes
 * @param {{minDim?: number}} [opts]
 */
async function computeImageHashes(pngPath, nodes, opts = {}) {
  const minDim = opts.minDim ?? 40;
  // Decode the screenshot to greyscale raw ONCE, then sample each bbox — avoids
  // re-decoding the (multi-MB) PNG per image.
  const { data, info } = await sharp(pngPath).grayscale().raw().toBuffer({ resolveWithObject: true });
  const W = info.width;
  const H = info.height;
  const clampX = (x) => (x < 0 ? 0 : x >= W ? W - 1 : x);
  const clampY = (y) => (y < 0 ? 0 : y >= H ? H - 1 : y);
  // Average the greyscale value over a cell rectangle (box downsample, ~matches
  // sharp's resize), subsampling so a huge cell stays cheap.
  const cellAvg = (x0, x1, y0, y1) => {
    x0 = clampX(x0); x1 = clampX(x1 - 1); y0 = clampY(y0); y1 = clampY(y1 - 1);
    const sx = Math.max(1, Math.floor((x1 - x0 + 1) / 8));
    const sy = Math.max(1, Math.floor((y1 - y0 + 1) / 8));
    let sum = 0, cnt = 0;
    for (let y = y0; y <= y1; y += sy) for (let x = x0; x <= x1; x += sx) { sum += data[y * W + x]; cnt++; }
    return cnt ? sum / cnt : 0;
  };
  for (const n of nodes || []) {
    if (n.kind === 'text') continue;
    if (Math.min(n.w, n.h) < minDim) {
      n.icon = true;
      continue;
    }
    const L = Math.round(n.x);
    const T = Math.round(n.y);
    const Wd = Math.round(n.w);
    const Ht = Math.round(n.h);
    const bits = [];
    let ones = 0;
    for (let r = 0; r < 8; r++) {
      const y0 = T + Math.floor((r * Ht) / 8);
      const y1 = T + Math.floor(((r + 1) * Ht) / 8);
      const row = [];
      for (let c = 0; c < 9; c++) row.push(cellAvg(L + Math.floor((c * Wd) / 9), L + Math.floor(((c + 1) * Wd) / 9), y0, y1));
      for (let c = 0; c < 8; c++) {
        const b = row[c] < row[c + 1] ? 1 : 0;
        bits.push(b);
        if (b) ones += 1;
      }
    }
    if (ones <= 3 || ones >= 61) {
      n.flat = true; // near-blank crop — a useless hash
      continue;
    }
    let hex = '';
    for (let i = 0; i < 64; i += 4) {
      hex += ((bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3]).toString(16);
    }
    n.hash = hex;
  }
}

module.exports = { hamming, computeImageHashes };
