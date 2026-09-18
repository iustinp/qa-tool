#!/usr/bin/env node
/*
 * scoper/poc-bandclass.js — visualize band CLASSIFICATION (block / default / chrome).
 *
 *   node scoper/poc-bandclass.js <pearsDir> [nSamples] [outDir]
 *
 * BLOCK bands drawn solid green (with subtype), composed/low-confidence blocks magenta-dashed,
 * chrome + default drawn as thin faded outlines so the blocks pop. Writes class-<slug>.png +
 * index.html into outDir. This is the first view of "just the things scoping cares about".
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { classifyPage } = require('./band-class');

const pearsDir = process.argv[2];
if (!pearsDir) { console.error('usage: node scoper/poc-bandclass.js <pearsDir> [nSamples] [outDir]'); process.exit(1); }
const nSamples = parseInt(process.argv[3], 10) || 6;
const outDir = process.argv[4] || path.join(process.cwd(), 'scratchpad-bandclass');
fs.mkdirSync(outDir, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function pick(pears, n) {
  const picks = [];
  const article = pears.find((p) => /frances-tiafoe-fund-surpasses/.test(p.url));
  if (article) picks.push(article);
  const step = Math.max(1, Math.floor(pears.length / n));
  for (let i = 0; i < pears.length && picks.length < n; i += step) if (!picks.includes(pears[i])) picks.push(pears[i]);
  return picks.slice(0, n);
}

const STYLE = {
  block:   { fill: 'rgba(26,158,106,0.17)', stroke: '#128a5c', dash: null },
  blockLo: { fill: 'rgba(214,0,158,0.10)',  stroke: '#b0007f', dash: '12 8' },
  chrome:  { fill: 'none',                   stroke: '#9aa3b2', dash: '6 8' },
  default: { fill: 'none',                   stroke: '#c9c9c9', dash: '4 9' },
};

async function render(pg, keyBucket) {
  const shot = path.join(pg.dir, 'screenshots', 'source-full.png');
  if (!fs.existsSync(shot)) return null;
  const meta = await sharp(shot).metadata();
  const pngW = meta.width, pngH = meta.height, dpr = pg.dpr || 1;
  const bands = classifyPage(pg, keyBucket, {
    pageW: Math.max(pngW / dpr, ...pg.nodes.map((n) => n.x + n.w)),
    pageH: Math.max(pngH / dpr, ...pg.nodes.map((n) => n.y + n.h)),
  });

  const parts = [];
  for (const b of bands) {
    const st = b.low ? STYLE.blockLo : STYLE[b.cls];
    const y = b.y0 * dpr, h = (b.y1 - b.y0) * dpr;
    const dash = st.dash ? ` stroke-dasharray="${st.dash}"` : '';
    const sw = b.cls === 'block' ? 4 : 1.5;
    parts.push(`<rect x="1" y="${y.toFixed(0)}" width="${pngW - 2}" height="${h.toFixed(0)}" fill="${st.fill}" stroke="${st.stroke}" stroke-width="${sw}"${dash}/>`);
    // label only blocks prominently; chrome/default get a tiny tag
    if (b.cls === 'block') {
      const label = `BLOCK · ${b.subtype}${b.low ? '' : ''}`;
      const sub = b.why;
      parts.push(`<rect x="6" y="${(y + 6).toFixed(0)}" width="${Math.max(label.length, sub.length) * 11 + 20}" height="52" fill="#fff" stroke="${st.stroke}" stroke-width="2"/>`);
      parts.push(`<text x="16" y="${(y + 27).toFixed(0)}" font-family="ui-monospace,monospace" font-size="21" font-weight="800" fill="${st.stroke}">${esc(label)}</text>`);
      parts.push(`<text x="16" y="${(y + 46).toFixed(0)}" font-family="ui-monospace,monospace" font-size="15" fill="#555">${esc(sub)}</text>`);
    } else {
      parts.push(`<rect x="6" y="${(y + 6).toFixed(0)}" width="${(b.cls + ' ' + b.why).length * 8 + 12}" height="20" fill="#fff" opacity="0.85"/>`);
      parts.push(`<text x="10" y="${(y + 21).toFixed(0)}" font-family="ui-monospace,monospace" font-size="13" fill="${st.stroke}">${esc(b.cls)} · ${esc(b.why)}</text>`);
    }
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${pngW}" height="${pngH}">${parts.join('')}</svg>`;
  const slug = path.basename(pg.dir);
  const outPng = path.join(outDir, `class-${slug}.png`);
  await sharp(shot).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(outPng);
  return { slug, url: pg.url, outPng, bands };
}

(async () => {
  const pears = loadPears(pearsDir);
  if (!pears.length) { console.error(`no pears under ${pearsDir}`); process.exit(1); }
  const { keyBucket } = classifyDescriptors(pears);   // cross-page chrome verdict (needs ALL pages)
  const picks = pick(pears, nSamples);
  const results = [];
  for (const pg of picks) { const r = await render(pg, keyBucket); if (r) results.push(r); }

  const cards = results.map((r) => `<div class="c"><h3>${esc(r.url)}</h3>
    <p>${r.bands.filter((b) => b.cls === 'block').length} blocks · ${r.bands.filter((b) => b.cls === 'chrome').length} chrome · ${r.bands.filter((b) => b.cls === 'default').length} default</p>
    <img src="class-${esc(r.slug)}.png"></div>`).join('');
  fs.writeFileSync(path.join(outDir, 'index.html'),
    `<!doctype html><meta charset="utf8"><title>band-class probe</title>
     <style>body{font:14px system-ui;margin:20px;background:#f4f4f4}.c{margin-bottom:28px}img{max-width:760px;border:1px solid #ccc;background:#fff}h3{font-size:14px;margin:0 0 4px}p{margin:0 0 8px;color:#555}</style>
     <h1>band-class probe — ${esc(path.basename(pearsDir))}</h1>${cards}`);

  console.log(`\nband-class probe -> ${outDir}\n`);
  for (const r of results) {
    const nb = r.bands.filter((b) => b.cls === 'block').length;
    console.log(`  ${nb} BLOCKS  (${r.bands.length} bands)  ${r.url}`);
    for (const b of r.bands.filter((x) => x.cls === 'block')) console.log(`      • ${b.subtype.padEnd(22)} ${b.why}`);
  }
  console.log('');
})().catch((e) => { console.error(e); process.exit(1); });
