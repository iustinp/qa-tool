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

/**
 * Harvest currently-visible text lines (closed-<details> content excluded, so it
 * matches the crawl/CLM). Kept here so the signature is self-contained.
 */
async function harvestVisibleTextInPage(page) {
  // Return a JSON STRING (a primitive), not the array directly. Some anti-bot
  // pages tamper with Symbol.hasInstance, which breaks Playwright's serialization
  // of any STRUCTURED return (objects AND arrays throw "Right-hand side of
  // 'instanceof' is not an object"); a primitive string transports cleanly. Parse
  // it back on the Node side. See memory: crawl-hard-cases.
  const json = await page.evaluate(() => {
    const vis = (el) => {
      const er = el.getBoundingClientRect();
      if (er.width < 1 && er.height < 1) return false; // collapsed to nothing
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
        if (p.tagName === 'DETAILS' && !p.hasAttribute('open')) {
          const su = p.querySelector(':scope > summary');
          if (!su || !su.contains(el)) return false;
        }
        // Clipped OUT of an overflow-hidden/clip ancestor: a max-height:0 accordion,
        // or a hotspot/carousel panel translated off the clip box. Such text is in
        // the DOM but NOT visible to the user — yet display/visibility/opacity all
        // read "shown", so only this rect-vs-clip test catches it. Without it the
        // hidden content is baked into the base signature and clicking to reveal it
        // looks like "no change" (a false noop).
        if (p !== el) {
          const ov = `${s.overflowX} ${s.overflowY}`;
          if (ov.includes('hidden') || ov.includes('clip')) {
            const pr = p.getBoundingClientRect();
            // No meaningful overlap with the clip box → clipped out (matches the
            // canonical-layout extractor's test, so pear and crawl agree).
            const ix = Math.min(er.right, pr.right) - Math.max(er.left, pr.left);
            const iy = Math.min(er.bottom, pr.bottom) - Math.max(er.top, pr.top);
            if (ix <= 1 || iy <= 1) return false;
          }
        }
      }
      return true;
    };
    const out = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const t = (n.nodeValue || '').replace(/\s+/g, ' ').trim();
      if (t.length < 2) continue;
      const el = n.parentElement;
      if (!el || el.closest('script,style,template,noscript')) continue;
      if (!vis(el)) continue;
      out.push({ t });
    }
    return JSON.stringify(out);
  });
  return json ? JSON.parse(json) : [];
}

/**
 * addInitScript payload string that accelerates JS/CSS timers by `factor`, so
 * slow dynamics (a 30s rotator, a clock's minutes digit) tick INSIDE the short
 * sample window and thus get masked. MUST be installed via page.addInitScript
 * BEFORE navigation for full effect — it patches every setInterval/setTimeout
 * from the start (patching after load only catches timers scheduled later).
 * Cannot speed network polling or a server clock (handled by sameState's
 * overlap tolerance).
 */
function timerAccelerationInit(factor = 40) {
  return `(${(function (f) {
    if (window.__ppdAccel) return;
    window.__ppdAccel = 1;
    const si = window.setInterval.bind(window);
    const st = window.setTimeout.bind(window);
    window.setInterval = function (fn, d) { return si(fn, Math.max(1, (+d || 0) / f), ...[].slice.call(arguments, 2)); };
    window.setTimeout = function (fn, d) { return st(fn, Math.max(1, (+d || 0) / f), ...[].slice.call(arguments, 2)); };
    const inject = () => {
      const s = document.createElement('style');
      s.setAttribute('data-ppd-accel', '1');
      s.textContent = '*,*::before,*::after{animation-duration:.01s !important;animation-delay:0s !important;transition-duration:.01s !important}';
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.head) inject();
    else document.addEventListener('DOMContentLoaded', inject, { once: true });
  }).toString()})(${factor});`;
}

/**
 * Sample the visible text `samples` times (spaced `intervalMs`) and reduce to
 * the stable signature + volatile mask. Assumes timer acceleration was installed
 * at page init (via timerAccelerationInit) so the window sees slow dynamics.
 */
async function sampleStableText(page, opts = {}) {
  const samples = opts.samples ?? 8;
  const intervalMs = opts.intervalMs ?? 200;
  const arr = []; // each sample: [{ t }]
  for (let i = 0; i < samples; i++) {
    arr.push(await harvestVisibleTextInPage(page));
    if (i < samples - 1) await page.waitForTimeout(intervalMs);
  }
  // Stable TEXT set (present-in-all) — the primary, reflow-robust signal.
  const { stable, volatile } = stableFromSamples(arr.map((s) => s.map((o) => o.t)));
  return { stable, volatile };
}

/**
 * Did a click change the page relative to a reference state? "Changed" means the
 * current stable set is NOT the same state as the reference (reusing the same
 * overlap tolerance as dedup, so a lone residual line isn't a false edge). Also
 * returns the added/removed lines — `added` is the reveal that becomes the new
 * state's content. The recursive loop uses this as the "does an edge exist" gate
 * before checking dedup (findVisited).
 * @param {string[]} refStable  reference (usually the parent/base) stable set
 * @param {string[]} curStable  current stable set (after the click)
 */
function changedFrom(refStable, curStable, opts = {}) {
  const R = new Set(refStable);
  const C = new Set(curStable);
  const added = curStable.filter((l) => !R.has(l));
  const removed = refStable.filter((l) => !C.has(l));
  return { changed: !sameState(refStable, curStable, opts), added, removed };
}

module.exports = {
  stableFromSamples,
  signatureKey,
  sameState,
  findVisited,
  changedFrom,
  norm,
  harvestVisibleTextInPage,
  timerAccelerationInit,
  sampleStableText,
};
