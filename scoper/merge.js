/*
 * scoper/merge.js — store-driven band MERGE (issue #65), the segmentation-merge step.
 *
 * The band-cut splits some blocks (e.g. a card's image row from its text row at the whitespace gap).
 * ⧉ fragment corrections teach the store TWO things: a NEGATIVE guard on the over-fired type ("an
 * image row like this, alone, is a false positive") and a positive PROTOTYPE for the true block
 * (from the drawn region that spanned both rows). This pass uses both: when a band matches a known
 * fragment-guard, try growing a window over the adjacent bands; keep the SMALLEST merge whose
 * combined region confidently matches a learned block type, and emit it as one segment of that type.
 * Fully deterministic; a no-op on an empty store or when nothing matches (so it never over-merges).
 */

const { featureVector, nodesInBand } = require('./features');
const { typeOf, nearNegative } = require('./store');

const MAX_SPAN = 4;   // merge at most this many adjacent bands
const GAP_CAP = 200;  // don't grow a merge across a gap this large (that's a real section break)

function mergeSegments(bands, pageNodes, pageW, store) {
  if (!store || !store.types || !Object.keys(store.types).length) return bands.map((b) => ({ ...b }));
  const out = [];
  let i = 0;
  while (i < bands.length) {
    const vec = featureVector(nodesInBand(pageNodes, bands[i].y0, bands[i].y1), pageW);
    if (nearNegative(store, vec)) {                 // bands[i] alone is a known fragment
      let best = null;
      for (let j = i + 1; j < bands.length && j - i < MAX_SPAN; j++) {
        if (bands[j].y0 - bands[j - 1].y1 > GAP_CAP) break;   // big whitespace -> real section boundary
        const mt = typeOf(store, featureVector(nodesInBand(pageNodes, bands[i].y0, bands[j].y1), pageW));
        if (mt.type) { best = { j, type: mt.type }; break; }  // smallest window that confidently matches
      }
      if (best) {
        out.push({ y0: bands[i].y0, y1: bands[best.j].y1, x0: 0, x1: pageW, forcedType: best.type, mergedFrom: best.j - i + 1 });
        i = best.j + 1;
        continue;
      }
    }
    out.push({ ...bands[i] });
    i++;
  }
  return out;
}

module.exports = { mergeSegments };
