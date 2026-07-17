/**
 * canonical-compare — compare two Canonical Layout Models (pears). Because a
 * pear is just reading-ordered positioned text (plus image placeholders), the
 * hard-won text-layout comparator already does exactly what we need: fuzzy
 * sequence alignment with drift re-sync, reflow reconciliation, moved/reordered
 * detection, and a layout-drift signal. So we adapt the CLM into the fingerprint
 * shape and reuse it, rather than reinventing the matcher.
 *
 * Coordinates are NOT normalized to a shared 0..1 space: source and target
 * differ in height, and proportional-y would smear every position once one page
 * has more/less content. The sequence alignment already handles vertical drift
 * by reading order; absolute coords are kept only for the overlay and the
 * per-item layout-drift gap comparison.
 */

const { buildFingerprint } = require('./text-geometry');
const { compareTextLayout, alignForOverlay } = require('./text-layout-compare');
const { hamming } = require('./image-hash');

/** CLM → the {text,x,y,w,h,fontSize} items buildFingerprint expects. */
function clmTextItems(clm) {
  return (clm.nodes || [])
    .filter((n) => n.kind === 'text')
    .map((n) => ({ text: n.text, x: n.x, y: n.y, w: n.w, h: n.h, fontSize: n.fontSize }));
}

const imgLabel = (n) => (n.src ? n.src.split('/').pop().split('?')[0].slice(0, 40) : n.tag || n.kind || 'image');

/**
 * Match content images (those with a dHash) across the two pears by Hamming
 * distance, greedily, tie-broken by position — so decorative duplicates pair by
 * where they sit. Produces overlay items (same shape as the text alignment) so
 * images render as matched/missing/extra boxes alongside text. Sub-floor icons
 * are matched opportunistically by filename and never flagged as diffs (chrome).
 * @returns {{ source: Array, target: Array, matched: number, missing: number, extra: number }}
 */
function matchImages(sourceClm, targetClm, opts = {}) {
  const maxHam = opts.imageHammingMax ?? 10;
  const imgs = (clm) => (clm.nodes || []).filter((n) => n.kind !== 'text');
  const S = imgs(sourceClm);
  const T = imgs(targetClm);
  const sHash = S.filter((n) => n.hash);
  const tHash = T.filter((n) => n.hash);

  // All in-threshold candidate pairs, best (closest hash, then nearest) first.
  const cands = [];
  sHash.forEach((s, si) =>
    tHash.forEach((t, ti) => {
      const d = hamming(s.hash, t.hash);
      if (d <= maxHam) cands.push({ si, ti, d, pos: Math.abs(s.y - t.y) + Math.abs(s.x - t.x) });
    })
  );
  cands.sort((a, b) => a.d - b.d || a.pos - b.pos);
  const usedS = new Set();
  const usedT = new Set();
  const pairOf = new Map(); // si -> ti
  for (const c of cands) {
    if (usedS.has(c.si) || usedT.has(c.ti)) continue;
    usedS.add(c.si);
    usedT.add(c.ti);
    pairOf.set(c.si, c.ti);
  }

  let n = 0;
  const source = [];
  const target = [];
  const mk = (node, idx, matched, counterpart) => ({
    idx,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    text: imgLabel(node),
    matched,
    moved: false,
    kind: 'image',
    icon: !!node.icon,
    counterpart: counterpart ? { x: counterpart.x, y: counterpart.y, w: counterpart.w, h: counterpart.h, text: imgLabel(counterpart) } : null,
  });
  sHash.forEach((s, si) => {
    n += 1;
    const ti = pairOf.get(si);
    const t = ti != null ? tHash[ti] : null;
    source.push(mk(s, `i${n}`, !!t, t));
    if (t) target.push(mk(t, `i${n}:0`, true, s));
  });
  let extra = 0;
  tHash.forEach((t, ti) => {
    if (usedT.has(ti)) return;
    extra += 1;
    target.push(mk(t, `i+${extra}`, false, null));
  });
  const matched = pairOf.size;
  return { source, target, matched, missing: sHash.length - matched, extra };
}

/**
 * Compare source and target CLMs (text + images).
 * @returns {{ audit, alignment, sourceFingerprint, targetFingerprint }}
 */
function compareCanonical(sourceClm, targetClm, opts = {}) {
  // Inline-run coalescing is available (opts.coalesceInline) for pages whose
  // markup splits phrases badly, but it's off by default: reflow reconciliation
  // already absorbs most splits, and forcing merges can turn a reconciled pair
  // into a whole-phrase mismatch. Turn on per-recipe where it demonstrably helps.
  const sourceFingerprint = buildFingerprint(clmTextItems(sourceClm), opts);
  const targetFingerprint = buildFingerprint(clmTextItems(targetClm), opts);
  const audit = compareTextLayout(sourceFingerprint, targetFingerprint, opts);
  const alignment = alignForOverlay(sourceFingerprint, targetFingerprint, opts);

  // Images: matched/missing/extra as overlay items appended to the alignment.
  const img = matchImages(sourceClm, targetClm, opts);
  alignment.source.push(...img.source);
  alignment.target.push(...img.target);
  audit.imageMatchedCount = img.matched;
  audit.imageMissingCount = img.missing;
  audit.imageExtraCount = img.extra;

  return { audit, alignment, sourceFingerprint, targetFingerprint };
}

module.exports = { compareCanonical, clmTextItems, matchImages };
