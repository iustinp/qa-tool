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
  // OCR the tight changed regions on BOTH frames; keep after-lines that weren't
  // there before (the reveal). Temp files for the tesseract binary.
  const tmp = () => pathMod.join(os.tmpdir(), `ppdpx_${Date.now()}_${Math.random().toString(36).slice(2)}.png`);
  const seen = new Set();
  const revealed = [];
  for (const r of det.regions.slice(0, maxRegions)) {
    const left = Math.max(0, Math.round(r.left * inv) - 2);
    const top = Math.max(0, Math.round(r.top * inv) - 2);
    const clip = {
      left,
      top,
      width: Math.min(Math.round(r.width * inv) + 4, (fullW || left + 1) - left),
      height: Math.min(Math.round(r.height * inv) + 4, (fullH || top + 1) - top),
    };
    if (clip.width < 3 || clip.height < 3) continue;
    let aItems = [];
    let bItems = [];
    const af = tmp();
    const bf = tmp();
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
    for (const it of aItems) {
      const n = nnorm(it.text);
      if (n.length > 2 && !seen.has(n) && !bset.some((b2) => b2.includes(n) || n.includes(b2))) {
        seen.add(n);
        revealed.push(it.text.trim());
      }
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
  let volatile = null; // block map of self-changing pixels (clocks/carousels)
  const baseUrl = page.url();
  const deadline = Date.now() + timeBudgetMs;

  await installNavBlocker(page);
  await installMutationUndoStack(page);

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
    let clm = null;
    let shot = null;
    let captureScrollY = 0;
    let vpW = 0;
    let vpH = 0;
    if (captureStates) {
      // #62 Phase A — VIEWPORT-AT-CLICKABLE backdrop. Scroll the trigger to the
      // vertical centre, then shoot the VIEWPORT (not the full page). A full-page
      // shot rendered a fixed/centred modal ~75% down a ~10k-px canvas, detached
      // from the click; a viewport shot scrolled to the trigger shows the reveal
      // where the user would actually see it. captureScrollY is recorded so the
      // review/geometry can map the document-space child-trigger boxes into this
      // backdrop's viewport frame (subtract scrollY). Scroll is restored to 0
      // afterwards so the recursion/siblings run from the same place clicks do
      // (avoids scroll-triggered lazy content that mutation-undo can't reverse).
      try {
        const scr = await page.evaluate((y) => {
          const vh = window.innerHeight || 0;
          window.scrollTo(0, Math.max(0, Math.round((y || 0) - vh / 2)));
          return { scrollY: window.scrollY || 0, vw: window.innerWidth || 0, vh };
        }, info.y);
        captureScrollY = scr.scrollY;
        vpW = scr.vw;
        vpH = scr.vh;
        await page.waitForTimeout(80); // let sticky/scroll-linked paint settle
      } catch {
        /* scroll is best-effort; fall back to whatever scroll we were at */
      }
      try {
        clm = await extractCanonicalLayout(page);
      } catch {
        /* pear is best-effort */
      }
      try {
        shot = await page.screenshot({ type: 'png' }); // VIEWPORT, not fullPage
      } catch {
        /* screenshot is best-effort */
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
    await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
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

      // #62 D — pixel second-opinion prep. BEFORE the click, scroll the trigger to
      // the viewport centre and grab a cheap VIEWPORT before-frame. viewport-at-
      // clickable requires the before/after to share a scroll, and the trigger may
      // be below the fold, so we scroll here (restored to 0 once the click is
      // resolved). Captured for EVERY click because flat-vs-changed isn't known
      // until after clicking; only text-flat clicks actually run the diff.
      let pxBefore = null;
      let pxBeforeRaw = null;
      let pxScrollY = 0;
      if (pixelDetect) {
        try {
          pxScrollY = await page.evaluate((y) => {
            const vh = window.innerHeight || 0;
            window.scrollTo(0, Math.max(0, Math.round((y || 0) - vh / 2)));
            return window.scrollY || 0;
          }, info.y);
          pxBefore = await page.screenshot({ type: 'png' });
          pxBeforeRaw = await pixelDiff.frame(pxBefore, { scale: pixelScale });
        } catch {
          /* pixel path degrades to off for this click */
        }
      }
      const resetScroll = async () => {
        if (pixelDetect) await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
      };

      // Descend one level: record this click's DOM changes so we can reverse them.
      await page.evaluate(() => window.__ppdMutStart());
      clicks += 1;
      let clickErr = false;
      try {
        // Click without scrolling (a scroll can trigger lazy content that isn't a
        // reversible click-effect). Off-viewport elements still get the click.
        await handle.evaluate((el) => el.click());
      } catch {
        clickErr = true;
      }
      await page.waitForTimeout(settleMs);

      // A click that navigated away (blocker missed it) or threw (execution
      // context destroyed) is irreversible → hard reset.
      if (clickErr || page.url() !== baseUrl) {
        if (page.url() !== baseUrl) navigations += 1;
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
        const quick = await harvestVisibleTextInPage(page); // [{ t }]
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
        await page.evaluate(() => window.__ppdMutUndo()).catch(() => {});
        await resetScroll();
        continue;
      }
      // PIXEL second-opinion for a text-flat click (reachable HERE via the quick
      // gate, OR later at noopSig once volatile noise like a clock inflated the
      // quick harvest into a full sample). Captures occlusion / visual-only reveals
      // the DOM harvest is blind to. Returns true if it captured/handled a state.
      const tryPixelState = async () => {
        if (!pixelDetect || !pxBeforeRaw) return false;
        const pr = await pixelReveal(page, pxBefore, pxBeforeRaw, volatile, pxScrollY, opts);
        if (!pr.changed || !pr.revealed.length) return false;
        // Identity = the OCR'd revealed content (the text stable set is flat here,
        // so only the reveal distinguishes these states).
        const childDelta = pr.revealed.map(nnorm).filter((l) => l.length >= 2);
        if (!childDelta.length) return false;
        const known = findVisited(childDelta, visited, matchOpts);
        if (known) {
          pushEdge(known.key.hash, 'known');
          return true;
        }
        const childSig = signatureKey(childDelta);
        visited.push({ key: childSig, stable: childDelta });
        await captureState(info, pr.revealed, childSig, curSig, depth + 1); // leaf in P1
        pushEdge(childSig.hash, 'new');
        return true;
      };
      if (quickAdded === 0) {
        if (!(await tryPixelState())) {
          noopGate += 1;
          pushEdge(curSig.hash, 'noop');
        }
        await page.evaluate(() => window.__ppdMutUndo());
        await resetScroll();
        continue;
      }

      // Promising: get the robust stable signature.
      const { stable: childStable } = await sampleStableText(page, sampleOpts);
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
        // No stable text delta — but the pixels might still have changed
        // (occlusion/visual-only), so ask the pixel second-opinion before no-op.
        if (!(await tryPixelState())) {
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
        pushEdge(known.key.hash, 'known');
        await page.evaluate(() => window.__ppdMutUndo());
        await resetScroll();
        continue;
      }

      // A genuinely new state. Remember it (by its delta), capture it, recurse.
      const childSig = signatureKey(childDelta);
      visited.push({ key: childSig, stable: childDelta });
      await captureState(info, edge.added, childSig, curSig, depth + 1);
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
          await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
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
  const { stable: baseStable } = await sampleStableText(page, sampleOpts);
  baseSet = new Set(baseStable);
  // Volatile pixel mask: a few static frames → blocks that change on their own
  // (clocks/carousels/video), so the pixel second-opinion ignores them.
  if (pixelDetect) {
    try {
      const frames = [];
      for (let i = 0; i < 3; i++) {
        frames.push(await pixelDiff.frame(await page.screenshot({ fullPage: true, type: 'png' }), { scale: pixelScale }));
        if (i < 2) await page.waitForTimeout(250);
      }
      const map = pixelDiff.volatileFromFrames(frames, {});
      const cols = frames[0] ? Math.ceil(frames[0].w / 8) : 0; // block size 8 (pixelDiff default)
      volatile = { map, cols, scale: pixelScale };
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
