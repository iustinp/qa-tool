/*
 * scoper/cutlines.js — screenshot horizontal cut-line detector (issue #65), pixels only (no DOM).
 *
 * Windowed change-point down the image: for each row, compare the mean pixel profile of a window
 * ABOVE vs a window BELOW. A section seam changes the CONTENT CHARACTER (spikes); a photo's horizon
 * line does not (both windows are "that photo"). Keep peaks that are strong (change magnitude) OR
 * broad (fraction of columns that change) — an asymmetric hero (white text left / dark image right)
 * transitions only ~half the columns, so coverage understates it but strength still catches it.
 *
 * detectCutlines(shot) -> [{ y, px, strength, cov }]  (y = fraction 0..1 of screenshot height)
 * Validated by scoper/poc-cutlines.js (draws these on real screenshots).
 */

const sharp = require('sharp');

const DW = 200;      // downscaled analysis width (kills texture, cheap)
const THRESH = 10;   // min windowed change (0..255) to be a candidate at all
const COVMIN = 0.45; // min fraction of columns changing to be a candidate at all
const COLDIFF = 18;  // per-column change counted toward coverage

async function detectCutlines(shot) {
  const meta = await sharp(shot).metadata();
  const origH = meta.height || 0;
  const { data, info } = await sharp(shot).resize({ width: DW }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels, stride = w * ch;
  if (h < 8) return [];
  const k = Math.max(4, Math.round(h * 0.02)); // half-window height (downscaled rows)

  const prefix = new Float64Array((h + 1) * stride); // row prefix sums -> O(1) window means
  for (let y = 0; y < h; y++) { const o = y * stride, po = y * stride, no = (y + 1) * stride; for (let i = 0; i < stride; i++) prefix[no + i] = prefix[po + i] + data[o + i]; }
  const wmean = (y0, y1, i) => (prefix[y1 * stride + i] - prefix[y0 * stride + i]) / (y1 - y0);

  const C = new Float64Array(h), COV = new Float64Array(h);
  for (let y = k; y < h - k; y++) {
    let sum = 0, cov = 0;
    for (let x = 0; x < w; x++) {
      let cd = 0;
      for (let c = 0; c < ch; c++) { const i = x * ch + c; cd += Math.abs(wmean(y - k, y, i) - wmean(y, y + k, i)); }
      cd /= ch;
      sum += cd; if (cd > COLDIFF) cov += 1;
    }
    C[y] = sum / w; COV[y] = cov / w;
  }
  const minGap = Math.max(4, Math.round(h * 0.03));
  const factor = origH / h;
  const cuts = [];
  for (let y = k; y < h - k; y++) {
    if (C[y] < THRESH || COV[y] < COVMIN) continue;
    let isMax = true;
    for (let d = -minGap; d <= minGap; d++) { const yy = y + d; if (yy >= 0 && yy < h && C[yy] > C[y]) { isMax = false; break; } }
    if (!isMax) continue;
    const px = Math.round(y * factor);
    cuts.push({ y: origH ? px / origH : 0, px, strength: +C[y].toFixed(1), cov: +COV[y].toFixed(2) });
  }
  return cuts;
}

module.exports = { detectCutlines, THRESH, COVMIN };
