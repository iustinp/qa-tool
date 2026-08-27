/*
 * Shared scoping + HTML report builders (issue #65). Used by run.js (writes a run dir) and the
 * poc-* scripts. scope() turns pears into per-page regions + a cross-page catalog; the two *Html
 * builders produce self-contained pages (screenshots embedded as data URIs) that open with no
 * server.
 */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp'); // already a project dep; used exactly like lib/image-hash.js
const { classifyDescriptors } = require('./chrome');
const { assembleRegions } = require('./regions');
const { canonical, guessType, buildCatalog } = require('./catalog');
const { detectPageLattices } = require('./lattice');

function scope(pears) {
  const { keyBucket } = classifyDescriptors(pears);
  const perPage = pears.map((p) => ({
    url: p.url, dir: p.dir, nodes: p.nodes, width: p.width, height: p.height, dpr: p.dpr,
    regions: assembleRegions(p.nodes, keyBucket),
  }));
  const catalog = buildCatalog(perPage);
  return { perPage, catalog };
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const COLOR = { chrome: '#8a94a6', block: '#1a9e6a', prose: '#3b76d1' };
const edsType = (r) => { const c = canonical(r); return guessType(c.unit, c.repeat >= 2, { region: r }); };

// screenshot backdrop (uniform-scale, registers with node coords); shared by both overlays
function backdrop(pg, S) {
  const nodeMaxX = Math.max(...pg.nodes.map((n) => n.x + n.w), 100);
  const nodeMaxY = Math.max(...pg.nodes.map((n) => n.y + n.h), 100);
  const shot = pg.dir && path.join(pg.dir, 'screenshots', 'source-full.png');
  let bg = null, shotW = pg.width || nodeMaxX, shotH = pg.height || nodeMaxY;
  if (shot && fs.existsSync(shot)) {
    const buf = fs.readFileSync(shot);
    const dpr = pg.dpr || 1;
    shotW = buf.readUInt32BE(16) / dpr; shotH = buf.readUInt32BE(20) / dpr;
    bg = `data:image/png;base64,${buf.toString('base64')}`;
  }
  const pageW = Math.max(shotW, nodeMaxX), pageH = Math.max(shotH, nodeMaxY);
  const open = [`<div class="page" style="width:${(pageW * S).toFixed(0)}px;height:${(pageH * S).toFixed(0)}px">`];
  if (bg) open.push(`<img class="bg" src="${bg}" style="width:${(shotW * S).toFixed(0)}px;height:${(shotH * S).toFixed(0)}px">`);
  else for (const n of pg.nodes) {
    if (n.kind === 'text') open.push(`<div class="tx" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px;font-size:${Math.max(6, n.fontSize * S).toFixed(0)}px;font-weight:${esc(n.fontWeight)}">${esc(n.text || '')}</div>`);
    else open.push(`<div class="im" style="left:${(n.x * S).toFixed(0)}px;top:${(n.y * S).toFixed(0)}px;width:${(n.w * S).toFixed(0)}px;height:${(n.h * S).toFixed(0)}px">img</div>`);
  }
  return { open, hasBg: !!bg };
}
const box = (b, S, color, label, cls = 'rg') =>
  `<div class="${cls}" style="left:${(b.x * S).toFixed(0)}px;top:${(b.y * S).toFixed(0)}px;width:${(b.w * S).toFixed(0)}px;height:${(b.h * S).toFixed(0)}px;border-color:${color}"><span class="tag" style="background:${color}">${esc(label)}</span></div>`;

// ---- regions overlay (screenshot backdrop + EDS type labels) --------------
function renderPage(pg, S) {
  const { open, hasBg } = backdrop(pg, S);
  for (const r of pg.regions) open.push(box(r, S, COLOR[r.type], r.type === 'block' ? edsType(r) : r.type));
  open.push('</div>');
  const counts = pg.regions.reduce((m, r) => (m[r.type] = (m[r.type] || 0) + 1, m), {});
  return `<h3>${esc(pg.url)}${hasBg ? '' : '  <em>(no screenshot)</em>'}</h3><p class="cnt">block:${counts.block || 0} chrome:${counts.chrome || 0} prose:${counts.prose || 0}</p>${open.join('')}`;
}

// ---- lattice overlay (detected repeating peers drawn on the page) ----------
function renderLatticePage(pg, S) {
  const { open } = backdrop(pg, S);
  const lats = detectPageLattices(pg.nodes);
  for (const L of lats) {
    const color = L.hasImage ? '#d6009e' : '#e07b00';
    const label = `${L.axis}×${L.count}  ${L.tokens.slice(0, 5).join('+')}`;
    open.push(box(L.bbox, S, color, label, 'lt'));
  }
  open.push('</div>');
  return `<h3>${esc(pg.url)}</h3><p class="cnt">${lats.length} repeating peers</p>${open.join('')}`;
}

function latticeHtml(perPage, { nSamples = 8 } = {}) {
  const hasShot = (pg) => pg.dir && fs.existsSync(path.join(pg.dir, 'screenshots', 'source-full.png'));
  const sample = [...perPage].sort((a, b) => (hasShot(b) ? 1 : 0) - (hasShot(a) ? 1 : 0)).slice(0, nSamples);
  const s0W = sample[0] ? (sample[0].width || Math.max(...sample[0].nodes.map((n) => n.x + n.w), 900)) : 900;
  const S = 900 / s0W;
  const body = sample.map((pg) => renderLatticePage(pg, S)).join('<hr>');
  return `<!doctype html><meta charset="utf8"><title>scoper lattices</title>
<style>
 body{font:13px system-ui;margin:20px;color:#222}
 .legend span{display:inline-block;padding:2px 8px;margin-right:6px;border-radius:3px;color:#fff}
 .page{position:relative;border:1px solid #eee;margin:8px 0 28px;background:#fff;overflow:hidden}
 .bg{position:absolute;left:0;top:0;opacity:.5}
 .lt{position:absolute;border:3px solid;border-radius:3px;box-sizing:border-box}
 .lt .tag{position:absolute;left:-1px;top:-16px;font-size:10px;color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap;font-family:ui-monospace,monospace;z-index:2}
 .tx{position:absolute;color:#555;overflow:hidden;white-space:nowrap;line-height:1}
 .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:9px;text-align:center;box-sizing:border-box}
 h3{margin:24px 0 2px;font-size:13px;color:#555;word-break:break-all}
 .cnt{margin:0 0 6px;color:#888;font-family:ui-monospace,monospace} hr{border:0;border-top:1px dashed #ddd;margin:30px 0}
</style>
<h2>scoper — detected repeating peers (lattices)</h2>
<p class="legend"><span style="background:#d6009e">image-anchored (cards/gallery/media)</span><span style="background:#e07b00">text-only (list/columns/grid)</span></p>
<p>${perPage.length} pages · showing ${sample.length}. Each box = a repeating peer; label = axis×count + content-blind composition.</p>
${body}`;
}

function regionsHtml(perPage, { nSamples = 8, title = 'scoper regions' } = {}) {
  const hasShot = (pg) => pg.dir && fs.existsSync(path.join(pg.dir, 'screenshots', 'source-full.png'));
  const sample = [...perPage].sort((a, b) => (hasShot(b) ? 1 : 0) - (hasShot(a) ? 1 : 0)).slice(0, nSamples);
  const s0W = sample[0] ? (sample[0].width || Math.max(...sample[0].nodes.map((n) => n.x + n.w), 900)) : 900;
  const S = 900 / s0W;
  const body = sample.map((pg) => renderPage(pg, S)).join('<hr>');
  return `<!doctype html><meta charset="utf8"><title>${esc(title)}</title>
<style>
 body{font:13px system-ui;margin:20px;color:#222}
 .legend span{display:inline-block;padding:2px 8px;margin-right:6px;border-radius:3px;color:#fff}
 .page{position:relative;border:1px solid #eee;margin:8px 0 28px;background:#fff;overflow:hidden}
 .bg{position:absolute;left:0;top:0;opacity:.45}
 .rg{position:absolute;border:2px solid;border-radius:3px;box-sizing:border-box}
 .rg .tag{position:absolute;left:-1px;top:-16px;font-size:10px;color:#fff;padding:1px 5px;border-radius:3px;white-space:nowrap;font-family:ui-monospace,monospace;z-index:2}
 .tx{position:absolute;color:#555;overflow:hidden;white-space:nowrap;line-height:1}
 .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:9px;text-align:center;box-sizing:border-box}
 h3{margin:24px 0 2px;font-size:13px;color:#555;word-break:break-all} h3 em{color:#b98}
 .cnt{margin:0 0 6px;color:#888;font-family:ui-monospace,monospace} hr{border:0;border-top:1px dashed #ddd;margin:30px 0}
</style>
<h2>scoper — regions + EDS type</h2>
<p class="legend"><span style="background:${COLOR.block}">block (EDS type guess)</span><span style="background:${COLOR.chrome}">chrome</span><span style="background:${COLOR.prose}">prose</span></p>
<p>${perPage.length} pages · showing ${sample.length}. Faded backdrop = page screenshot; box = region; green label = algorithmic EDS block type.</p>
${body}`;
}

// ---- real screenshot crop of an example instance --------------------------
// node/region coords map to screenshot pixels by DPR (see lib/image-hash.js, which uses them
// 1:1 at dpr=1). Crop the example region's bbox from its page screenshot -> small PNG data URI.
async function cropExample(block) {
  const ex = block.example, pg = ex && ex.pg;
  if (!pg || !pg.dir) return null;
  const shot = path.join(pg.dir, 'screenshots', 'source-full.png');
  if (!fs.existsSync(shot)) return null;
  try {
    const dpr = pg.dpr || 1;
    const r = ex.region;
    const meta = await sharp(shot).metadata();
    let left = Math.max(0, Math.round(r.x * dpr));
    let top = Math.max(0, Math.round(r.y * dpr));
    if (left >= meta.width || top >= meta.height) return null; // off-screen (e.g. overflow slide)
    const width = Math.max(1, Math.min(Math.round(r.w * dpr), meta.width - left));
    const height = Math.max(1, Math.min(Math.round(r.h * dpr), meta.height - top));
    const buf = await sharp(shot).extract({ left, top, width, height })
      .resize({ width: Math.min(width, 360), withoutEnlargement: true }).png().toBuffer();
    return `data:image/png;base64,${buf.toString('base64')}`;
  } catch { return null; }
}

// mutate: attach block.crop (real screenshot) to each catalog block that has a screenshot
async function attachCrops(catalog) {
  for (const b of catalog) { if (b.pageCount >= 2) b.crop = await cropExample(b); }
  return catalog;
}

// ---- catalog / scoping report ---------------------------------------------
function thumb(example, maxW = 340) {
  const rn = example.region.nodes;
  const ox = Math.min(...rn.map((n) => n.x)), oy = Math.min(...rn.map((n) => n.y));
  const w = example.region.w, h = example.region.h;
  const S = Math.min(maxW / Math.max(w, 1), 0.5);
  const parts = [`<div class="th" style="width:${(w * S).toFixed(0)}px;height:${(h * S).toFixed(0)}px">`];
  for (const n of rn) {
    const l = ((n.x - ox) * S).toFixed(0), t = ((n.y - oy) * S).toFixed(0), nw = (n.w * S).toFixed(0), nh = (n.h * S).toFixed(0);
    if (n.kind === 'text') parts.push(`<div class="tx" style="left:${l}px;top:${t}px;width:${nw}px;height:${nh}px;font-size:${Math.max(6, n.fontSize * S).toFixed(0)}px;font-weight:${esc(n.fontWeight)}">${esc(n.text || '')}</div>`);
    else parts.push(`<div class="im" style="left:${l}px;top:${t}px;width:${nw}px;height:${nh}px">img</div>`);
  }
  parts.push('</div>');
  return parts.join('');
}

function catalogHtml(catalog, { pages } = {}) {
  const blocks = catalog.filter((b) => b.pageCount >= 2);
  const cards = blocks.map((b, i) => `
  <div class="card">
    <div class="hd"><span class="rk">#${i + 1}</span><span class="ty">${esc(b.type)}</span>${b.isCollection ? '<span class="cl">collection</span>' : ''}</div>
    <div class="st">${b.pageCount} pages · ${b.instances} instances${b.maxRepeat > 1 ? ` · up to ${b.maxRepeat}× repeat` : ''}</div>
    <div class="sig">${esc(b.key)}</div>
    ${b.crop ? `<img class="shot" src="${b.crop}" alt="example">` : thumb(b.example)}
    <div class="sm">${b.samples.slice(0, 4).map((s) => esc(s)).join(' · ')}</div>
  </div>`).join('');
  return `<!doctype html><meta charset="utf8"><title>scoper — block catalog</title>
<style>
 body{font:13px system-ui;margin:22px;color:#1c1c1c;background:#fafafa}
 h2{margin:0 0 4px} .lead{color:#666;margin:0 0 18px}
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:16px}
 .card{background:#fff;border:1px solid #e6e6e6;border-radius:8px;padding:12px 14px}
 .hd{display:flex;align-items:center;gap:8px;margin-bottom:2px}
 .rk{color:#999;font-family:ui-monospace,monospace;font-size:12px} .ty{font-weight:600;font-size:15px}
 .cl{background:#1a9e6a;color:#fff;font-size:10px;padding:1px 7px;border-radius:10px}
 .st{color:#555;font-size:12px;margin-bottom:4px}
 .sig{font-family:ui-monospace,monospace;font-size:11px;color:#1a9e6a;background:#f2faf6;border:1px solid #d6efe3;border-radius:4px;padding:3px 6px;margin-bottom:10px;word-break:break-all}
 .shot{display:block;max-width:100%;border:1px solid #ddd;border-radius:4px;margin:0 auto 8px}
 .th{position:relative;border:1px solid #eee;background:#fff;margin:0 auto 8px}
 .th .tx{position:absolute;color:#333;overflow:hidden;white-space:nowrap;line-height:1}
 .th .im{position:absolute;background:#f0ede6;border:1px dashed #b7ad97;color:#b7ad97;font-size:8px;text-align:center;box-sizing:border-box}
 .sm{color:#888;font-size:11px;border-top:1px dashed #eee;padding-top:6px}
</style>
<h2>scoper — source block catalog</h2>
<p class="lead">${pages || ''} pages · ${blocks.length} recurring block types (deterministic, no AI). Ranked by reach. Type = algorithmic guess; signature = content-blind repeating unit; example = one real instance.</p>
<div class="grid">${cards}</div>`;
}

module.exports = { scope, regionsHtml, catalogHtml, latticeHtml, attachCrops };
