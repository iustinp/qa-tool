/*
 * Step #2 — region assembly (issue #65).
 *
 * A single global gap threshold can't segment a whole page (it fragments spaced nav items and
 * swallows a card row into the adjacent footer). Instead we LABEL every node first, using what
 * step #1 already knows, then cluster only the sparse "block" foreground:
 *
 *   node label:
 *     - chrome : its descriptor is a chrome/label bucket (site frame / nav / legal).
 *     - prose  : homogeneous body text (own + neighbour style-tokens all equal, no image)
 *                -> EDS default content.
 *     - block  : heterogeneous local structure (mixed size tiers, or an image nearby)
 *                -> the interesting foreground.
 *
 * Then union-find grows clusters SEEDED on block nodes (a block node may absorb an adjacent
 * node of any label — this reunites fixed scaffolding like "Read more"/eyebrows/section
 * headings with the varying card content), while background (chrome/prose) only merges with
 * its own kind. So a teaser card assembles as ONE block region; the footer stays chrome.
 *
 * Each region gets a content-blind SIGNATURE (reading-order style-token sequence, run-length
 * compressed) — the key step #3 groups on across pages to build the site block catalog.
 */

const { styleToken, descriptor } = require('./signature');
const { CHROME_BUCKETS } = require('./chrome');

function boxGap(a, b) {
  const hx = Math.max(0, Math.max(a.x, b.x) - Math.min(a.x + a.w, b.x + b.w));
  const hy = Math.max(0, Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h));
  return Math.hypot(hx, hy);
}
function median(xs) { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; }
function sizeBucket(fs) { return Math.round((fs || 0) / 2) * 2; }
function gcd2(a, b) { while (b) { [a, b] = [b, a % b]; } return a; }
function tokSize(t) { if (t.startsWith('IMG')) return 'i'; const m = t.match(/^T(\d+)/); return m ? m[1] : '?'; }

function makeUF(n) {
  const p = Array.from({ length: n }, (_, i) => i);
  const find = (i) => { while (p[i] !== i) { p[i] = p[p[i]]; i = p[i]; } return i; };
  const union = (a, b) => { p[find(a)] = find(b); };
  return { find, union };
}

// descriptor key -> [ownToken, neighbourToken, ...]
function keyTokens(key) {
  const [own, rest] = key.split('|');
  const nb = rest ? rest.split(',').map((s) => s.split(':')[1]) : [];
  return [own, ...nb];
}
// node label SEEDS the clustering (kept as the validated version: heterogeneous local structure
// or an image -> block seed). The prose-vs-block refinement lives in the FINAL region type
// (structuralType), NOT here, so assembly/merge stay exactly as validated.
function labelNode(key, bucket) {
  if (CHROME_BUCKETS.has(bucket)) return 'chrome';
  const toks = keyTokens(key);
  const hasImg = toks.some((t) => t.startsWith('IMG'));
  const homogeneous = toks.every((t) => t === toks[0]);
  return homogeneous && !hasImg ? 'prose' : 'block';
}

// reading-order style-token sequence, run-length compressed
function regionSignature(nodes) {
  const ordered = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x).map(styleToken);
  const out = [];
  for (const t of ordered) { const l = out[out.length - 1]; if (l && l.t === t) l.n++; else out.push({ t, n: 1 }); }
  return out.map((r) => (r.n > 1 ? `${r.t}*${r.n}` : r.t)).join('>');
}

// nodes: pear nodes for ONE page. keyBucket: Map<descriptorKey, bucket> from chrome.classifyDescriptors.
function assembleRegions(nodes, keyBucket) {
  const n = nodes.length;
  const textH = nodes.filter((x) => x.kind === 'text').map((x) => x.h);
  const gapThresh = Math.max(28, median(textH) * 2.0); // whitespace break, scaled to page type size

  const keyOf = nodes.map((node) => descriptor(node, nodes));
  const label = keyOf.map((k, i) => labelNode(k, keyBucket.get(k)));

  const uf = makeUF(n);
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (boxGap(nodes[i], nodes[j]) >= gapThresh) continue;
      const bi = label[i] === 'block', bj = label[j] === 'block';
      // grow block clusters into any neighbour; else only merge same-kind background
      if (bi || bj || label[i] === label[j]) uf.union(i, j);
    }
  }
  const groups = [...new Map(nodes.map((_, i) => [uf.find(i), null])).keys()]
    .map((root) => nodes.map((_, i) => i).filter((i) => uf.find(i) === root));

  const bbox = (idxs) => {
    const rn = idxs.map((i) => nodes[i]);
    return {
      x: Math.min(...rn.map((r) => r.x)), y: Math.min(...rn.map((r) => r.y)),
      x2: Math.max(...rn.map((r) => r.x + r.w)), y2: Math.max(...rn.map((r) => r.y + r.h)),
    };
  };
  // merge/assembly type (validated): a component is "block" if ANY member is a block seed.
  // Used ONLY to decide which components merge — keeps card assembly exactly as validated.
  const labelType = (idxs) => {
    const ls = idxs.map((i) => label[i]);
    return ls.includes('block') ? 'block' : ls.includes('prose') ? 'prose' : 'chrome';
  };

  // FINAL reported type — structural, so a body paragraph with a bold run or a caption is
  // body-DOMINATED -> prose; a card/columns is a COLLECTION or has an image or balanced tiers.
  const structuralType = (idxs) => {
    const rn = idxs.map((i) => nodes[i]);
    const chromeFrac = idxs.filter((i) => label[i] === 'chrome').length / rn.length;
    if (chromeFrac >= 0.6) return 'chrome';
    const texts = rn.filter((x) => x.kind === 'text');
    const images = rn.filter((x) => x.kind !== 'text');
    const counts = new Map();
    for (const n of rn) { const t = styleToken(n); counts.set(t, (counts.get(t) || 0) + 1); }
    const repeat = [...counts.values()].reduce((a, b) => gcd2(a, b), 0) || 1;
    // a real COLLECTION is a multi-part unit repeated (>=2 distinct tokens); N copies of ONE
    // token is just uniform body text, not a collection.
    if (repeat >= 2 && counts.size >= 2) return 'block'; // cards / columns / list
    if (images.length >= 1) return 'block';     // media / hero / single card
    const tiers = new Map();
    for (const t of texts) { const s = sizeBucket(t.fontSize); tiers.set(s, (tiers.get(s) || 0) + 1); }
    const dom = texts.length ? Math.max(...tiers.values()) / texts.length : 0;
    if (dom >= 0.6) return 'prose';             // body-text dominated -> default content
    return 'block';                             // genuinely mixed single instance
  };

  // second pass — merge neighbouring BLOCK components into one region: a card's thumbnail + text
  // and the sibling cards of a ROW become a single block. This is HORIZONTAL adjacency only:
  // two components merge when their vertical ranges OVERLAP (same row) and their horizontal gap
  // is small. Requiring y-overlap makes a runaway VERTICAL chain down a dense page impossible
  // (that was the EDC failure — leaked nav chained the whole 5047px page into one blob); a
  // vertically-stacked list stays as separate per-item regions, which step A groups cross-page.
  const MERGE = Math.max(80, gapThresh * 2.5);
  const gi = groups.map((idxs) => ({ idxs, box: bbox(idxs), type: labelType(idxs) }));
  const ruf = makeUF(gi.length);
  for (let a = 0; a < gi.length; a++) {
    for (let b = a + 1; b < gi.length; b++) {
      if (gi[a].type !== 'block' || gi[b].type !== 'block') continue;
      const A = gi[a].box, B = gi[b].box;
      const vOverlap = Math.min(A.y2, B.y2) - Math.max(A.y, B.y);  // >0 => share a horizontal band
      const hx = Math.max(0, Math.max(A.x, B.x) - Math.min(A.x2, B.x2));
      if (vOverlap > 0 && hx < MERGE) ruf.union(a, b);
    }
  }
  const merged = new Map();
  for (let a = 0; a < gi.length; a++) { const r = ruf.find(a); if (!merged.has(r)) merged.set(r, []); merged.get(r).push(...gi[a].idxs); }

  const regions = [];
  for (const idxs of merged.values()) {
    const rn = idxs.map((i) => nodes[i]);
    const type = structuralType(idxs);
    const texts = rn.filter((x) => x.kind === 'text');
    const images = rn.filter((x) => x.kind !== 'text');
    const tiers = new Set(texts.map((t) => sizeBucket(t.fontSize)));
    const bb = bbox(idxs);
    regions.push({
      type, x: bb.x, y: bb.y, w: bb.x2 - bb.x, h: bb.y2 - bb.y,
      count: rn.length, textCount: texts.length, imageCount: images.length, tiers: tiers.size,
      signature: regionSignature(rn), nodes: rn,
    });
  }
  return regions.filter((r) => r.count >= 2).sort((a, b) => a.y - b.y || a.x - b.x);
}

module.exports = { assembleRegions, boxGap, regionSignature, labelNode };
