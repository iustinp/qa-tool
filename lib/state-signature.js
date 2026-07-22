/**
 * state-signature — a framework-blind identity for a page's current interaction
 * state, used to DEDUP states during the recursive crawl ("have I been here?").
 * Termination hangs on this: without it, cycles (a modal's X returns to base, a
 * toggle flips back) loop forever and the state space explodes.
 *
 * Idea (temporal-variance / background-subtraction, in the text domain): sample
 * the visible-text set a few times over a short window; lines that VARY across
 * samples are dynamic noise (clocks, tickers, rotating banners) and are masked
 * out; the lines STABLE across every sample are the signature. No hardcoded
 * "ignore the clock" rules — the noise mask is discovered per state.
 *
 * Two caveats this module is built around:
 *  - A short real-time sample only masks what changes *in the window*. Slow
 *    JS/CSS dynamics (a 30s rotator, a clock's minutes digit) must be made to
 *    tick inside the window by ACCELERATING timers during sampling — see
 *    sampleStableText's `accelerate` step (page-side, added with the crawl).
 *  - Residual dynamics that can't be accelerated (network polling, a server
 *    clock) leak a few lines into the signature; `sameState` therefore matches
 *    on an OVERLAP RATIO, not exact equality, to absorb them. (This is a dedup
 *    similarity ratio — distinct from change-detection, which stays exact.)
 *
 * Pixel-variance (per-pixel temporal variance over accelerated frames) is the
 * staged upgrade for visual-only changes (theme swap, gallery arrow) that text
 * can't see; not implemented here — text-focused for now.
 *
 * The functions here are PURE (no browser). The page-side sampling+acceleration
 * is wired in when the recursive crawl is built (see issue #54 / memory
 * recursive-state-explorer).
 */

const crypto = require('crypto');

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Reduce N text samples to the stable signature + the discovered volatile mask.
 * A line is stable iff it appears in EVERY sample (present-in-all); anything
 * seen in only some samples is volatile (it appeared/changed/disappeared during
 * the window) and is excluded.
 * @param {Array<Array<string>|Set<string>>} samples  N harvests of visible text
 * @returns {{ stable: string[], volatile: string[] }} normalized, sorted
 */
function stableFromSamples(samples) {
  const list = (samples || []).map((s) => new Set([...s].map(norm).filter((l) => l.length >= 2)));
  const n = list.length;
  if (n === 0) return { stable: [], volatile: [] };
  const count = new Map();
  for (const set of list) for (const line of set) count.set(line, (count.get(line) || 0) + 1);
  const stable = [];
  const volatile = [];
  for (const [line, c] of count) (c === n ? stable : volatile).push(line);
  stable.sort();
  volatile.sort();
  return { stable, volatile };
}

/**
 * A cheap bucket key for a signature — a hash of the sorted stable set. Exact
 * matches share a key (fast pre-filter); near-matches are confirmed with
 * `sameState`. Also carries the line count for a coarse size pre-filter.
 * @param {string[]} stable
 * @returns {{ hash: string, size: number }}
 */
function signatureKey(stable) {
  const sorted = [...stable].sort();
  return {
    hash: crypto.createHash('sha1').update(sorted.join('\n')).digest('hex'),
    size: sorted.length,
  };
}

/**
 * Are two states "the same"? Overlap ratio of their stable sets (Jaccard:
 * |A∩B| / |A∪B|) at or above `minOverlap`. The ratio (not exact equality)
 * absorbs residual dynamics the mask couldn't catch. Two empty sets are the
 * same state (both the pristine base). An empty vs non-empty is different.
 * @param {string[]} a
 * @param {string[]} b
 * @param {{ minOverlap?: number }} [opts]
 * @returns {boolean}
 */
function sameState(a, b, opts = {}) {
  const minOverlap = opts.minOverlap ?? 0.95;
  const A = new Set(a);
  const B = new Set(b);
  if (A.size === 0 && B.size === 0) return true;
  if (A.size === 0 || B.size === 0) return false;
  let inter = 0;
  for (const l of A) if (B.has(l)) inter += 1;
  const union = A.size + B.size - inter;
  return union > 0 && inter / union >= minOverlap;
}

/**
 * Has this state been visited? Cheap pre-filter on the bucket key/size, then
 * confirm with `sameState`. Returns the matching visited entry or null.
 * @param {string[]} stable  the current state's stable set
 * @param {Array<{ key:{hash,size}, stable:string[] }>} visited
 * @param {{ minOverlap?: number, sizeTol?: number }} [opts]
 */
function findVisited(stable, visited, opts = {}) {
  const key = signatureKey(stable);
  const sizeTol = opts.sizeTol ?? 0.15; // skip candidates whose size differs too much
  for (const v of visited || []) {
    if (v.key && v.key.hash === key.hash) return v; // exact
    if (v.key && Math.abs(v.key.size - key.size) > Math.max(3, key.size * sizeTol)) continue;
    if (sameState(stable, v.stable, opts)) return v;
  }
  return null;
}

module.exports = { stableFromSamples, signatureKey, sameState, findVisited, norm };
