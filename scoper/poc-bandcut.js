#!/usr/bin/env node
/*
 * scoper/poc-bandcut.js — visualize the top-down band-cut on sample pages.
 *
 *   node scoper/poc-bandcut.js <pearsDir> [nSamples] [outDir]
 *
 * Draws detected bands onto each page's real screenshot (sharp) so the cut can be judged by eye.
 * Writes band-<slug>.png + index.html into outDir (default ./scratchpad-bandcut).
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadPears } = require('./signature');
const { bandCut } = require('./band-cut');

const pearsDir = process.argv[2];
if (!pearsDir) { console.error('usage: node scoper/poc-bandcut.js <pearsDir> [nSamples] [outDir]'); process.exit(1); }
const nSamples = parseInt(process.argv[3], 10) || 6;
const outDir = process.argv[4] || path.join(process.cwd(), 'scratchpad-bandcut');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// pick a spread across the corpus, but force-include the article page I hand-typed if present
function pick(pears, n) {
  const picks = [];
  const article = pears.find((p) => /frances-tiafoe-fund-surpasses/.test(p.url));
  if (article) picks.push(article);
  const step = Math.max(1, Math.floor(pears.length / n));
  for (let i = 0; i < pears.length && picks.length < n; i += step) {
    if (!picks.includes(pears[i])) picks.push(pears[i]);
  }
  return picks.slice(0, n);
}

const PAL = [['rgba(30,120,220,0.13)', '#1e78dc'], ['rgba(230,120,0,0.13)', '#e67300']];

async function render(pg) {
  const shot = path.join(pg.dir, 'screenshots', 'source-full.png');
  if (!fs.existsSync(shot)) return null;
  const meta = await sharp(shot).metadata();
  const pngW = meta.width, pngH = meta.height;
  const dpr = pg.dpr || 1;
  const nodeMaxX = Math.max(100, ...pg.nodes.map((n) => n.x + n.w));
  const nodeMaxY = Math.max(100, ...pg.nodes.map((n) => n.y + n.h));
  const pageW = Math.max(nodeMaxX, pngW / dpr);
  const pageH = Math.max(nodeMaxY, pngH / dpr);

  const { bands, minGap, minCover } = bandCut(pg.nodes, pageW, pageH);

  const parts = [];
  bands.forEach((b, i) => {
    const [fill, stroke] = PAL[i % 2];
    const y = b.y0 * dpr, h = (b.y1 - b.y0) * dpr;
    parts.push(`<rect x="0" y="${y.toFixed(0)}" width="${pngW}" height="${h.toFixed(0)}" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`);
    // actual content extent (dashed) so we see the band's real width vs full-bleed
    parts.push(`<rect x="${(b.x0 * dpr).toFixed(0)}" y="${y.toFixed(0)}" width="${((b.x1 - b.x0) * dpr).toFixed(0)}" height="${h.toFixed(0)}" fill="none" stroke="${stroke}" stroke-width="1.5" stroke-dasharray="10 8" opacity="0.7"/>`);
    if (i > 0) parts.push(`<line x1="0" y1="${y.toFixed(0)}" x2="${pngW}" y2="${y.toFixed(0)}" stroke="#e00" stroke-width="2" stroke-dasharray="16 10"/>`);
    const label = `#${i + 1}  n=${b.nodes}  ${Math.round(b.y1 - b.y0)}px`;
    parts.push(`<rect x="6" y="${(y + 6).toFixed(0)}" width="${18 + label.length * 12}" height="30" fill="#fff" stroke="${stroke}" stroke-width="1.5"/>`);
    parts.push(`<text x="16" y="${(y + 27).toFixed(0)}" font-family="ui-monospace,monospace" font-size="20" font-weight="700" fill="${stroke}">${esc(label)}</text>`);
  });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pngW}" height="${pngH}">${parts.join('')}</svg>`;

  const slug = path.basename(pg.dir);
  const outPng = path.join(outDir, `band-${slug}.png`);
  await sharp(shot).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPng);
  return { slug, url: pg.url, outPng, bands, minGap, minCover, pageH: Math.round(pageH) };
}

(async () => {
  const pears = loadPears(pearsDir);
  if (!pears.length) { console.error(`no pears under ${pearsDir}`); process.exit(1); }
  const picks = pick(pears, nSamples);
  const results = [];
  for (const pg of picks) {
    const r = await render(pg);
    if (r) results.push(r);
  }

  const cards = results.map((r) => `<div class="c"><h3>${esc(r.url)}</h3>
    <p>${r.bands.length} bands · page ${r.pageH}px · minGap ${r.minGap}px · minCover ${Math.round(r.minCover)}px</p>
    <img src="band-${esc(r.slug)}.png"></div>`).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf8"><title>band-cut probe</title>
     <style>body{font:14px system-ui;margin:20px;background:#f4f4f4}.c{margin-bottom:28px}img{max-width:760px;border:1px solid #ccc;background:#fff}h3{font-size:14px;margin:0 0 4px}p{margin:0 0 8px;color:#555}</style>
     <h1>band-cut probe — ${esc(path.basename(pearsDir))}</h1>${cards}`);

  console.log(`\nband-cut probe -> ${outDir}`);
  for (const r of results) {
    console.log(`  ${r.bands.length} bands  (page ${r.pageH}px)  ${r.url}`);
    console.log(`     heights: ${r.bands.map((b) => Math.round(b.y1 - b.y0)).join(', ')}`);
  }
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
