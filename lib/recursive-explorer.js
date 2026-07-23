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

/** Read a trigger's label + document-space geometry (for the review overlay). */
async function triggerInfo(handle) {
  try {
    return await handle.evaluate((el) => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      if (s.display === 'none' || s.visibility === 'hidden' || r.width < 6 || r.height < 6) return null;
      return {
        label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 60),
        x: Math.round(r.left + window.scrollX),
        y: Math.round(r.top + window.scrollY),
        w: Math.round(r.width),
        h: Math.round(r.height),
      };
    });
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
  const baseUrl = page.url();
  const deadline = Date.now() + timeBudgetMs;

  await installNavBlocker(page);
  await installMutationUndoStack(page);

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
    if (captureStates) {
      try {
        clm = await extractCanonicalLayout(page);
      } catch {
        /* pear is best-effort */
      }
      try {
        shot = await page.screenshot({ fullPage: true, type: 'png' });
      } catch {
        /* screenshot is best-effort */
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
    });
  };

  /**
   * Explore the CURRENT state's triggers. `curStable` is the (already sampled)
   * stable signature of the state the page is in right now. Returns nothing; sets
   * the shared `dirty` flag when it had to reload. At depth 0 a dirty branch is
   * recovered (reload + continue the sweep); deeper levels just unwind.
   */
  const explore = async (curStable, curSig, depth) => {
    if (depth >= maxDepth || states.length >= maxStates || timeUp()) return;

    // (Re)tag triggers for THIS state and snapshot element handles up front.
    // Handles stay valid across our own re-tagging and across a child's undo
    // (mutation-undo preserves the node objects), so we don't depend on the
    // data-ppd-idx attribute surviving a deeper re-tag.
    await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
    let handles = await page.$$('[data-ppd-idx]');
    if (depth === 0) baseTriggers = handles.length;
    const limit = Math.min(handles.length, perNodeBudget);

    for (let i = 0; i < limit; i++) {
      if (states.length >= maxStates || timeUp()) return;
      const handle = handles[i];
      if (!handle) continue;
      const info = await triggerInfo(handle);
      if (!info) continue;
      // Trigger geometry travels on the edge so the review can draw the clickable
      // box in the FROM state's view (the state the click was made in).
      const geom = { triggerLabel: info.label, triggerX: info.x, triggerY: info.y, triggerW: info.w, triggerH: info.h };
      const pushEdge = (toSig, kind) => edges.push({ fromSig: curSig.hash, toSig, kind, ...geom });

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

      // Cheap change gate: one quick harvest. Only if it shows added lines beyond
      // the parent's stable set do we pay for a full stable-sampling (which is
      // what we trust for the real changed/dedup decision).
      let quickAdded = 0;
      try {
        const quick = await harvestVisibleTextInPage(page);
        const parentSet = new Set(curStable);
        const seenQuick = new Set();
        for (const raw of quick) {
          const k = norm(raw);
          if (k.length >= 2 && !parentSet.has(k) && !seenQuick.has(k)) {
            seenQuick.add(k);
            quickAdded += 1;
          }
        }
      } catch {
        clickErr = true;
      }
      if (clickErr) {
        await page.evaluate(() => window.__ppdMutUndo()).catch(() => {});
        continue;
      }
      if (quickAdded === 0) {
        // No-op click (or a pure toggle back). Revert and move on.
        noopGate += 1;
        await page.evaluate(() => window.__ppdMutUndo());
        pushEdge(curSig.hash, 'noop');
        continue;
      }

      // Promising: get the robust stable signature of the child state.
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
        // Only volatile noise slipped past the quick gate; not a real change.
        noopSig += 1;
        await page.evaluate(() => window.__ppdMutUndo());
        pushEdge(curSig.hash, 'noop');
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
        continue;
      }

      // A genuinely new state. Remember it (by its delta), capture it, recurse.
      const childSig = signatureKey(childDelta);
      visited.push({ key: childSig, stable: childDelta });
      await captureState(info, edge.added, childSig, curSig, depth + 1);
      pushEdge(childSig.hash, 'new');

      await explore(childStable, childSig, depth + 1);

      // Ascend: reverse this trigger's effects, back to the current state.
      await page.evaluate(() => window.__ppdMutUndo());
      if (dirty) {
        // A deeper branch reloaded to base; our handles/position are gone.
        if (depth === 0) {
          // Recover the top-level sweep: re-tag, re-grab handles, continue past i.
          dirty = false;
          await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
          handles = await page.$$('[data-ppd-idx]');
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
  const baseSig = signatureKey([]);
  visited.push({ key: baseSig, stable: [] });
  await explore(baseStable, baseSig, 0);

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

/**
 * Launch + stabilize a page (reusing the capture pipeline, with timer
 * acceleration installed at init so the stable-text sampling sees slow dynamics)
 * and run the recursive explorer.
 */
async function exploreUrl(url, opts = {}) {
  const accelFactor = opts.accelFactor ?? 40;
  const { onPageReadyResult } = await captureFullPageBuffer(url, {
    ...(opts.captureOptions || {}),
    collectCanonicalLayout: true, // installs the click-listener instrument → better triggers
    extraInitScript: timerAccelerationInit(accelFactor),
    onPageReady: (page) => exploreStates(page, opts),
  });
  return (
    onPageReadyResult || {
      states: [],
      edges: [],
      baseSignature: null,
      statesFound: 0,
      clicks: 0,
      navigations: 0,
      reloads: 0,
    }
  );
}

module.exports = { exploreStates, exploreUrl, installMutationUndoStack };
