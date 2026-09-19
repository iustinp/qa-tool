/*
 * scoper/features.js — content-blind FEATURE VECTOR for a set of pear nodes (issue #65, Step 2).
 *
 * Shared by band-class.js (typing) and analyze.js (learning) so a detected band and a user-drawn
 * region are described identically. The vector captures the same signals the deterministic subtype
 * tree uses (image repetition + axis, text columns/rows, size tiers, display heading, wide image,
 * densities), normalised to ~0..1 so plain Euclidean distance is meaningful. No AI.
 */

const { styleToken } = require('./signature');

const IMG_FLOOR = 64, DISPLAY = 48;
const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);

// how many distinct clusters the sorted values form, splitting on gaps > `gap`
function clusters(vals, gap) {
  const s = [...vals].sort((a, b) => a - b);
  let c = s.length ? 1 : 0;
  for (let i = 1; i < s.length; i++) if (s[i] - s[i - 1] > gap) c++;
  return c;
}

// per style-token within a node set: instances, x-columns, y-rows, median size (repetition signal).
function tokenStats(nodes) {
  const by = new Map();
  for (const n of nodes) { const t = styleToken(n); if (!by.has(t)) by.set(t, []); by.get(t).push(n); }
  const out = [];
  for (const [t, g] of by) {
    const w = median(g.map((n) => n.w)) || 40, h = median(g.map((n) => n.h)) || 20;
    out.push({
      t, count: g.length, isImg: t.startsWith('IMG'), medW: w, medH: h,
      size: t.startsWith('IMG') ? 0 : median(g.map((n) => n.fontSize || 0)),
      cols: clusters(g.map((n) => n.x + n.w / 2), Math.max(20, w * 0.5)),
      rows: clusters(g.map((n) => n.y + n.h / 2), Math.max(12, h * 0.5)),
    });
  }
  return out;
}

const cap = (x, c) => Math.min((x || 0) / c, 1);

// The ordered feature keys — vecDist iterates these.
const FKEYS = ['hasImage', 'imgCols', 'imgRows', 'imgAspect', 'textCols', 'textRows', 'sizeTiers', 'hasDisplay', 'wideImgFrac', 'textDensity', 'imgDensity'];

function featureVector(nodes, pageW) {
  const ts = tokenStats(nodes);
  const imgs = nodes.filter((n) => n.kind !== 'text');
  const texts = nodes.filter((n) => n.kind === 'text');
  const bigImgs = imgs.filter((n) => Math.min(n.w, n.h) >= IMG_FLOOR);
  const imgRep = ts.filter((s) => s.isImg && Math.min(s.medW, s.medH) >= IMG_FLOOR && s.cols >= 2 && s.count >= 2)
    .reduce((m, s) => (s.cols > m.cols ? { cols: s.cols, rows: s.rows } : m), { cols: 0, rows: 0 });
  const txtRep = ts.filter((s) => !s.isImg && s.size < DISPLAY && s.cols >= 2 && s.count >= 2)
    .reduce((m, s) => (s.cols > m.cols ? { cols: s.cols, rows: s.rows } : m), { cols: 0, rows: 0 });
  const avgAr = bigImgs.length ? bigImgs.reduce((s, n) => s + n.w / Math.max(1, n.h), 0) / bigImgs.length : 0;
  const maxImgW = imgs.reduce((m, n) => Math.max(m, n.w), 0);
  const tiers = new Set(texts.map((t) => Math.round((t.fontSize || 0) / 2) * 2));

  return {
    hasImage: bigImgs.length ? 1 : 0,
    imgCols: cap(imgRep.cols, 6),
    imgRows: cap(imgRep.rows, 4),
    imgAspect: bigImgs.length ? cap(avgAr, 3) : 0,
    textCols: cap(txtRep.cols, 6),
    textRows: cap(txtRep.rows, 4),
    sizeTiers: cap(tiers.size, 4),
    hasDisplay: texts.some((t) => (t.fontSize || 0) >= DISPLAY) ? 1 : 0,
    wideImgFrac: pageW ? Math.min(maxImgW / pageW, 1) : 0,
    textDensity: cap(texts.length, 12),
    imgDensity: cap(bigImgs.length, 8),
  };
}

function vecDist(a, b) {
  let s = 0;
  for (const k of FKEYS) { const d = (a[k] || 0) - (b[k] || 0); s += d * d; }
  return Math.sqrt(s);
}

// node sets from geometry
const nodesInBand = (nodes, y0, y1) => nodes.filter((n) => (n.y + n.h) > y0 && n.y < y1);
const nodesInRect = (nodes, r) => nodes.filter((n) => {
  const cx = n.x + n.w / 2, cy = n.y + n.h / 2;
  return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h;
});

module.exports = { tokenStats, featureVector, vecDist, FKEYS, nodesInBand, nodesInRect, IMG_FLOOR, DISPLAY };
