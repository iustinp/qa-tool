/**
 * text-geometry-ocr — build the text-layout fingerprint from OCR of the
 * full-page screenshot instead of the DOM. DOM-agnostic: coordinates come
 * straight from the rendered image, so they match the screenshot exactly and
 * positioned (fixed/sticky/absolute) elements land where they visually are —
 * which the DOM's getBoundingClientRect can get wrong.
 *
 * Uses the system `tesseract` binary (TSV word boxes), groups words into lines,
 * then reuses buildFingerprint (ordering + deltas). Trade-off vs DOM: coarser
 * granularity and occasional misreads, but faithful positions.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const { buildFingerprint } = require('./text-geometry');

/** Is the tesseract binary available? */
function ocrAvailable() {
  try {
    execFileSync('tesseract', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A grouped line is noise if it carries no real text: pure punctuation/symbols
 * (dividers, arrows, icon misreads like "> >", "=>", "|") or a lone 1-2 char
 * blob. Deliberately conservative — number/acronym content ("MCLR", "Top 200",
 * phone numbers) and short function words inside longer lines must survive.
 */
function isNoiseLine(text) {
  const s = text.trim();
  if (!/[a-zA-Z]/.test(s)) return true; // no letters at all → symbols/arrows
  if (!/\s/.test(s) && s.length <= 2) return true; // single 1-2 char token
  return false;
}

/** OCR one image file (TSV) → line items {text,x,y,w,h}, y offset by `yOffset`. */
function ocrTile(tilePath, yOffset, minConf) {
  // psm 11 ("sparse text — find as much as possible") gives the finest,
  // per-element granularity: each nav link / button label becomes its own item
  // rather than being merged into a row. Its usual downside — hallucinating
  // words inside decorative graphics — is neutralized because we OCR a
  // flattened black-on-white capture (ocrContrast) with no graphics to read.
  // psm 3 (layout analysis) over-merges once the visual separators are gone.
  const tsv = execFileSync('tesseract', [tilePath, 'stdout', '--psm', '11', 'tsv'], {
    maxBuffer: 128 * 1024 * 1024,
  }).toString();
  const groups = new Map();
  for (const row of tsv.split('\n')) {
    const c = row.split('\t');
    if (c.length < 12 || c[0] !== '5') continue; // level 5 = word
    const conf = parseFloat(c[10]);
    const text = c[11];
    if (!(conf >= minConf) || !text || !text.trim()) continue;
    const key = `${c[2]}_${c[3]}_${c[4]}`; // block_par_line
    const x = +c[6];
    const y = +c[7] + yOffset;
    const w = +c[8];
    const h = +c[9];
    let g = groups.get(key);
    if (!g) {
      g = { words: [], x0: x, y0: y, x1: x + w, y1: y + h };
      groups.set(key, g);
    }
    g.words.push(text);
    g.x0 = Math.min(g.x0, x);
    g.y0 = Math.min(g.y0, y);
    g.x1 = Math.max(g.x1, x + w);
    g.y1 = Math.max(g.y1, y + h);
  }
  const items = [];
  for (const g of groups.values()) {
    const text = g.words.join(' ');
    if (isNoiseLine(text)) continue;
    items.push({ text, x: g.x0, y: g.y0, w: g.x1 - g.x0, h: g.y1 - g.y0 });
  }
  return items;
}

/**
 * OCR a full-page screenshot into line items. The page is processed in
 * overlapping horizontal TILES: tesseract downsamples very tall images and loses
 * small text (nav, links), so per-tile OCR at native resolution keeps recall.
 * Coordinates are offset back to full-page space and deduped across tile seams.
 */
async function extractTextItemsOcr(imgPath, opts = {}) {
  const minConf = opts.minConf ?? 40;
  // Keep tiles short: tesseract downsamples tall images and loses small text at
  // the top of the region (nav, header links). ~800px preserves that recall;
  // the overlap re-catches lines straddling a seam (deduped below).
  const tileH = opts.tileHeight ?? 800;
  const overlap = opts.tileOverlap ?? 200;
  const meta = await sharp(imgPath).metadata();
  const W = meta.width;
  const H = meta.height;
  const step = Math.max(200, tileH - overlap);
  const items = [];
  const seen = new Set();
  for (let top = 0; top < H; top += step) {
    const h = Math.min(tileH, H - top);
    if (h < 10) break;
    const tmp = path.join(os.tmpdir(), `ppd-ocr-${process.pid}-${top}.png`);
    await sharp(imgPath).extract({ left: 0, top, width: W, height: h }).png().toFile(tmp);
    try {
      for (const it of ocrTile(tmp, top, minConf)) {
        // Dedup across the overlap band (same text at ~same absolute y).
        const key = `${Math.round(it.y / 6)}:${it.x < 0 ? 0 : Math.round(it.x / 6)}:${it.text}`;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(it);
      }
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    }
  }
  return items;
}

/** @returns fingerprint (same shape as text-geometry.extractTextFingerprint) */
async function extractTextFingerprintOcr(imgPath, opts = {}) {
  return buildFingerprint(await extractTextItemsOcr(imgPath, opts), opts);
}

module.exports = { ocrAvailable, extractTextItemsOcr, extractTextFingerprintOcr };
