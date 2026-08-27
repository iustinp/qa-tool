#!/usr/bin/env node
/*
 * Step #2 runner (issue #65): assemble regions across the corpus, print a compact summary, and
 * render a VISUAL HTML per sample page. Each block region is labelled with its ALGORITHMIC EDS
 * TYPE (Cards/Hero/List/...) — not just "block" — so typing can be validated by eye against a
 * faded full-page SCREENSHOT backdrop (screenshots/source-full.png, pixel coords == doc coords).
 * Falls back to rendering pear text when no screenshot is present. Offline, deterministic.
 *
 *   node scoper/poc-regions.js [runDir] [numSamplePages]
 */

const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { assembleRegions } = require('./regions');
const { canonical, guessType } = require('./catalog');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const nSamples = parseInt(process.argv[3], 10) || 3;
const outDir = process.env.SCOPER_OUT || '/private/tmp/claude-503/-Users-iustinp-github-qa-tool/16f2a38d-1803-4626-bab3-c6fbc8c70288/scratchpad';

const pears = loadPears(runDir);
const { keyBucket } = classifyDescriptors(pears);

// per-region EDS type guess (same logic as the catalog, but for this single instance)
function edsType(r) { const c = canonical(r); return guessType(c.unit, c.repeat >= 2, { region: r }); }

const tally = { chrome: 0, block: 0, prose: 0 };
let totalRegions = 0;
const perPage = [];
for (const p of pears) {
  const regions = assembleRegions(p.nodes, keyBucket);
  perPage.push({ url: p.url, dir: p.dir, nodes: p.nodes, regions });
  for (const r of regions) { tally[r.type]++; totalRegions++; }
}
console.log(`\n=== corpus: ${pears.length} pages, ${totalRegions} regions (${(totalRegions / pears.length).toFixed(1)}/page) ===`);
for (const k of Object.keys(tally)) console.log(`  ${k.padEnd(7)}: ${tally[k]}`);

// ---- visual render ---------------------------------------------------------
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLOR = { chrome: '#8a94a6', block: '#1a9e6a', prose: '#3b76d1' };

function renderPage(pg, scale) {
  const nodeMaxX = Math.max(...pg.nodes.map((n) => n.x + n.w), 100);
  const nodeMaxY = Math.max(...pg.nodes.map((n) => n.y + n.h), 100);
  const S = scale;
  const shot = pg.dir && path.join(pg.dir, 'screenshots', 'source-full.png');

  // The screenshot's TRUE css document size = its own pixel dimensions / DPR (clm.width is only the
  // viewport and can differ from the document width). Node coords live in that same css space (some
  // overflow it, e.g. off-screen carousel slides). Display the img at ONE uniform scale S with its
  // aspect preserved (width=shotW*S, height=shotH*S both derived from the same px/DPR), so pixel
  // (x,y) lands at (x/DPR)*S == the box coordinate. No distortion in either axis.
  let bg = null, shotW = pg.width || nodeMaxX, shotH = pg.height || nodeMaxY;
  if (shot && fs.existsSync(shot)) {
    const buf = fs.readFileSync(shot);
    shotW = buf.readUInt32BE(16) / pg.dpr;   // PNG IHDR width  / DPR  -> css width
    shotH = buf.readUInt32BE(20) / pg.dpr;   // PNG IHDR height / DPR  -> css height
    bg = `data:image/png;base64,${buf.toString('base64')}`;
  }
  const pageW = Math.max(shotW, nodeMaxX);
  const pageH = Math.max(shotH, nodeMaxY);

  const parts = [`<div class="page" style="width:${(pageW * S).toFixed(0)}px;height:${(pageH * S).toFixed(0)}px">`];
  if (bg) parts.push(`<img class="bg" src="${bg}" style="width:${(shotW * S).toFixed(0)}px;height:${(shotH * S).toFixed(0)}px">`);
  else {
    // fallback: render pear text/images faintly so there's still a backdrop
    for (const n of pg.nodes) {
      if (n.kind === 'text') parts.push(`<div class="tx" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px;font-size:${Math.max(6, n.fontSize * S).toFixed(0)}px;font-weight:${esc(n.fontWeight)}">${esc(n.text || '')}</div>`);
      else parts.push(`<div class="im" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px">img</div>`);
    }
  }
  for (const r of pg.regions) {
    const c = COLOR[r.type];
    const label = r.type === 'block' ? edsType(r) : r.type;
    parts.push(`<div class="rg" style="left:${(r.x * S).toFixed(0)}px;top:${(r.y * S).toFixed(0)}px;width:${(r.w * S).toFixed(0)}px;height:${(r.h * S).toFixed(0)}px;border-color:${c}">`);
    parts.push(`<span class="tag" style="background:${c}">${esc(label)}</span></div>`);
  }
  parts.push('</div>');
  const counts = pg.regions.reduce((m, r) => (m[r.type] = (m[r.type] || 0) + 1, m), {});
  return `<h3>${esc(pg.url)}${bg ? '' : '  <em>(no screenshot — pear text backdrop)</em>'}</h3>`
    + `<p class="cnt">regions — block:${counts.block || 0} chrome:${counts.chrome || 0} prose:${counts.prose || 0}</p>`
    + parts.join('');
}

const hasShot = (pg) => pg.dir && fs.existsSync(path.join(pg.dir, 'screenshots', 'source-full.png'));
const sample = [...perPage].sort((a, b) => (hasShot(b) ? 1 : 0) - (hasShot(a) ? 1 : 0)).slice(0, nSamples);
const s0W = sample[0].width || Math.max(...sample[0].nodes.map((n) => n.x + n.w), 900);
const scale = 900 / s0W;
const body = sample.map((pg) => renderPage(pg, scale)).join('<hr>');
const html = `<!doctype html><meta charset="utf8"><title>scoper regions</title>
<style>
 body{font:13px system-ui;margin:20px;color:#222}
 .legend span{display:inline-block;padding:2px 8px;margin-right:6px;border-radius:3px;color:#fff}
 .page{position:relative;border:1px solid #eee;margin:8px 0 28px;background:#fff}
 .bg{position:absolute;left:0;top:0;opacity:.45}
 .rg{position:absolute;border:2px solid;border-radius:3px;box-sizing:border-box}
 .rg .tag{position:absolute;left:-1px;top:-16px;font-size:10px;color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap;font-family:ui-monospace,monospace;z-index:2}
 .tx{position:absolute;color:#555;overflow:hidden;white-space:nowrap;line-height:1}
 .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:9px;text-align:center;box-sizing:border-box}
 h3{margin:24px 0 2px;font-size:13px;color:#555;word-break:break-all} h3 em{color:#b98}
 .cnt{margin:0 0 6px;color:#888;font-family:ui-monospace,monospace}
 hr{border:0;border-top:1px dashed #ddd;margin:30px 0}
</style>
<h2>scoper — detected regions + EDS type (issue #65, step #2)</h2>
<p class="legend">
 <span style="background:${COLOR.block}">block — labelled with its EDS type guess</span>
 <span style="background:${COLOR.chrome}">chrome</span>
 <span style="background:${COLOR.prose}">prose</span>
</p>
<p>${pears.length} pages · showing first ${nSamples}. Faded backdrop = the page screenshot; box = a detected region; green label = the algorithmic EDS block type.</p>
${body}`;

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, 'scoper-regions.html');
fs.writeFileSync(outFile, html);
console.log(`\nvisual: ${outFile}\n`);
