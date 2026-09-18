#!/usr/bin/env node
/*
 * scoper/poc-cutlines.js — SPIKE (issue #65): screenshot-based horizontal cut-line candidates.
 *
 * Pears throw away the visual seam where two abutting sections meet (two stacked hero images, an
 * image band → a white content band): there's no whitespace valley and no node gap, so the pear
 * band-cut fuses them. But the SCREENSHOT still encodes that seam. This detects it deterministically
 * from pixels only (no DOM), as candidate cut lines — then draws them on the real screenshot so we
 * can eyeball how well it works BEFORE wiring it into anything.
 *
 * Method = WINDOWED change-point down the image (not naive edge detection): for each row compare the
 * mean pixel profile of a window ABOVE vs a window BELOW. A section seam changes the CONTENT CHARACTER
 * (spikes); a horizon line inside one photo does not (above & below are both "that photo"). Keep peaks
 * that are strong AND broad across columns.
 *
 *   node scoper/poc-cutlines.js <corpus | pairsDir> [outDir] [maxPages]
 *
 * Output: <outDir>/cutlines-<slug>.png per page — RED = image-transition candidates (thicker = stronger),
 * BLUE = the current pear band-cut boundaries (for comparison).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadPears } = require('./signature');
const { bandCut } = require('./band-cut');

const DW = 200;    // downscaled analysis width (kills texture, cheap)
const OUTW = 720;  // output image width
const THRESH = 10; // min windowed change (0..255) for a candidate
const COVMIN = 0.45; // min fraction of columns that must change (broadness)
const COLDIFF = 18;  // per-column change counted toward coverage

function resolvePairs(dir) { return fs.existsSync(path.join(dir, 'pairs')) ? path.join(dir, 'pairs') : dir; }

// Windowed change-point profile over a downscaled screenshot. Returns candidate peaks in ORIGINAL px.
async function detectTransitions(shot) {
  const meta = await sharp(shot).metadata();
  const origW = meta.width, origH = meta.height;
  const { data, info } = await sharp(shot).resize({ width: DW }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, ch = info.channels, stride = w * ch;
  const k = Math.max(4, Math.round(h * 0.02)); // half-window height (downscaled rows)

  // prefix sums over rows so a window mean is O(1) per (col,channel)
  const prefix = new Float64Array((h + 1) * stride);
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
  // peaks: strong + broad + local max within a min gap
  const minGap = Math.max(4, Math.round(h * 0.03));
  const factor = origH / h;
  const peaks = [];
  for (let y = k; y < h - k; y++) {
    if (C[y] < THRESH || COV[y] < COVMIN) continue;
    let isMax = true;
    for (let d = -minGap; d <= minGap; d++) { const yy = y + d; if (yy >= 0 && yy < h && C[yy] > C[y]) { isMax = false; break; } }
    if (isMax) peaks.push({ y: Math.round(y * factor), strength: +C[y].toFixed(1), cov: +COV[y].toFixed(2) });
  }
  return { peaks, origW, origH };
}

(async () => {
  const input = process.argv[2];
  if (!input) { console.error('usage: node scoper/poc-cutlines.js <corpus | pairsDir> [outDir] [maxPages]'); process.exit(1); }
  const pairsDir = resolvePairs(input);
  const outDir = process.argv[3] || path.join(process.cwd(), 'scoper-cutlines');
  const maxPages = parseInt(process.argv[4], 10) || 8;
  fs.mkdirSync(outDir, { recursive: true });

  const pears = loadPears(pairsDir).filter((p) => fs.existsSync(path.join(p.dir, 'screenshots', 'source-full.png'))).slice(0, maxPages);
  if (!pears.length) { console.error(`no pears with screenshots under ${pairsDir}`); process.exit(1); }
  console.log(`cutline spike — ${pears.length} pages -> ${outDir}\n`);

  for (const pg of pears) {
    const slug = path.basename(pg.dir);
    const shot = path.join(pg.dir, 'screenshots', 'source-full.png');
    try {
      const { peaks, origW, origH } = await detectTransitions(shot);
      const dpr = pg.dpr || 1;
      const pageW = Math.max(100, ...pg.nodes.map((n) => n.x + n.w));
      const pageH = Math.max(100, ...pg.nodes.map((n) => n.y + n.h));
      const { bands } = bandCut(pg.nodes, pageW, pageH);
      const bandYs = [...new Set(bands.flatMap((b) => [b.y0, b.y1]))]; // css node-space boundaries

      const scale = OUTW / origW, outH = Math.round(origH * scale);
      const maxStrength = Math.max(1, ...peaks.map((p) => p.strength));
      const bandLines = bandYs.map((cssY) => {
        const y = Math.round(cssY * dpr * scale);
        return `<line x1="0" y1="${y}" x2="${OUTW}" y2="${y}" stroke="#1560d0" stroke-width="1" stroke-dasharray="5 4" opacity="0.7"/>`;
      }).join('');
      const transLines = peaks.map((p) => {
        const y = Math.round(p.y * scale);
        const sw = 1 + Math.round((p.strength / maxStrength) * 4); // thicker = stronger
        return `<line x1="0" y1="${y}" x2="${OUTW}" y2="${y}" stroke="#e11d48" stroke-width="${sw}" opacity="0.85"/>`
          + `<rect x="0" y="${Math.max(0, y - 12)}" width="128" height="13" fill="#e11d48"/>`
          + `<text x="3" y="${Math.max(10, y - 2)}" font-family="monospace" font-size="10" fill="#fff">T ${p.strength} · cov ${p.cov}</text>`;
      }).join('');
      const legend = `<rect x="${OUTW - 210}" y="6" width="204" height="34" fill="rgba(255,255,255,0.9)" stroke="#ccc"/>`
        + `<line x1="${OUTW - 200}" y1="17" x2="${OUTW - 176}" y2="17" stroke="#e11d48" stroke-width="3"/><text x="${OUTW - 170}" y="21" font-family="monospace" font-size="11" fill="#111">image transition (candidate)</text>`
        + `<line x1="${OUTW - 200}" y1="31" x2="${OUTW - 176}" y2="31" stroke="#1560d0" stroke-width="2" stroke-dasharray="5 4"/><text x="${OUTW - 170}" y="35" font-family="monospace" font-size="11" fill="#111">pear band-cut boundary</text>`;
      const svg = `<svg width="${OUTW}" height="${outH}" xmlns="http://www.w3.org/2000/svg">${bandLines}${transLines}${legend}</svg>`;

      const outPath = path.join(outDir, `cutlines-${slug}.png`);
      await sharp(shot).resize({ width: OUTW }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPath);
      console.log(`  ${slug.slice(0, 44).padEnd(44)} ${String(bands.length).padStart(2)} bands · ${String(peaks.length).padStart(2)} transition candidates`);
    } catch (e) {
      console.log(`  ${slug} — FAIL ${e.message}`);
    }
  }
  console.log(`\ndone -> ${outDir}`);
})().catch((e) => { console.error(e); process.exit(1); });
