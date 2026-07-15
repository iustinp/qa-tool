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

/** CLM → the {text,x,y,w,h,fontSize} items buildFingerprint expects. */
function clmTextItems(clm) {
  return (clm.nodes || [])
    .filter((n) => n.kind === 'text')
    .map((n) => ({ text: n.text, x: n.x, y: n.y, w: n.w, h: n.h, fontSize: n.fontSize }));
}

/**
 * Compare source and target CLMs.
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
  return { audit, alignment, sourceFingerprint, targetFingerprint };
}

module.exports = { compareCanonical, clmTextItems };
