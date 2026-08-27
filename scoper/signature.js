/*
 * Shared, content-blind pear signature primitives (issue #65).
 * One source of truth so every scoper step keys off the identical descriptor.
 */

const fs = require('fs');
const path = require('path');

const K = 3; // nearest neighbours per node

// ---- style token: a node's ROLE, content-blind ----------------------------
function sizeBucket(fs_) { return Math.round((fs_ || 0) / 2) * 2; }          // light px quantise
function weightBucket(fw) { const n = parseInt(fw, 10); return (n >= 600 || fw === 'bold') ? 'b' : 'r'; }
function alignBucket(a) { return a === 'center' ? 'c' : (a === 'right' || a === 'end') ? 'r' : 'l'; }
function aspectBucket(w, h) {
  const ar = w / Math.max(1, h);
  return ar > 2 ? 'wide' : ar < 0.6 ? 'tall' : ar > 1.3 ? 'land' : ar < 0.8 ? 'port' : 'sq';
}
function styleToken(n) {
  if (n.kind === 'text') {
    const up = n.textTransform === 'uppercase' ? 'U' : '';
    const it = n.fontStyle && n.fontStyle !== 'normal' ? 'I' : '';
    return `T${sizeBucket(n.fontSize)}${weightBucket(n.fontWeight)}${up}${it}${alignBucket(n.align)}`;
  }
  if (n.kind === 'image' || n.kind === 'bg-image') return `IMG-${aspectBucket(n.w, n.h)}`;
  return 'X';
}

// ---- ordinal direction between two node ORIGINS ---------------------------
function dir(a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  if (Math.abs(dy) >= Math.abs(dx)) return dy > 0 ? 'S' : 'N';   // below / above
  return dx > 0 ? 'E' : 'W';                                     // right / left
}
function d2(a, b) { const dx = b.x - a.x, dy = b.y - a.y; return dx * dx + dy * dy; }

// descriptor key for one node given its page's node list
function descriptor(node, all) {
  const own = styleToken(node);
  const nb = all
    .filter((n) => n !== node)
    .sort((p, q) => d2(node, p) - d2(node, q))
    .slice(0, K)
    .map((n) => `${dir(node, n)}:${styleToken(n)}`)
    .sort();                                                     // order-independent key
  return `${own}|${nb.join(',')}`;
}

// the "content value" of a node — what would VARY between block instances but be
// FIXED for site chrome: visible text, or image source.
function contentValue(node) {
  if (node.kind === 'text') return (node.text || '').trim();
  if (node.kind === 'image' || node.kind === 'bg-image') return node.src || '';
  return '';
}

// ---- corpus loader ---------------------------------------------------------
// Returns [{ url, nodes }] for every source pear under runDir/<pair>/source-clm.json.
function loadPears(runDir, file = 'source-clm.json') {
  const out = [];
  for (const d of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const f = path.join(runDir, d.name, file);
    if (!fs.existsSync(f)) continue;
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (Array.isArray(j.nodes) && j.nodes.length) out.push({ url: j.url || d.name, nodes: j.nodes, dir: path.join(runDir, d.name) });
    } catch { /* skip unreadable */ }
  }
  return out;
}

module.exports = { K, styleToken, dir, d2, descriptor, contentValue, loadPears };
