/**
 * recursive-explorer — a bounded, recursive interaction-state crawl (issue #54).
 *
 * Where the one-hop crawl (lib/state-crawler.js) clicks each base trigger once
 * and reverts, this explores the page as a STATE GRAPH: click a trigger, decide
 * if it reached a genuinely new state, and if so recurse INTO that state and
 * explore its triggers too (a modal that opens another modal, a tab that reveals
 * an accordion). Depth-first with backtracking; framework-blind.
 *
 * Two hard problems and how they're solved:
 *
 *  1. "Have I been here already?" (dedup / termination). Without it, cycles
 *     (a modal's X returns to base; a toggle flips back) loop forever. The
 *     identity of a state is its STABLE-TEXT SIGNATURE — the visible-text lines
 *     that survive a few quick samples taken with JS/CSS timers accelerated, so
 *     dynamic noise (clocks, tickers, rotating banners) is discovered and masked
 *     rather than baked in. See lib/state-signature.js. Two states are "the same"
 *     when their stable sets overlap past a threshold (findVisited / sameState).
 *
 *  2. Backtracking. To explore a sibling after descending, we must return to the
 *     parent state exactly. We reuse the in-place MutationObserver undo — but
 *     STACKED: each descent pushes a fresh observer and pauses its parent; each
 *     ascent reverses only that level's mutations and resumes the parent. Because
 *     only the top observer is ever live, a level never records its children's
 *     mutations or their undo, so the reversals compose cleanly across depth.
 *     Reversing recorded mutations (not innerHTML) keeps every node object and
 *     its listeners intact, so re-clicking works. A click that navigates away or
 *     leaves residue after undo marks the run DIRTY: we reload to base and
 *     continue the top-level sweep from the next trigger (bounded loss of that
 *     branch's deeper siblings — never a crash or an infinite loop).
 *
 * Bounds are load-bearing (state explosion is the real killer): max depth, max
 * states, per-node click budget, wall-clock budget. QA needs parity of the
 * explored state sets on both sides, not omniscience.
 */

const {
  captureFullPageBuffer,
  stabilizePageForCapture,
  dismissModals,
  hideLowerPinnedOverlays,
  DEFAULT_MODAL_SELECTORS,
} = require('./capture');
const { extractCanonicalLayout } = require('./canonical-layout');
const { installNavBlocker, tagTriggers, norm, TRIGGER_SEL, ITEM_SEL } = require('./state-crawler');
const {
  signatureKey,
  findVisited,
  changedFrom,
  harvestVisibleTextInPage,
  harvestVisibleViewport,
  timerAccelerationInit,
  sampleStableText,
} = require('./state-signature');
const os = require('os');
const fs = require('fs');
const pathMod = require('path');
const sharp = require('sharp');
const pixelDiff = require('./pixel-diff');
const { extractTextItemsOcr } = require('./text-geometry-ocr');

const nnorm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Pixel second-opinion for a click the text-set signal called flat: did the
 * USER-VISIBLE page change, and what appeared? Ground truth from pixels — catches
 * occlusion / visual-only reveals the DOM harvest is blind to (#62). Returns the
 * OCR'd NEW lines (novelty-filtered vs the same regions before the click).
 * @returns {Promise<{changed:boolean, revealed:string[]}>}
 */
async function pixelReveal(page, beforeBuf, beforeRaw, volatile, scrollY, opts = {}) {
  const floor = opts.pixelFloor ?? 6;
  const maxRegions = opts.maxOcrRegions ?? 4;
  const scale = beforeRaw.scale || 1; // detection frames are downscaled; OCR is full-res
  const inv = scale > 0 ? 1 / scale : 1;
  let afterBuf;
  let afterRaw;
  try {
    // VIEWPORT after-frame at the SAME scroll as the before-frame (both scrolled to
    // the trigger). A viewport shot is ~10x cheaper than the full ~10k-px page — the
    // bottleneck P4 identified — and shows exactly where a below-fold reveal lands.
    afterBuf = await page.screenshot({ type: 'png' });
    afterRaw = await pixelDiff.frame(afterBuf, { scale });
  } catch {
    return { changed: false, revealed: [] };
  }
  // The volatile mask is a full-page, scroll-0 block map; window it to this click's
  // viewport frame (same width => same columns; rows offset by the capture scroll).
  const block = 8;
  const diffCols = Math.ceil(Math.min(beforeRaw.w, afterRaw.w) / block);
  const diffRows = Math.ceil(Math.min(beforeRaw.h, afterRaw.h) / block);
  const rowOffset = Math.round(((scrollY || 0) * scale) / block);
  const vol =
    volatile && volatile.map && volatile.cols === diffCols
      ? pixelDiff.windowMask(volatile.map, diffCols, rowOffset, diffRows)
      : null;
  const det = pixelDiff.detect(beforeRaw, afterRaw, vol, { minBlocks: opts.pixelMinBlocks ?? 4 });
  if (det.changedBlocks < floor) return { changed: false, revealed: [] };
  // Full-res dims to clamp the OCR crop (regions are in DOWNSCALED px → ×inv).
  let fullW = 0;
  let fullH = 0;
  try {
    const m = await sharp(afterBuf).metadata();
    fullW = m.width || 0;
    fullH = m.height || 0;
  } catch {
    /* ignore */
  }
  // OCR the changed area on BOTH frames (before-OCR is load-bearing: the occlusion
  // case has display:block-but-covered text that the DOM harvest already "sees", so
  // only the BEFORE IMAGE proves it wasn't visible). To cut cost, OCR the single
  // UNION bounding box of the top regions ONCE per frame — tesseract's per-call
  // process spawn is the real overhead, so 2 spawns/click beats 2×N. The novelty
  // filter (after-lines not in before) drops any static content swept into the box.
  const tmp = () => pathMod.join(os.tmpdir(), `ppdpx_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const regs = det.regions.slice(0, maxRegions);
  if (!regs.length) return { changed: true, revealed: [] };
  let minL = Infinity, minT = Infinity, maxR = 0, maxB = 0;
  for (const r of regs) {
    minL = Math.min(minL, r.left * inv);
    minT = Math.min(minT, r.top * inv);
    maxR = Math.max(maxR, (r.left + r.width) * inv);
    maxB = Math.max(maxB, (r.top + r.height) * inv);
  }
  const left = Math.max(0, Math.round(minL) - 2);
  const top = Math.max(0, Math.round(minT) - 2);
  const clip = {
    left,
    top,
    width: Math.min(Math.round(maxR - minL) + 4, (fullW || left + 1) - left),
    height: Math.min(Math.round(maxB - minT) + 4, (fullH || top + 1) - top),
  };
  if (clip.width < 3 || clip.height < 3) return { changed: true, revealed: [] };
  const af = tmp();
  const bf = tmp();
  let aItems = [];
  let bItems = [];
  try {
    await sharp(afterBuf).extract(clip).toFile(af);
    aItems = await extractTextItemsOcr(af, {});
  } catch {
    /* ignore */
  }
  try {
    await sharp(beforeBuf).extract(clip).toFile(bf);
    bItems = await extractTextItemsOcr(bf, {});
  } catch {
    /* ignore */
  }
  try { fs.unlinkSync(af); } catch { /* ignore */ }
  try { fs.unlinkSync(bf); } catch { /* ignore */ }
  const bset = bItems.map((it) => nnorm(it.text)).filter((x) => x.length > 2);
  const seen = new Set();
  const revealed = [];
  for (const it of aItems) {
    const n = nnorm(it.text);
    if (n.length > 2 && !seen.has(n) && !bset.some((b2) => b2.includes(n) || n.includes(b2))) {
      seen.add(n);
      revealed.push(it.text.trim());
    }
  }
  return { changed: true, revealed };
}

/**
 * Install the STACKED mutation record/undo helpers. Unlike the single-level
 * version in state-crawler, this keeps a stack: __ppdMutStart pushes a fresh
 * observer and pauses the current top (preserving its pending records);
 * __ppdMutUndo pops the top, reverses its mutations, and resumes the parent
 * observer AFTER the reversal (so the parent never records the undo). Only the
 * top observer is live at any moment, which is what makes nested backtracking
 * compose. __ppdStackReset tears the whole stack down (used on a dirty reload).
 */
function installMutationUndoStack(page) {
  return page.evaluate(() => {
    if (window.__ppdStackInit) {
      window.__ppdStackReset();
      return;
    }
    window.__ppdStackInit = 1;
    const OPTS = {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      characterData: true,
      characterDataOldValue: true,
    };
    window.__ppdStack = [];
    window.__ppdMutStart = () => {
      const top = window.__ppdStack[window.__ppdStack.length - 1];
      if (top && top.ob) {
        top.rec.push(...top.ob.takeRecords()); // flush pending before pausing
        top.ob.disconnect();
        top.ob = null;
      }
      const rec = [];
      const ob = new MutationObserver((ms) => rec.push(...ms));
      ob.observe(document.documentElement, OPTS);
      window.__ppdStack.push({ rec, ob });
    };
    window.__ppdMutUndo = () => {
      const level = window.__ppdStack.pop();
      if (!level) return 0;
      if (level.ob) {
        level.rec.push(...level.ob.takeRecords());
        level.ob.disconnect();
      }
      const all = level.rec;
      for (let i = all.length - 1; i >= 0; i--) {
        const m = all[i];
        try {
          if (m.type === 'childList') {
            for (const nd of m.addedNodes) {
              if (nd.parentNode) nd.parentNode.removeChild(nd);
            }
            const rm = Array.from(m.removedNodes);
            for (let j = rm.length - 1; j >= 0; j--) {
              const nd = rm[j];
              if (m.nextSibling && m.nextSibling.parentNode === m.target) m.target.insertBefore(nd, m.nextSibling);
              else if (m.target) m.target.appendChild(nd);
            }
          } else if (m.type === 'attributes') {
            if (m.oldValue === null) m.target.removeAttribute(m.attributeName);
            else m.target.setAttribute(m.attributeName, m.oldValue);
          } else if (m.type === 'characterData') {
            m.target.data = m.oldValue;
          }
        } catch {
          /* best-effort per-mutation */
        }
      }
      // Resume the parent observer AFTER the reversal so it doesn't record it.
      const parent = window.__ppdStack[window.__ppdStack.length - 1];
      if (parent && !parent.ob) {
        const ob = new MutationObserver((ms) => parent.rec.push(...ms));
        ob.observe(document.documentElement, OPTS);
        parent.ob = ob;
      }
      return all.length;
    };
    window.__ppdStackDepth = () => window.__ppdStack.length;
    window.__ppdStackReset = () => {
      for (const l of window.__ppdStack) {
        try {
          if (l.ob) l.ob.disconnect();
        } catch {
          /* ignore */
        }
      }
      window.__ppdStack = [];
    };
  });
}

/**
 * A stable identity per currently-tagged trigger, in document order — parallel to
 * page.$$('[data-ppd-idx]'). Identity is the ELEMENT itself, stamped with a JS
 * expando id (window-scoped counter) the first time it's seen. An expando is NOT
 * a DOM mutation, so the MutationObserver undo doesn't record/erase it, and it's
 * immune to layout reflow and label collisions — unlike a position/label key.
 * Used to tell whether a trigger in a child state was genuinely revealed by the
 * click or merely inherited (the same still-visible element) from an ancestor.
 */
async function triggerKeys(page) {
  // JSON-string transport (see harvestVisibleTextInPage) — a structured return
  // (array) throws on anti-bot pages that tamper with Symbol.hasInstance.
  const json = await page.$$eval('[data-ppd-idx]', (els) =>
    JSON.stringify(
      els.map((el) => {
        if (el.__ppdTid == null) {
          window.__ppdNextTid = (window.__ppdNextTid || 0) + 1;
          el.__ppdTid = window.__ppdNextTid;
        }
        return el.__ppdTid;
      })
    )
  );
  return json ? JSON.parse(json) : [];
}

/** Read a trigger's label + document-space geometry (for the review overlay). */
async function triggerInfo(handle) {
  try {
    // JSON-string transport (see harvestVisibleTextInPage): the object return
    // throws on anti-bot pages tampering with Symbol.hasInstance.
    const json = await handle.evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || r.width < 6 || r.height < 6) return null;
      return JSON.stringify({
        label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60),
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      });
    });
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/**
 * Locate the REVEALED content on the page and report its document-space bounding
 * box + whether it's an overlay. Used to size the state backdrop screenshot to the
 * actual reveal (#62): an in-flow reveal (accordion answer, "Load more" list, tab
 * panel) can grow well past one viewport, so a fixed viewport shot cuts it off. We
 * find the DOM text matching `revealedNorms`, union its rects (in doc space), and
 * flag `fixed` when any match sits under a position:fixed/sticky ancestor — a modal
 * / sticky overlay that must stay VIEWPORT-anchored (a full-page shot mis-places
 * it). Returns null when nothing is locatable (caller falls back to viewport).
 */
async function measureRevealBox(page, revealedNorms, triggerY) {
  try {
    const json = await page.evaluate(({ norms, tY }) => {
      if (!document.body) return JSON.stringify(null);
      const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
      // Ignore very short lines — generic tokens ("Read More", "1 / 4") recur all
      // over the page and would balloon the union bbox with far-away duplicates.
      const want = new Set(norms.map(norm).filter((x) => x.length >= 6));
      if (!want.size) return JSON.stringify(null);
      const sx = window.scrollX || 0;
      const sy = window.scrollY || 0;
      let top = Infinity;
      let bottom = -Infinity;
      let left = Infinity;
      let right = -Infinity;
      let count = 0;
      let fixed = false;
      const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n; n = w.nextNode()) {
        const t = norm(n.nodeValue || '');
        if (t.length < 6 || !want.has(t)) continue;
        const el = n.parentElement;
        if (!el || el.closest('script,style,template,noscript')) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        let r;
        try {
          const rg = document.createRange();
          rg.selectNodeContents(n);
          r = rg.getBoundingClientRect();
        } catch {
          continue;
        }
        if (r.width < 1 && r.height < 1) continue;
        const docTop = r.top + sy;
        // A reveal appears AT/BELOW the clicked trigger. The same text often recurs
        // near the page top (nav, structured-data, EDS duplicates) — those far-above
        // copies would drag the union bbox up and mis-frame the clip. Only count
        // matches within a band around the trigger.
        if (tY != null && docTop < tY - 800) continue;
        count += 1;
        top = Math.min(top, docTop);
        bottom = Math.max(bottom, r.bottom + sy);
        left = Math.min(left, r.left + sx);
        right = Math.max(right, r.right + sx);
        if (!fixed) {
          for (let p = el; p; p = p.parentElement) {
            const ps = getComputedStyle(p).position;
            if (ps === 'fixed' || ps === 'sticky') { fixed = true; break; }
          }
        }
      }
      if (!count) return JSON.stringify(null);
      return JSON.stringify({
        top: Math.round(top),
        bottom: Math.round(bottom),
        left: Math.round(left),
        right: Math.round(right),
        count,
        fixed,
        pageH: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
        pageW: document.documentElement.clientWidth || window.innerWidth || 0,
      });
    }, { norms: revealedNorms, tY: triggerY == null ? null : triggerY });
    return json ? JSON.parse(json) : null;
  } catch {
    return null;
  }
}

/**
 * The recursive explorer, driven over a live, stabilized, timer-accelerated page.
 * Returns the discovered state graph plus counters.
 */
async function exploreStates(page, opts = {}) {
  const maxDepth = opts.maxDepth ?? 3;
  const maxStates = opts.maxStates ?? 60;
  const perNodeBudget = opts.perNodeBudget ?? 40;
  const timeBudgetMs = opts.timeBudgetMs ?? 180000;
  const settleMs = opts.settleMs ?? 350;
  const captureStates = !!opts.captureStates;
  const sampleOpts = opts.sample || { samples: 6, intervalMs: 120 };
  const matchOpts = opts.match || { minOverlap: 0.9 };
  const capOpts = opts.captureOptions || {};
  const pixelDetect = !!opts.pixelDetect; // pixel second-opinion on text-flat clicks (#62)
  const pixelScale = opts.pixelScale ?? 0.25; // detection frames downscaled (OCR stays full-res)
  // Occlusion-aware DOM second-opinion (#62): on a text-flat click, re-harvest the
  // viewport counting only text that's TOPMOST at its own location (elementFromPoint
  // hit-test) — catches occlusion reveals (display:block-but-covered text uncovered)
  // via cheap DOM calls (~5ms) instead of the screenshot+OCR pixel path (~600ms).
  // Default ON; pixel stays as an explicit fallback (pointer-events:none overlays /
  // pure non-text visual reveals).
  const occlusionDetect = opts.occlusionDetect !== false;
  // Click/tag debug: set PPD_CLICK_DEBUG=1 (or opts.clickDebug) to trace, per
  // trigger, what got tagged/skipped-and-why and what each click produced
  // (nav / noop-gate / noop-sig / known / new). Goes to stderr with a [clickdbg]
  // prefix — grep the run's .log. Off by default; zero overhead when off.
  const CLICK_DEBUG = opts.clickDebug || process.env.PPD_CLICK_DEBUG === '1';
  const clog = (...a) => {
    if (!CLICK_DEBUG) return;
    const line = a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    console.error('[clickdbg]', line); // direct runs (stderr)
    if (typeof opts.clickLog === 'function') { try { opts.clickLog(line); } catch { /* ignore */ } } // → run-debug.log
  };
  // Per-phase timing (always accumulated — Date.now diffs are ~free — emitted once
  // at the end so we can see where the crawl's wall-clock actually goes). Reported
  // to stderr + run-debug.log (via clickLog) + the return value (.timing).
  const T = {};
  const timed = async (phase, fn) => {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      const e = T[phase] || (T[phase] = { ms: 0, n: 0 });
      e.ms += Date.now() - t0;
      e.n += 1;
    }
  };
  let volatile = null; // block map of self-changing pixels (clocks/carousels)
  const baseUrl = page.url();
  // A hash-only URL change (same path+search; only the #fragment differs) is
  // IN-PAGE, never a navigation — an href="#" click or an SPA hash route must not
  // be treated as "left the page" (that caused pointless reloads and, via a false
  // nav, coverage loss). Compare the URL with the fragment stripped.
  const stripHash = (u) => {
    try { const x = new URL(u); x.hash = ''; return x.href; } catch { return String(u || '').split('#')[0]; }
  };
  const baseNoHash = stripHash(baseUrl);
  const navigatedAway = () => stripHash(page.url()) !== baseNoHash;
  const deadline = Date.now() + timeBudgetMs;

  await installNavBlocker(page);
  await installMutationUndoStack(page);

  // HARD navigation sandbox (#62): installNavBlocker only stops anchor-default +
  // form navigation, NOT programmatic JS navigation (window.location=, SPA router,
  // window.open). A tagged nav item (e.g. "Pay") that navigates by JS destroys the
  // execution context and HALTS the whole crawl. Abort any MAIN-FRAME document
  // navigation to a different URL so such a click fails harmlessly — its in-page
  // effects (menus/reveals) still run, the page stays put, and the sweep continues.
  // Our own reloadToBase (goto baseUrl) is to baseNoHash, so it's allowed; hash
  // changes and sub-resources don't make blocked navigation requests.
  let navSandboxed = false;
  try {
    await page.route('**/*', (route) => {
      const req = route.request();
      try {
        if (req.isNavigationRequest() && req.frame() === page.mainFrame() && stripHash(req.url()) !== baseNoHash) {
          return route.abort('aborted');
        }
      } catch {
        /* fall through to continue */
      }
      return route.continue();
    });
    navSandboxed = true;
  } catch {
    /* routing unavailable → rely on nav-blocker + the navigatedAway reload path */
  }

  // #62 — The crawl runs at the NATIVE (base-capture) viewport. A tall viewport
  // was tried to fit more of a reveal into one backdrop shot, but growing viewport
  // HEIGHT also grows every vh-sized section (heroes / full-screen bands), which
  // shifts the whole crawl layout down relative to the pre-crawl base pear (a
  // trigger below the first 100vh section drifted by exactly the extra height,
  // ~1512px) — breaking box placement and outrunning the coordinate-snapping's
  // local-drift assumptions. Keeping the native viewport means the crawl layout
  // matches the base pear, so trigger geometry stays aligned. The modal-at-75%
  // bug is fixed by the viewport-at-clickable capture below (scroll + viewport
  // shot), which needs no resize.

  const visited = []; // [{ key, stable }] — dedup memory, shared across the whole graph
  const states = []; // captured NEW states (pear/shot/revealed), for review + compare
  const edges = []; // { fromSig, toSig, triggerLabel, kind: 'new'|'known'|'noop'|'nav' }
  let clicks = 0;
  let navigations = 0;
  let reloads = 0;
  let baseTriggers = 0;
  let dirty = false;
  // Diagnostics (issue #58): distinguish WHY a click produced no new state.
  let noopGate = 0; // quick harvest showed no lines beyond the parent stable set
  let noopSig = 0; // quick harvest DID show added lines, but the stable-set compare called it unchanged (masked/absorbed)
  // A state's identity is its DELTA FROM BASE (lines unique to it) — set once the
  // base is sampled below. Dedup diffs these deltas, not the base-dominated full sets.
  let baseSet = new Set();
  const deltaFromBase = (stable) => stable.filter((l) => !baseSet.has(l));

  const timeUp = () => Date.now() >= deadline;

  // Reload to a clean base after a navigation / irreversible residue, re-arming
  // the instruments. Position in the graph is lost — the top-level sweep resumes
  // from its next trigger (see explore()'s depth-0 handling).
  const reloadToBase = async () => {
    reloads += 1;
    dirty = true;
    try {
      await page.goto(baseUrl, { waitUntil: capOpts.gotoWaitUntil || 'domcontentloaded' });
      try {
        await page.evaluate(async () => {
          const step = Math.max(600, Math.floor(window.innerHeight * 0.9));
          for (let y = 0; y < document.body.scrollHeight; y += step) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 25));
          }
          window.scrollTo(0, 0);
        });
      } catch {
        /* ignore */
      }
      try {
        await stabilizePageForCapture(page, {
          freezeAnimations: capOpts.freezeAnimations,
          removeModalSelectors: capOpts.removeModalSelectors,
          ocrContrast: capOpts.ocrContrast,
        });
      } catch {
        /* ignore */
      }
      try {
        await page.keyboard.press('Escape');
        await dismissModals(page, capOpts.removeModalSelectors || DEFAULT_MODAL_SELECTORS);
      } catch {
        /* ignore */
      }
      try {
        await hideLowerPinnedOverlays(page);
      } catch {
        /* ignore */
      }
      await page.waitForTimeout(capOpts.stabilizeSettleMs ?? 300);
      await installNavBlocker(page);
      await installMutationUndoStack(page);
    } catch {
      /* best-effort reset */
    }
  };

  const captureState = async (info, addedLines, sig, parentSig, depth) => {
    // Per-state pear (extractCanonicalLayout) was measured to dominate the crawl
    // on the heavy anti-bot source — ~7.9s/state × 68 = ~535s = 64% of the source
    // crawl (#62 timing). It's PURE WASTE: the per-state canonical layout is never
    // rendered (state views use the `shot` screenshot as backdrop) and its only
    // consumer, buildGraph's w/h, already prefers `viewportWidth`/`viewportHeight`
    // recorded below. So it's removed. `opts.captureStateClm` re-enables it if a
    // future per-state pear feature needs it.
    let clm = null;
    let shot = null;
    let captureScrollY = 0;
    let vpW = 0;
    let vpH = 0;
    if (captureStates) {
      // #62 — ADAPTIVE, REVEAL-SCOPED backdrop. Size the shot to the reveal, not a
      // fixed frame, so a tall IN-FLOW reveal (accordion answer, "Load more" list,
      // tab panel) isn't cut off at the viewport, while a FIXED/sticky overlay
      // (modal) stays viewport-anchored (a full-page shot mis-places it). Scroll is
      // restored to 0 afterwards so the recursion/siblings run from the same place
      // clicks do (avoids scroll-triggered lazy content mutation-undo can't reverse).
      const HEADER_PAD = 120; // clear a sticky header when top-aligning a reveal
      const MAX_CLIP_H = 6000; // cap the tall-clip raster (cost + sane review height)
      const withClm = async () => {
        if (opts.captureStateClm) {
          try { clm = await extractCanonicalLayout(page); } catch { /* pear best-effort */ }
        }
      };
      const box = await measureRevealBox(page, (addedLines || []).map(norm), info.y);
      let done = false;
      if (box && !box.fixed) {
        // In-flow reveal: frame the union of [trigger .. reveal] in DOCUMENT space.
        const vinfo = await page.evaluate(() => ({ vw: window.innerWidth || 0, vh: window.innerHeight || 0 }));
        const vh = vinfo.vh || 0;
        const regionTop = Math.max(0, Math.min(info.y || 0, box.top) - 24);
        const regionBottom = Math.min(box.pageH, box.bottom + 24);
        const regionH = Math.max(0, regionBottom - regionTop);
        if (vh > 0 && regionH > vh) {
          // Taller than one viewport → full-page shot CLIPPED to the reveal region.
          // captureScrollY = regionTop so the review maps doc-space child boxes in.
          const height = Math.min(regionH, MAX_CLIP_H);
          const width = box.pageW || vinfo.vw || 0;
          await withClm();
          // Playwright's fullPage shot paints position:fixed elements at the BOTTOM
          // of the expanded canvas (a known quirk) — a fixed header / chat / cookie
          // bar would land in the middle of our mid-page clip. Hide fixed elements
          // just for the shot (visibility:hidden — no reflow), then restore. This is
          // the very failure mode that first pushed capture to viewport; neutralising
          // it lets the in-flow clip stay clean.
          let hidFixed = 0;
          try {
            hidFixed = await page.evaluate(() => {
              const touched = [];
              for (const el of document.querySelectorAll('body *')) {
                if (getComputedStyle(el).position === 'fixed') {
                  touched.push([el, el.style.getPropertyValue('visibility'), el.style.getPropertyPriority('visibility')]);
                  el.style.setProperty('visibility', 'hidden', 'important');
                }
              }
              window.__ppdHidFixed = touched;
              return touched.length;
            });
          } catch {
            /* best-effort */
          }
          try {
            shot = await page.screenshot({ type: 'png', fullPage: true, clip: { x: 0, y: regionTop, width, height } });
            captureScrollY = regionTop;
            vpW = width;
            vpH = height;
            done = true;
          } catch {
            /* fall through to viewport path */
          }
          if (hidFixed) {
            try {
              await page.evaluate(() => {
                for (const [el, v, prio] of window.__ppdHidFixed || []) {
                  if (v) el.style.setProperty('visibility', v, prio);
                  else el.style.removeProperty('visibility');
                }
                window.__ppdHidFixed = null;
              });
            } catch {
              /* best-effort restore */
            }
          }
        } else if (vh > 0) {
          // Fits one viewport → scroll the reveal's top just below a sticky header
          // and shoot the VIEWPORT, guaranteeing the whole reveal is framed.
          try {
            const scr = await page.evaluate((yTop) => {
              window.scrollTo(0, yTop);
              return { scrollY: window.scrollY || 0, vw: window.innerWidth || 0, vh: window.innerHeight || 0 };
            }, Math.max(0, regionTop - HEADER_PAD));
            captureScrollY = scr.scrollY;
            vpW = scr.vw;
            vpH = scr.vh;
            await page.waitForTimeout(80); // let sticky/scroll-linked paint settle
            await withClm();
            shot = await page.screenshot({ type: 'png' });
            done = true;
          } catch {
            /* fall through */
          }
        }
      }
      if (!done) {
        // FIXED/sticky overlay, or the reveal wasn't locatable → viewport-at-
        // clickable: centre the trigger, shoot the VIEWPORT. A full-page shot would
        // render a fixed/centred modal ~75% down a ~10k-px canvas, detached.
        try {
          const scr = await page.evaluate((y) => {
            const vh = window.innerHeight || 0;
            window.scrollTo(0, Math.max(0, Math.round((y || 0) - vh / 2)));
            return { scrollY: window.scrollY || 0, vw: window.innerWidth || 0, vh };
          }, info.y);
          captureScrollY = scr.scrollY;
          vpW = scr.vw;
          vpH = scr.vh;
          await page.waitForTimeout(80);
        } catch {
          /* scroll is best-effort */
        }
        await withClm();
        try {
          shot = await page.screenshot({ type: 'png' });
        } catch {
          /* screenshot is best-effort */
        }
      }
      try {
        await page.evaluate(() => window.scrollTo(0, 0));
      } catch {
        /* restore is best-effort */
      }
    }
    states.push({
      signature: sig.hash,
      parentSignature: parentSig ? parentSig.hash : null, // discovery-tree parent
      depth,
      // Geometry of the trigger (in the PARENT state's document space) that
      // revealed this state — the review draws the clickable box on the parent.
      triggerLabel: info.label,
      triggerX: info.x,
      triggerY: info.y,
      triggerW: info.w,
      triggerH: info.h,
      revealedCount: addedLines.length,
      revealed: addedLines.slice(0, 200),
      clm,
      shot,
      // Viewport-at-clickable frame: the backdrop `shot` shows the document region
      // [captureScrollY, captureScrollY + viewportHeight]. Child boxes are in doc
      // space → the review offsets them by -captureScrollY.
      captureScrollY,
      viewportWidth: vpW,
      viewportHeight: vpH,
    });
  };

  /**
   * Explore the CURRENT state's triggers. `curStable` is the (already sampled)
   * stable signature of the state the page is in right now. Returns nothing; sets
   * the shared `dirty` flag when it had to reload. At depth 0 a dirty branch is
   * recovered (reload + continue the sweep); deeper levels just unwind.
   */
  const explore = async (curStable, curSig, depth, parentKeys = new Set()) => {
    if (depth >= maxDepth || states.length >= maxStates || timeUp()) return;

    // (Re)tag triggers for THIS state and snapshot element handles up front.
    // Handles stay valid across our own re-tagging and across a child's undo
    // (mutation-undo preserves the node objects), so we don't depend on the
    // data-ppd-idx attribute surviving a deeper re-tag.
    await timed('tag', () => tagTriggers(page, TRIGGER_SEL, ITEM_SEL, CLICK_DEBUG));
    if (CLICK_DEBUG) {
      try {
        const dbg = JSON.parse(await page.evaluate(() => JSON.stringify(window.__ppdTagDbg || [])));
        const tagged = dbg.filter((d) => d.tagged != null);
        // Skip reasons as a TALLY, not one line each — the skipped set is the bulk
        // (cross-page anchors + invisible) and dumping it makes the log unusable
        // (65k+ lines). Summary + the TAGGED list (what we actually click) is what
        // matters. Full per-candidate dump only with PPD_CLICK_DEBUG_SKIPS=1; the
        // tagged list repeats every re-tag, so only print it at depth 0 unless
        // PPD_CLICK_DEBUG_TAGS=1.
        const skips = {};
        for (const d of dbg) if (d.skip) { const k = String(d.skip).split(/[( <]/)[0]; skips[k] = (skips[k] || 0) + 1; }
        clog(`d${depth} tagTriggers: ${tagged.length} tagged / ${dbg.length} candidates; skips=${JSON.stringify(skips)}`);
        if (depth === 0 || process.env.PPD_CLICK_DEBUG_TAGS === '1') {
          for (const d of tagged) clog(`  TAG#${d.tagged} <${d.tag}${d.ppd ? ' ppd' : ''}> "${d.label}" ${d.href ? 'href=' + d.href : ''}`);
        }
        if (process.env.PPD_CLICK_DEBUG_SKIPS === '1') {
          for (const d of dbg) if (d.skip) clog(`  skip: ${d.skip}  <${d.tag}> "${d.label}"`);
        }
      } catch (e) {
        clog('tag-debug read failed', e && e.message);
      }
    }
    let handles = await page.$$('[data-ppd-idx]');
    // A stable key (coarse position + label) per tagged trigger, parallel to
    // handles. Used to explore only GENUINELY-REVEALED triggers in a child: a
    // trigger already present in an ancestor state (a sibling accordion/tab/card
    // that merely stayed visible) is NOT this state's child — skipping it keeps
    // siblings as siblings instead of chaining them into a deep tree (#59).
    let keys = await triggerKeys(page);
    if (depth === 0) baseTriggers = handles.length;
    // Keys visible to any deeper level = everything inherited plus this level's.
    const childParentKeys = new Set(parentKeys);
    for (const k of keys) childParentKeys.add(k);
    const limit = Math.min(handles.length, perNodeBudget);

    for (let i = 0; i < limit; i++) {
      if (states.length >= maxStates || timeUp()) return;
      const handle = handles[i];
      if (!handle) continue;
      // Inherited trigger (was already clickable in an ancestor) → not a reveal
      // of THIS state; leave it to the level that first saw it.
      if (parentKeys.has(keys[i])) continue;
      const info = await triggerInfo(handle);
      if (!info) continue;
      // Trigger geometry travels on the edge so the review can draw the clickable
      // box in the FROM state's view (the state the click was made in).
      const geom = { triggerLabel: info.label, triggerX: info.x, triggerY: info.y, triggerW: info.w, triggerH: info.h };
      const pushEdge = (toSig, kind) => edges.push({ fromSig: curSig.hash, toSig, kind, ...geom });

      // Per-click debug: what element are we about to click, and (below) what did it
      // produce? So a "won't click" trigger shows exactly which element received the
      // click and why the outcome was noop/nav/etc.
      if (CLICK_DEBUG) {
        let m = null;
        try {
          m = JSON.parse(
            await handle.evaluate((el) =>
              JSON.stringify({ tag: el.tagName, href: el.getAttribute && el.getAttribute('href'), ppd: !!(el.hasAttribute && el.hasAttribute('data-ppd-click')), cls: (el.className || '').toString().slice(0, 40) })
            )
          );
        } catch { /* ignore */ }
        clog(`d${depth} #${i} CLICK <${m && m.tag}${m && m.ppd ? ' ppd' : ''}> "${(info.label || '').slice(0, 40)}" href=${m && m.href} @${info.x},${info.y} ${info.w}x${info.h} .${m && m.cls}`);
      }

      // Second-opinion prep. BEFORE the click, scroll the trigger to the viewport
      // centre (both the occlusion harvest and the pixel diff need the reveal in
      // view, and the before/after must share a scroll). Then snapshot the "before":
      // the occlusion-aware visible-text set (cheap) and, if pixel is on, the frame.
      // Captured for EVERY click because flat-vs-changed isn't known until after.
      let pxBefore = null;
      let pxBeforeRaw = null;
      let pxScrollY = 0;
      let occBefore = null;
      if (occlusionDetect || pixelDetect) {
        try {
          pxScrollY = await page.evaluate((y) => {
            const vh = window.innerHeight || 0;
            window.scrollTo(0, Math.max(0, Math.round((y || 0) - vh / 2)));
            return window.scrollY || 0;
          }, info.y);
        } catch {
          /* scroll best-effort */
        }
      }
      if (occlusionDetect) {
        try {
          occBefore = await timed('occBefore', () => harvestVisibleViewport(page));
        } catch {
          /* occlusion path degrades off for this click */
        }
      }
      if (pixelDetect) {
        await timed('pixBefore', async () => {
          try {
            pxBefore = await page.screenshot({ type: 'png' });
            pxBeforeRaw = await pixelDiff.frame(pxBefore, { scale: pixelScale });
          } catch {
            /* pixel path degrades to off for this click */
          }
        });
      }
      // Post-click cleanup: reset scroll (the pixel before-frame scrolled us) and
      // drop any leftover #fragment WITHOUT firing a navigation/hashchange
      // (history.replaceState), so an href="#" / hash-route click doesn't leave the
      // SPA on a changed hash for the next trigger. Best-effort.
      const resetScroll = async () => {
        await timed('reset', () =>
          page.evaluate(() => {
            try { window.scrollTo(0, 0); } catch { /* ignore */ }
            try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
          }).catch(() => {})
        );
      };

      // Descend one level: record this click's DOM changes so we can reverse them.
      await page.evaluate(() => window.__ppdMutStart());
      clicks += 1;
      let clickErr = false;
      await timed('click', async () => {
        // Click LIKE A USER: a TRUSTED mouse click at the centre of the trigger's
        // box, engaging whatever is actually there — the full pointerdown/mousedown/
        // click pipeline with isTrusted=true, so delegated handlers (e.g. a swiper
        // card's modal, keyed on e.target/pointer events) fire exactly as they do
        // for a real user. page.mouse.click is a CDP input command (not page JS), so
        // the anti-bot source can't poison it; navigation is neutralised by the
        // nav-sandbox. Falls back to a synthetic el.click() when the trigger has no
        // in-viewport box (off-screen / zero-size). It was scrolled to centre above.
        // Make the trigger hittable ONLY IF a coordinate click would MISS it — i.e.
        // it's not the topmost element at its own centre (clipped out of an overflow
        // strip, so the strip's clip is on top). Then temporarily UN-CLIP its overflow
        // ancestors (overflow:visible) so it renders at its true position and becomes
        // hittable, and RESTORE right after the click. Unlike scrollIntoView this
        // REPOSITIONS NOTHING — so it dodges the transform-containing-block trap (a
        // transformed ancestor reparents position:fixed AND breaks scroll math — spiked
        // on the real source), never snaps a swiper's active slide, and leaves the
        // recorded box at the trigger's true coords. Skip entirely when already hittable
        // (visible triggers untouched). Vertical positioning is the occlusion scroll above.
        // Classify the trigger vs the base backdrop (a screenshot at scroll 0, viewport-
        // WIDTH but full-HEIGHT): 0 = visible/in-backdrop (or only vertical-scrolled away,
        // which is still IN the full-height backdrop) → leave it; 1 = OCCLUDED in-viewport
        // (something clipped it) → un-clip so the coordinate click lands; 2 = off the
        // backdrop's WIDTH (an off-screen carousel/strip card) → hidden, click via el.click.
        // 1 and 2 are "hidden" (not in the backdrop) → the review needs a box + ghost.
        let gateCode = 0;
        try {
          gateCode = await handle.evaluate((el) => {
            window.__ppdUnclip = null;
            const r = el.getBoundingClientRect();
            if (r.width < 1 || r.height < 1) return 0;
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const horizOff = cx < 0 || cx > window.innerWidth;
            const vertOff = cy < 0 || cy > window.innerHeight;
            if (vertOff && !horizOff) return 0; // in the full-height backdrop, just scrolled away
            if (horizOff) return 2; // past the backdrop width → hidden (ghost below; el.click)
            const top = document.elementFromPoint(cx, cy);
            // Hittable = the click lands ON the trigger or a DESCENDANT. NOT top.contains(el):
            // a clipped trigger's overflow CONTAINER is topmost there and DOM-contains it.
            if (top && (top === el || el.contains(top))) return 0; // visible/hittable — don't disturb
            const save = [];
            for (let p = el.parentElement; p; p = p.parentElement) {
              const s = getComputedStyle(p);
              if (/(auto|scroll|hidden|clip)/.test(s.overflowX + ' ' + s.overflowY)) {
                save.push([p, p.style.getPropertyValue('overflow'), p.style.getPropertyValue('overflow-x'), p.style.getPropertyValue('overflow-y')]);
                p.style.setProperty('overflow', 'visible', 'important');
              }
            }
            window.__ppdUnclip = save;
            return save.length > 0 ? 1 : 0;
          });
        } catch { /* best-effort */ }
        const didUnclip = gateCode === 1;
        const vp = page.viewportSize() || { width: 1920, height: 1080 };
        // Not in the backdrop = occluded/off-viewport at click time (gate) OR RECORDED
        // past the backdrop's width (an off-screen carousel/strip card — even if the
        // carousel had scrolled it into view when we clicked it, so the gate saw it as
        // hittable). The backdrop is captured at scroll 0, so a box at x+w > viewport
        // width isn't in it. Either way → the review needs a box + ghost.
        if (gateCode === 1 || gateCode === 2 || geom.triggerX < 0 || geom.triggerX + geom.triggerW > vp.width) geom.hidden = true;
        // GHOST a hidden trigger for the review — captured BEFORE the click: clicking a
        // card OPENS ITS MODAL, which dims/blurs the page behind it (→ gray or blurred
        // captures), so image the element now, while it's pristine. Render even a
        // TRANSFORM-positioned off-screen swiper slide by temporarily neutralising
        // overflow AND transform on its ancestors (whole inline style saved) so it lays
        // out at its natural spot; Playwright scrolls to + images just it; then restore
        // style + scroll. Drop near-uniform blanks (unrenderable slide → clean box, not
        // an empty ghost). Fully separate from the click below.
        if (geom.hidden) {
          try {
            const gw = await page.evaluate(() => [window.scrollX || 0, window.scrollY || 0]);
            await handle.evaluate((el) => {
              window.__ppdGhost = [];
              for (let p = el.parentElement; p; p = p.parentElement) {
                const cs = getComputedStyle(p);
                if (/(auto|scroll|hidden|clip)/.test(cs.overflowX + ' ' + cs.overflowY) || cs.transform !== 'none') {
                  window.__ppdGhost.push([p, p.getAttribute('style') || '']);
                  p.style.setProperty('overflow', 'visible', 'important');
                  p.style.setProperty('transform', 'none', 'important');
                }
              }
            });
            const gbuf = await handle.screenshot({ timeout: 3000 });
            await page.evaluate(() => { for (const [p, s] of window.__ppdGhost || []) { if (s) p.setAttribute('style', s); else p.removeAttribute('style'); } window.__ppdGhost = null; });
            await page.evaluate(([x, y]) => window.scrollTo(x, y), gw);
            let blank = false;
            try { const st = await sharp(gbuf).stats(); blank = st.channels.every((c) => c.stdev < 3); } catch { /* keep it */ }
            if (!blank) geom.ghost = `data:image/png;base64,${gbuf.toString('base64')}`;
          } catch { /* ghost is best-effort */ }
        }
        let box = null;
        try { box = await handle.boundingBox(); } catch { /* ignore */ }
        let clicked = false;
        if (box && box.width >= 1 && box.height >= 1) {
          const cx = box.x + box.width / 2;
          const cy = box.y + box.height / 2;
          if (cx >= 0 && cy >= 0 && cx <= vp.width && cy <= vp.height) {
            try { await page.mouse.click(cx, cy); clicked = true; } catch { /* fall back */ }
          }
        }
        if (!clicked) {
          try { await handle.evaluate((el) => el.click()); } catch { clickErr = true; }
        }
        // Restore the un-clipped overflow immediately: the reveal is a DOM change,
        // unaffected by re-clipping, and (unlike a scroll restore) this can't revert a
        // tab selection. Recorded geometry already reflects the trigger's true position.
        try {
          await page.evaluate(() => {
            for (const [p, o, ox, oy] of window.__ppdUnclip || []) {
              if (o) p.style.setProperty('overflow', o); else p.style.removeProperty('overflow');
              if (ox) p.style.setProperty('overflow-x', ox); else p.style.removeProperty('overflow-x');
              if (oy) p.style.setProperty('overflow-y', oy); else p.style.removeProperty('overflow-y');
            }
            window.__ppdUnclip = null;
          });
        } catch { /* best-effort */ }
      });
      await timed('settle', () => page.waitForTimeout(settleMs));

      // A click that navigated away (blocker missed it) or threw (execution
      // context destroyed) is irreversible → hard reset.
      if (clickErr || navigatedAway()) {
        if (navigatedAway()) navigations += 1;
        clog(`  -> NAV/ERR (url now ${navigatedAway() ? page.url() : 'hash-only/same'}, clickErr=${clickErr}) — reload to base`);
        pushEdge(null, 'nav');
        await reloadToBase();
        return; // unwind; depth-0 caller recovers the sweep
      }

      // Cheap change gate: one quick harvest. Promote to full stable-sampling only
      // if it shows added text — otherwise the text is flat and we skip that cost
      // (the pixel second-opinion still gets a chance below for occlusion / visual-
      // only reveals the DOM harvest can't see).
      let quickAdded = 0;
      try {
        const quick = await timed('quickHarvest', () => harvestVisibleTextInPage(page)); // [{ t }]
        const parentSet = new Set(curStable);
        const seenQuick = new Set();
        for (const o of quick) {
          const k = norm(o.t);
          if (k.length < 2 || seenQuick.has(k)) continue;
          seenQuick.add(k);
          if (!parentSet.has(k)) quickAdded += 1;
        }
      } catch {
        clickErr = true;
      }
      if (clickErr) {
        clog('  -> HARVEST-ERR (likely mid-navigation) — undo + skip');
        await page.evaluate(() => window.__ppdMutUndo()).catch(() => {});
        await resetScroll();
        continue;
      }
      // OCCLUSION second-opinion (primary): re-harvest the viewport counting only
      // TOPMOST text (elementFromPoint). New topmost text vs the pre-click viewport
      // set = a reveal the plain DOM harvest missed because the text was covered
      // (display:block but occluded). Cheap (~5ms) — the pixel path's job for text
      // reveals, without screenshot/OCR. Returns true if it captured/handled a state.
      const tryOcclusionState = async () => {
        if (!occlusionDetect || !occBefore) return false;
        const after = await timed('occAfter', () => harvestVisibleViewport(page));
        const beforeK = new Set(occBefore.map((o) => o.k));
        // Newly TOPMOST-visible text = occAfter − occBefore (same scroll, so the
        // click is the only cause). NOT filtered against curStable: the whole point
        // is that occluded text IS in the display-based base set yet wasn't visible.
        const newItems = after.filter((o) => !beforeK.has(o.k));
        const childDelta = newItems.map((o) => o.k).filter((l) => l.length >= 2);
        if (!childDelta.length) return false;
        const revealed = newItems.map((o) => o.raw);
        const known = findVisited(childDelta, visited, matchOpts);
        if (known) {
          clog(`  -> OCCLUSION known-state (revealed ${JSON.stringify(revealed.slice(0, 2))})`);
          pushEdge(known.key.hash, 'known');
          return true;
        }
        const childSig = signatureKey(childDelta);
        visited.push({ key: childSig, stable: childDelta });
        await timed('captureState', () => captureState(info, revealed, childSig, curSig, depth + 1));
        clog(`  -> OCCLUSION NEW state (revealed ${JSON.stringify(revealed.slice(0, 3))})`);
        pushEdge(childSig.hash, 'new');
        return true;
      };
      // PIXEL second-opinion (fallback for pointer-events:none overlays / non-text
      // visual reveals the occlusion harvest can't see). Same shape as above but
      // via screenshot diff + OCR. Off unless pixelDetect is set.
      const tryPixelState = async () => {
        if (!pixelDetect || !pxBeforeRaw) return false;
        const pr = await timed('pixelReveal', () => pixelReveal(page, pxBefore, pxBeforeRaw, volatile, pxScrollY, opts));
        if (!pr.changed || !pr.revealed.length) return false;
        // Identity = the OCR'd revealed content (the text stable set is flat here,
        // so only the reveal distinguishes these states).
        const childDelta = pr.revealed.map(nnorm).filter((l) => l.length >= 2);
        if (!childDelta.length) return false;
        const known = findVisited(childDelta, visited, matchOpts);
        if (known) {
          clog(`  -> PIXEL known-state (revealed ${JSON.stringify(pr.revealed.slice(0, 2))})`);
          pushEdge(known.key.hash, 'known');
          return true;
        }
        const childSig = signatureKey(childDelta);
        visited.push({ key: childSig, stable: childDelta });
        await timed('captureState', () => captureState(info, pr.revealed, childSig, curSig, depth + 1)); // leaf in P1
        clog(`  -> PIXEL NEW state (revealed ${JSON.stringify(pr.revealed.slice(0, 3))})`);
        pushEdge(childSig.hash, 'new');
        return true;
      };
      // Second opinion on a text-flat click: occlusion (cheap DOM hit-test) first,
      // pixel (screenshot+OCR) as the fallback for what it can't see.
      const trySecondOpinion = async () => {
        // Restore the trigger-centred scroll before the AFTER snapshot. An href="#"
        // anchor click scrolls the viewport to its target section, so without this
        // occAfter (or the pixel after-frame) would be a DIFFERENT viewport than the
        // before — the scrolled-to region's text/pixels look like a false reveal. A
        // pure-scroll anchor now shows no change; a real DOM reveal still does.
        if (occlusionDetect || pixelDetect) {
          try { await page.evaluate((y) => window.scrollTo(0, y), pxScrollY); } catch { /* best-effort */ }
        }
        return (await tryOcclusionState()) || (await tryPixelState());
      };
      if (quickAdded === 0) {
        if (!(await trySecondOpinion())) {
          clog('  -> NOOP (quick-gate: no added text, second-opinion flat)');
          noopGate += 1;
          pushEdge(curSig.hash, 'noop');
        }
        await page.evaluate(() => window.__ppdMutUndo());
        await resetScroll();
        continue;
      }
      clog(`  -> quickAdded=${quickAdded} (promoting to stable sample)`);

      // Promising: get the robust stable signature.
      const { stable: childStable } = await timed('sample', () => sampleStableText(page, sampleOpts));
      const edge = changedFrom(curStable, childStable, matchOpts);
      // Change detection is ADDITIVE, not Jaccard-overlap: a child is always
      // parent + delta, so overlap is always high and would absorb every reveal
      // (a 5-line reveal on a 175-line base scores 0.97 overlap = "same"). Treat
      // it as a new state when it adds — or swaps out (removed) — at least
      // minAdded STABLE lines. Volatile noise stays below the threshold; a
      // carousel slide-swap (equal add+remove) now registers. Default minAdded=1:
      // the stable-text sampling already masks volatile noise, so ANY line in
      // `added` is stable = real content; a single-line panel/tab swap is a real
      // reveal. Dedup (findVisited on the base-relative delta) merges duplicates.
      const minAdded = opts.minAdded ?? 1;
      if (edge.added.length < minAdded && edge.removed.length < minAdded) {
        // No stable text delta — but something visual might have changed
        // (occlusion / visual-only), so ask the second opinion before no-op.
        if (!(await trySecondOpinion())) {
          clog('  -> NOOP (stable-sample: added/removed below threshold, second-opinion flat)');
          noopSig += 1;
          pushEdge(curSig.hash, 'noop');
        }
        await page.evaluate(() => window.__ppdMutUndo());
        await resetScroll();
        continue;
      }

      // A state's IDENTITY is its DELTA FROM BASE — the stable lines unique to it,
      // not its full visible-text set. The full set is dominated by the shared
      // base/chrome every state carries, so two different reveals (card A modal vs
      // card B modal) would look ~0.97 similar and wrongly dedup to one. Diffing
      // the base-relative deltas discriminates them (base itself = empty delta).
      const childDelta = deltaFromBase(childStable);
      const known = findVisited(childDelta, visited, matchOpts);
      if (known) {
        clog(`  -> KNOWN state (text delta matched a visited state; added ${JSON.stringify(edge.added.slice(0, 2))})`);
        pushEdge(known.key.hash, 'known');
        await page.evaluate(() => window.__ppdMutUndo());
        await resetScroll();
        continue;
      }

      // A genuinely new state. Remember it (by its delta), capture it, recurse.
      const childSig = signatureKey(childDelta);
      visited.push({ key: childSig, stable: childDelta });
      await timed('captureState', () => captureState(info, edge.added, childSig, curSig, depth + 1));
      clog(`  -> NEW state +${edge.added.length} (added ${JSON.stringify(edge.added.slice(0, 3))})`);
      pushEdge(childSig.hash, 'new');

      await resetScroll(); // recurse from scroll 0 (the pixel before-frame scrolled us)
      await explore(childStable, childSig, depth + 1, childParentKeys);

      // Ascend: reverse this trigger's effects, back to the current state.
      await page.evaluate(() => window.__ppdMutUndo());
      if (dirty) {
        // A deeper branch reloaded to base; our handles/position are gone.
        if (depth === 0) {
          // Recover the top-level sweep: re-tag, re-grab handles, continue past i.
          dirty = false;
          await tagTriggers(page, TRIGGER_SEL, ITEM_SEL, CLICK_DEBUG);
          handles = await page.$$('[data-ppd-idx]');
          keys = await triggerKeys(page);
          continue;
        }
        return; // let depth 0 do the recovery
      }
    }
  };

  // Seed: the base state itself. Its delta-from-base is empty, so it's the
  // empty-signature root; every discovered state dedups against its OWN delta.
  const { stable: baseStable } = await timed('baseSeed', () => sampleStableText(page, sampleOpts));
  baseSet = new Set(baseStable);
  // Volatile pixel mask: a few static frames → blocks that change on their own
  // (clocks/carousels/video), so the pixel second-opinion ignores them.
  if (pixelDetect) {
    try {
      await timed('volatileSeed', async () => {
        const frames = [];
        for (let i = 0; i < 3; i++) {
          frames.push(await pixelDiff.frame(await page.screenshot({ fullPage: true, type: 'png' }), { scale: pixelScale }));
          if (i < 2) await page.waitForTimeout(250);
        }
        const map = pixelDiff.volatileFromFrames(frames, {});
        const cols = frames[0] ? Math.ceil(frames[0].w / 8) : 0; // block size 8 (pixelDiff default)
        volatile = { map, cols, scale: pixelScale };
      });
    } catch {
      volatile = null;
    }
  }
  const baseSig = signatureKey([]);
  visited.push({ key: baseSig, stable: [] });
  await explore(baseStable, baseSig, 0);

  // Leave the page at BASE. If we returned early (maxStates/time budget) mid-click,
  // mutation-undo levels can be left open; drain them so a caller that reuses this
  // SAME load (the unified capture re-extracts base visibleText after the crawl)
  // sees the pristine page, not a half-open modal.
  try {
    let guard = 0;
    while (guard++ < 500 && (await page.evaluate(() => (window.__ppdStackDepth ? window.__ppdStackDepth() : 0))) > 0) {
      await page.evaluate(() => window.__ppdMutUndo());
    }
  } catch {
    /* best-effort reset */
  }
  // Fix #2 (#62): leave the page PRISTINE for the caller's post-crawl content
  // re-extraction (capture.js extractVisibleText runs after onPageReady). Beyond
  // the mutation-undo above: reset scroll, drop any leftover #fragment, and
  // re-close overlays/menus/panels a click may have opened (nav dropdowns,
  // accessibility toolbar) or that a stalled/timed-out crawl left open — otherwise
  // that text leaks into the base visible-text (the nav/menu-line explosion).
  try {
    await page.evaluate(() => {
      try { window.scrollTo(0, 0); } catch { /* ignore */ }
      try { if (location.hash) history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
    });
    await page.keyboard.press('Escape').catch(() => {});
    await dismissModals(page, capOpts.removeModalSelectors || DEFAULT_MODAL_SELECTORS);
    await hideLowerPinnedOverlays(page);
    await stabilizePageForCapture(page, {
      freezeAnimations: capOpts.freezeAnimations,
      removeModalSelectors: capOpts.removeModalSelectors,
      ocrContrast: capOpts.ocrContrast,
    });
  } catch {
    /* best-effort restore */
  }

  // Emit the per-phase timing breakdown (once, always — cheap and the whole point
  // of the instrumentation). Sorted by total ms, with the invocation count so avg
  // per call is visible. Goes to stderr + run-debug.log (clickLog) + the return.
  {
    const total = Object.values(T).reduce((a, e) => a + e.ms, 0) || 1;
    const brk = Object.entries(T)
      .sort((a, b) => b[1].ms - a[1].ms)
      .map(([k, v]) => `${k}=${(v.ms / 1000).toFixed(1)}s(${((v.ms / total) * 100).toFixed(0)}%,n=${v.n})`)
      .join(' ');
    const line = `TIMING total=${(total / 1000).toFixed(1)}s | ${brk}`;
    console.error('[timing]', line);
    if (typeof opts.clickLog === 'function') { try { opts.clickLog(line); } catch { /* ignore */ } }
  }

  // Back-compat flat reveal list (one entry per revealed line, attributed to its
  // trigger) so the existing pair-worker grouping/snapping/audit keeps working
  // after the crawlUrl -> exploreUrl swap. The graph (states + edges) is what the
  // new hierarchical review consumes.
  const revealed = [];
  for (const s of states) {
    for (const text of s.revealed || []) {
      revealed.push({ text, triggerLabel: s.triggerLabel, triggerX: s.triggerX, triggerY: s.triggerY, triggerW: s.triggerW, triggerH: s.triggerH });
    }
  }

  return {
    states,
    edges,
    revealed,
    baseSignature: baseSig.hash,
    baseStableSize: baseStable.length,
    statesFound: states.length,
    triggersClicked: clicks,
    triggersTotal: baseTriggers,
    noopGate,
    noopSig,
    clicks,
    navigations,
    reloads,
    timing: T,
  };
}

const EMPTY_EXPLORE = {
  states: [],
  edges: [],
  revealed: [],
  baseSignature: null,
  statesFound: 0,
  triggersClicked: 0,
  triggersTotal: 0,
  noopGate: 0,
  noopSig: 0,
  clicks: 0,
  navigations: 0,
  reloads: 0,
};

/**
 * Launch + stabilize a page (reusing the capture pipeline, with timer
 * acceleration installed at init so the stable-text sampling sees slow dynamics)
 * and run the recursive explorer.
 *
 * The heavy real-world source site loads non-deterministically: some loads
 * under-render (e.g. 28 tagged triggers instead of ~68), which starves coverage
 * and breaks source↔target parity. When `minTriggers` is given (the caller knows
 * the base capture's clickable scale) and a load comes up well short, retry the
 * whole load up to `maxLoadAttempts` and keep the richest result — a full-page
 * screenshot of the base is skipped here since the explorer ignores that buffer
 * and the screenshot's scroll only churns the page.
 */
async function exploreUrl(url, opts = {}) {
  const accelFactor = opts.accelFactor ?? 40;
  const minTriggers = opts.minTriggers ?? 0;
  const maxLoadAttempts = opts.maxLoadAttempts ?? (minTriggers > 0 ? 2 : 1);
  let best = null;
  for (let attempt = 0; attempt < maxLoadAttempts; attempt++) {
    let result = EMPTY_EXPLORE;
    try {
      const { onPageReadyResult } = await captureFullPageBuffer(url, {
        ...(opts.captureOptions || {}),
        collectCanonicalLayout: true, // installs the click-listener instrument → better triggers
        skipBaseScreenshot: true, // the explorer captures its own per-state shots; this buffer is unused
        extraInitScript: timerAccelerationInit(accelFactor),
        onPageReady: (page) => exploreStates(page, opts),
      });
      result = onPageReadyResult || EMPTY_EXPLORE;
    } catch {
      /* keep EMPTY; a retry may do better */
    }
    if (!best || (result.triggersTotal || 0) > (best.triggersTotal || 0)) best = result;
    if ((result.triggersTotal || 0) >= minTriggers) break; // a full-enough load — done
  }
  return best || EMPTY_EXPLORE;
}

module.exports = { exploreStates, exploreUrl, installMutationUndoStack };
