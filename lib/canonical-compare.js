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
  // Matched-text anchors {x,y,cx,cy}: source text origin → its target origin.
  const anchors = opts.anchors || [];
  const imgs = (clm) => (clm.nodes || []).filter((n) => n.kind !== 'text');
  const S = imgs(sourceClm);
  const T = imgs(targetClm);
  const sHash = S.filter((n) => n.hash);
  const tHash = T.filter((n) => n.hash);

  // Predict where a source point should land on the target, from the nearest
  // matched-text anchor + the point's offset from that anchor. Text matches
  // reliably and local relative layout is usually preserved, so this is far more
  // stable than absolute position (which drifts as content differs down-page).
  const predict = (x, y) => {
    let best = null;
    let bd = Infinity;
    for (const a of anchors) {
      const d = Math.hypot(a.x - x, a.y - y);
      if (d < bd) {
        bd = d;
        best = a;
      }
    }
    return best ? { px: best.cx + (x - best.x), py: best.cy + (y - best.y), anchorDist: bd } : null;
  };

  // Candidate pairs within the hash threshold. When an anchor exists, gate to a
  // window around the predicted position (looser the further the anchor is, so a
  // confidently-near-text image is matched tightly) and score by prediction
  // error; otherwise fall back to absolute position — greatly cuts false pairs.
  const cands = [];
  sHash.forEach((s, si) => {
    const p = predict(s.x, s.y);
    const win = p ? Math.max(60, 1.5 * p.anchorDist) : Infinity;
    tHash.forEach((t, ti) => {
      const d = hamming(s.hash, t.hash);
      if (d > maxHam) return;
      let posErr;
      if (p) {
        posErr = Math.hypot(t.x - p.px, t.y - p.py);
        if (posErr > win) return;
      } else {
        posErr = Math.abs(s.y - t.y) + Math.abs(s.x - t.x);
      }
      cands.push({ si, ti, d, pos: posErr });
    });
  });
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

  // Consistency pass: identical instances must share a verdict. The hash of the
  // "same" repeated image (a card icon/background used N times) jitters a bit per
  // instance, so a hard threshold can match one instance and miss its twin by a
  // single bit. For each UNMATCHED source image that is near-identical to a
  // MATCHED one, assign it to an unused target instance of the same image
  // (near-identical to the matched sibling's counterpart), nearest by predicted
  // position — never inventing a match when no such target instance remains (so
  // a genuinely dropped instance stays missing).
  const dup = opts.imageDupHamming ?? 6;
  for (let su = 0; su < sHash.length; su++) {
    if (pairOf.has(su)) continue;
    let refTi = -1;
    for (let sr = 0; sr < sHash.length; sr++) {
      if (sr === su || !pairOf.has(sr)) continue;
      if (hamming(sHash[su].hash, sHash[sr].hash) <= dup) {
        refTi = pairOf.get(sr);
        break;
      }
    }
    if (refTi < 0) continue;
    const s = sHash[su];
    const p = predict(s.x, s.y);
    const tx = p ? p.px : s.x;
    const ty = p ? p.py : s.y;
    let best = -1;
    let bd = Infinity;
    for (let ti = 0; ti < tHash.length; ti++) {
      if (usedT.has(ti)) continue;
      if (hamming(tHash[ti].hash, tHash[refTi].hash) > dup) continue;
      const d = Math.hypot(tHash[ti].x - tx, tHash[ti].y - ty);
      if (d < bd) {
        bd = d;
        best = ti;
      }
    }
    if (best >= 0) {
      usedT.add(best);
      pairOf.set(su, best);
    }
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
  // Anchor image matching to the reliable text matches: each matched (non-moved)
  // source text with a counterpart is a source→target position anchor.
  const anchors = alignment.source
    .filter((i) => i.matched && !i.moved && i.counterpart)
    .map((i) => ({ x: i.x, y: i.y, cx: i.counterpart.x, cy: i.counterpart.y }));
  const img = matchImages(sourceClm, targetClm, { ...opts, anchors });
  alignment.source.push(...img.source);
  alignment.target.push(...img.target);
  audit.imageMatchedCount = img.matched;
  audit.imageMissingCount = img.missing;
  audit.imageExtraCount = img.extra;

  return { audit, alignment, sourceFingerprint, targetFingerprint };
}

module.exports = { compareCanonical, clmTextItems, matchImages };
