/*
 * scoper/band-cut.js — top-down horizontal band segmentation (issue #65 probe).
 *
 * Hypothesis: a web page is visually a vertical stack of full-width sections, so cutting it at
 * full-width whitespace valleys should segment it into clean sections far more robustly than the
 * current bottom-up union-find. This is a horizontal projection-profile / whitespace-valley cut.
 *
 * Content-blind: uses ONLY node geometry (x,y,w,h). Purely additive — no edits to lib/.
 */

const BIN = 4; // px vertical resolution of the projection profile

// total covered length of a set of [start,end] intervals (union, not sum)
function unionLen(intervals) {
  if (!intervals.length) return 0;
  intervals.sort((a, b) => a[0] - b[0]);
  let total = 0, cs = intervals[0][0], ce = intervals[0][1];
  for (let i = 1; i < intervals.length; i++) {
    const [s, e] = intervals[i];
    if (s > ce) { total += ce - cs; cs = s; ce = e; }
    else if (e > ce) ce = e;
  }
  return total + (ce - cs);
}

/*
 * nodes: [{x,y,w,h,...}] in CSS px. pageW/pageH: true document size in CSS px.
 * A bin (BIN px of Y) counts as CONTENT when nodes cover >= minCover px of horizontal width there
 * (so a lone thin element — a sticky rail, a divider — can't bridge a section gap). Bands are
 * maximal runs of content bins; an empty run >= minGap px ends a band, a shorter one is absorbed
 * (intra-section line/paragraph spacing).
 */
function bandCut(nodes, pageW, pageH, opts = {}) {
  const minCover = opts.minCover != null ? opts.minCover : Math.max(40, 0.02 * pageW);
  const minGap = opts.minGap != null ? opts.minGap : 32;
  const maxHFrac = opts.maxHFrac != null ? opts.maxHFrac : 0.7; // drop full-height rails/overlays

  const use = nodes.filter((n) => n.w > 0 && n.h > 0 && n.h < maxHFrac * pageH);
  const nBins = Math.max(1, Math.ceil(pageH / BIN));
  const rows = Array.from({ length: nBins }, () => []);
  for (const n of use) {
    const b0 = Math.max(0, Math.floor(n.y / BIN));
    const b1 = Math.min(nBins - 1, Math.floor((n.y + n.h) / BIN));
    for (let b = b0; b <= b1; b++) rows[b].push([n.x, n.x + n.w]);
  }
  const occ = rows.map((iv) => unionLen(iv) >= minCover);

  const minGapBins = Math.max(1, Math.round(minGap / BIN));
  const bands = [];
  let i = 0;
  while (i < nBins) {
    if (!occ[i]) { i++; continue; }
    let start = i, end = i, j = i + 1;
    while (j < nBins) {
      if (occ[j]) { end = j; j++; continue; }
      let k = j;
      while (k < nBins && !occ[k]) k++;      // length of this empty run
      if (k - j >= minGapBins) break;         // section gap -> band ends at `end`
      j = k;                                  // small gap -> absorb, keep scanning
    }
    const y0 = start * BIN, y1 = Math.min(pageH, (end + 1) * BIN);
    const inBand = use.filter((n) => (n.y + n.h) > y0 && n.y < y1);
    const x0 = inBand.length ? Math.min(...inBand.map((n) => n.x)) : 0;
    const x1 = inBand.length ? Math.max(...inBand.map((n) => n.x + n.w)) : pageW;
    bands.push({ y0, y1, x0, x1, nodes: inBand.length });
    i = end + 1;
  }
  return { bands, minCover, minGap, pageW, pageH };
}

module.exports = { bandCut, unionLen };
