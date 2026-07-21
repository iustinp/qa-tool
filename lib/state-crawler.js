/**
 * state-crawler — a bounded, one-hop interaction crawl for content that only
 * appears after a click (lazy/AJAX panels, JS-injected modals, carousel slides
 * not pre-rendered). From the stabilized base state we click each NON-navigating
 * trigger once, harvest newly-visible text, and attribute it to that trigger —
 * giving the union of interaction-gated text plus a "click X → revealed Y"
 * provenance trail (for completeness resolution + the future per-state UI).
 *
 * Deliberately best-effort and bounded: no per-click reload (O(n), one page
 * load), Escape after each click to dismiss modals, and a navigation guard that
 * restores the base page if a click unexpectedly navigates away. It never
 * follows cross-page links.
 */

const crypto = require('crypto');
const os = require('os');
const {
  captureFullPageBuffer,
  stabilizePageForCapture,
  scrollPageForLazyLoad,
  dismissModals,
  hideLowerPinnedOverlays,
  DEFAULT_MODAL_SELECTORS,
} = require('./capture');
const { extractCanonicalLayout } = require('./canonical-layout');

// Triggers we click — interactive, but not cross-page navigation.
const TRIGGER_SEL = [
  'button',
  'summary',
  '[role=button]',
  '[role=tab]',
  '[aria-expanded]',
  '[aria-controls]',
  '[data-ppd-click]',
  'a[href^="#"]',
  'a[href^="javascript:"]',
  '.swiper-slide', // carousel cards often open a modal via delegation on the swiper
  '.swiper-button-next',
  '.swiper-pagination-bullet',
].join(',');

// Item-type triggers that are individually clickable even when nested inside
// another trigger (e.g. a swiper-slide inside a swiper container that itself
// carries a delegated click listener). The outermost-only rule is bypassed for
// these, otherwise the container would shadow every card.
const ITEM_SEL = '.swiper-slide,[role=tab],.swiper-pagination-bullet';

/** Collect currently-visible, on-page text lines. */
function harvestVisibleText(page) {
  return page.evaluate(() => {
    const vis = (el) => {
      for (let p = el; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
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
      out.push(t);
    }
    return out;
  });
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

/** Neutralize cross-page navigation (links/forms/beforeunload) so a click that
 * would leave the page instead just fires its JS handlers (tabs/modals/etc.). */
function installNavBlocker(page) {
  return page.evaluate(() => {
    if (window.__ppdNavBlock) return;
    window.__ppdNavBlock = 1;
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      if (a) {
        const h = (a.getAttribute('href') || '').trim();
        if (h && !h.startsWith('#') && !h.toLowerCase().startsWith('javascript:')) e.preventDefault();
      }
    }, true);
    document.addEventListener('submit', (e) => e.preventDefault(), true);
    window.onbeforeunload = null;
  });
}

/** Tag the outermost, currently-visible triggers with a stable index (so the
 * click budget is spent on real triggers, not hidden mega-menu items); returns
 * the count. */
function tagTriggers(page, sel, itemSel) {
  return page.evaluate(
    ({ SEL, ITEM }) => {
      const vis = (el) => {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity || '1') < 0.05) return false;
        const r = el.getBoundingClientRect();
        return r.width >= 6 && r.height >= 6;
      };
      let i = 0;
      document.querySelectorAll(SEL).forEach((el) => {
        // Skip navigating anchors — clicking them leaves the page, they're not
        // in-page reveals (and the nav-blocker would just no-op the click).
        const a = el.closest('a[href]');
        if (a) {
          const h = (a.getAttribute('href') || '').trim().toLowerCase();
          if (h && !h.startsWith('#') && !h.startsWith('javascript:')) return;
        }
        // Outermost-only, EXCEPT item-type triggers (slides/tabs), which are
        // individually clickable inside a delegated container.
        if (!el.matches(ITEM) && el.parentElement && el.parentElement.closest(SEL)) return;
        if (!vis(el)) return;
        el.setAttribute('data-ppd-idx', String(i));
        i += 1;
      });
      return i;
    },
    { SEL: sel, ITEM: itemSel }
  );
}

/**
 * Run the one-hop crawl on a live, stabilized page. Triggers are re-acquired by
 * index each iteration (robust to DOM mutation / reload); navigation is blocked,
 * with a reload fallback if something still navigates.
 * @returns {{ revealed: Array<{text,triggerLabel,triggerX,triggerY,triggerW,triggerH}>, triggersClicked, triggersTotal, navigations }}
 */
async function crawlStates(page, opts = {}) {
  const maxTriggers = opts.maxTriggers ?? 80;
  const settleMs = opts.settleMs ?? 350;
  const baseUrl = page.url();

  const captureStates = !!opts.captureStates;
  const maxStates = opts.maxStates ?? 60;
  // Parallel mode: workers share the trigger-index queue + result collectors so
  // each trigger is processed exactly once across all pages (Node is single-
  // threaded, so plain counters/Sets are race-free — no locks). Standalone mode
  // keeps everything local.
  const shared = opts.shared || null;
  const seen = shared ? shared.seen : new Set();
  const stateSigs = shared ? shared.stateSigs : new Set();
  const revealed = shared ? shared.revealed : [];
  const states = shared ? shared.states : [];

  await installNavBlocker(page);
  let count = await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
  if (shared) shared.resolveCount(count); // first worker to tag fixes the queue length
  const baseHarvest = (await harvestVisibleText(page)).map(norm);
  for (const k of baseHarvest) seen.add(k);
  const baseSet = new Set(baseHarvest); // this page's pristine base (never grows)
  let clicked = 0;
  let navigations = 0;
  let dirty = false; // previous click left the page in a non-base state

  // Reload + RE-STABILIZE to a clean base (mirrors the initial capture: lazy-load
  // scroll, header-hydration wait, animation freeze / interval clear, modal
  // dismiss, pinned-overlay hide, settle). Without this the reloaded page is
  // half-loaded and still animating, so captured states show weirdness above and
  // below the revealed panel. Re-injecting the freeze style also makes the next
  // click's modal open instantly (no entrance-animation artefacts).
  const capOpts = opts.captureOptions || {};
  const resetToBase = async () => {
    try {
      // Warm reset: assets are cached from the first load, so use
      // domcontentloaded (NOT 'load' — it can stall ~a minute on pages with
      // long-polling/analytics, and piles up under parallel contention) plus a
      // single FAST scroll to rebuild lazy content, then re-stabilize.
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
        await page.waitForFunction(
          () => {
            const h = document.querySelector('header');
            if (!h) return true;
            if ((h.innerText || '').trim().length > 10) return true;
            return !!h.querySelector('nav a, a, img, button, svg');
          },
          { timeout: opts.resetHeaderWaitMs ?? 2500 }
        );
      } catch {
        /* proceed even if the header never populates */
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
      count = await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
    } catch {
      /* best-effort reset */
    }
  };

  const limit = Math.min(shared ? shared.count : count, maxTriggers);
  let localIdx = 0;
  while (true) {
    // Pull the next trigger from the (shared) queue, then drain the retry list
    // (indices a starved/under-loaded worker couldn't find on its page).
    let i;
    if (shared) {
      if (shared.nextIdx < limit) i = shared.nextIdx++;
      else if (shared.retry.length) i = shared.retry.shift();
      else break;
    } else {
      if (localIdx >= limit) break;
      i = localIdx++;
    }
    // Reset to a clean base before the next trigger if the previous click left
    // the page changed — otherwise open panels accumulate and a captured state
    // shows several unrelated things at once. Only when still dirty after Escape
    // (a stuck tab/accordion); modals that Escape closes need no reload.
    if (captureStates && dirty) {
      await resetToBase();
      dirty = false;
    }
    const h = await page.$(`[data-ppd-idx="${i}"]`);
    if (!h) {
      // This worker's page may be under-loaded or mid-reset — hand the index to
      // another worker (bounded to 2 attempts) rather than dropping it.
      if (shared) {
        const a = shared.attempts.get(i) || 1;
        if (a < 2) {
          shared.attempts.set(i, a + 1);
          shared.retry.push(i);
        }
      }
      continue;
    }
    let info = null;
    try {
      info = await h.evaluate((el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (s.display === 'none' || s.visibility === 'hidden' || r.width < 6 || r.height < 6) return null;
        return {
          label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 60),
          x: Math.round(r.left + window.scrollX),
          y: Math.round(r.top + window.scrollY),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
      });
    } catch {
      continue;
    }
    if (!info) continue;
    clicked += 1;
    try {
      await h.scrollIntoViewIfNeeded({ timeout: 800 });
      await h.click({ timeout: 1200 });
    } catch {
      continue;
    }
    await page.waitForTimeout(settleMs);
    if (page.url() !== baseUrl) {
      navigations += 1;
      try {
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(settleMs);
        await installNavBlocker(page);
        count = await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
      } catch {
        /* ignore */
      }
      continue;
    }
    const now = await harvestVisibleText(page);
    const clickNew = [];
    for (const t of now) {
      const k = norm(t);
      if (k && !seen.has(k)) {
        seen.add(k);
        clickNew.push(t);
        revealed.push({ text: t, triggerLabel: info.label, triggerX: info.x, triggerY: info.y, triggerW: info.w, triggerH: info.h });
      }
    }
    // Per-state capture: when a click actually reveals new content, snapshot the
    // resulting state as a pear (CLM) + full-page screenshot, keyed to the
    // trigger. Deduped by a signature of the full visible-text set, so the same
    // panel opened by many triggers is stored once; bounded by maxStates. A
    // click that changes nothing (a blocked navigation link, an inert card)
    // reveals no new text and therefore captures no state — which is exactly why
    // a link-only card produces nothing to show.
    if (captureStates && clickNew.length && states.length < maxStates) {
      const sig = crypto.createHash('sha1').update(now.map(norm).sort().join('\n')).digest('hex');
      if (!stateSigs.has(sig)) {
        stateSigs.add(sig);
        let clm = null;
        let shot = null;
        try {
          clm = await extractCanonicalLayout(page);
        } catch {
          /* ignore — pear is best-effort */
        }
        try {
          shot = await page.screenshot({ fullPage: true, type: 'png' });
        } catch {
          /* ignore — screenshot is best-effort */
        }
        states.push({
          signature: sig,
          triggerLabel: info.label,
          triggerX: info.x,
          triggerY: info.y,
          triggerW: info.w,
          triggerH: info.h,
          revealedCount: clickNew.length,
          revealed: clickNew.slice(0, 200),
          clm,
          shot,
        });
      }
    }
    try {
      await page.keyboard.press('Escape'); // close any modal this opened
    } catch {
      /* ignore */
    }
    // Did this click leave the page changed after Escape? Modals close → base is
    // restored (freeze still intact, no reload needed). A stuck tab/accordion
    // still shows non-base text → mark dirty so the next iteration reloads.
    if (captureStates && clickNew.length) {
      try {
        const after = await harvestVisibleText(page);
        dirty = after.some((t) => {
          const k = norm(t);
          return k && !baseSet.has(k);
        });
      } catch {
        dirty = true;
      }
    }
  }
  if (shared) {
    shared.triggersClicked += clicked;
    shared.navigations += navigations;
  }
  return { revealed, states, triggersClicked: clicked, triggersTotal: count, navigations };
}

/** Launch + stabilize a page (reusing the capture pipeline) and crawl it. */
async function crawlUrl(url, opts = {}) {
  const { onPageReadyResult } = await captureFullPageBuffer(url, {
    ...(opts.captureOptions || {}),
    collectCanonicalLayout: true, // installs the click-listener instrument → better triggers
    onPageReady: (page) => crawlStates(page, opts),
  });
  return onPageReadyResult || { revealed: [], states: [], triggersClicked: 0, triggersTotal: 0, navigations: 0 };
}

/** Worker count: one per clickable trigger, hard-capped (each worker is a full
 * browser, ~0.3-0.5 GB, and both page sides may run) — default scales with CPUs
 * and is overridable via opts.maxWorkers / PPD_CRAWL_WORKERS (never above 10). */
function resolveMaxWorkers(opts) {
  const req = opts.maxWorkers ?? (parseInt(process.env.PPD_CRAWL_WORKERS || '', 10) || null);
  // Each worker is a FULL browser (multi-process, does lazy-scroll + 6 MB
  // screenshots), so a browser wants several cores. Beyond ~4 concurrent they
  // thrash and under-load — starved worker pages tag partially, and against the
  // shared index queue that silently drops triggers. Default 4 (hard cap 10);
  // crawlUrlParallel clamps to the trigger count. Override via opts.maxWorkers /
  // PPD_CRAWL_WORKERS. (One-browser-N-pages would scale higher — see PR notes.)
  return Math.max(1, Math.min(req || 4, 10));
}

/**
 * Parallel crawl: split the triggers across N worker pages (N = min(trigger
 * count, cap)) that share one index queue + result collectors and run
 * concurrently. Worker 0 loads+tags first and fixes the queue length; the rest
 * spawn once that count is known. Each worker resets its OWN page between its
 * triggers. Same return shape as crawlUrl (+ workers).
 */
async function crawlUrlParallel(url, opts = {}) {
  const cap = resolveMaxWorkers(opts);
  let resolveCount;
  const shared = {
    seen: new Set(),
    stateSigs: new Set(),
    revealed: [],
    states: [],
    nextIdx: 0,
    count: null,
    triggersClicked: 0,
    navigations: 0,
    retry: [], // indices a worker couldn't find (retried by another worker)
    attempts: new Map(),
    workerErrors: 0,
    lastError: null,
  };
  shared.countReady = new Promise((r) => {
    resolveCount = r;
  });
  shared.resolveCount = (c) => {
    if (shared.count == null) {
      shared.count = c;
      resolveCount(c);
    }
  };

  const runWorker = (workerId) =>
    crawlUrl(url, { ...opts, shared, workerId }).catch((e) => {
      shared.workerErrors += 1;
      shared.lastError = (e && e.message) || String(e);
      return {};
    });
  const promises = [runWorker(0)];
  // Ensure countReady resolves even if worker 0 dies before tagging (no hang).
  promises[0].finally(() => shared.resolveCount(0));
  const count = await shared.countReady;
  const n = Math.max(1, Math.min(count || 1, cap));
  for (let w = 1; w < n; w++) promises.push(runWorker(w));
  await Promise.all(promises);
  return {
    revealed: shared.revealed,
    states: shared.states,
    triggersClicked: shared.triggersClicked,
    triggersTotal: shared.count ?? count ?? 0,
    navigations: shared.navigations,
    workers: n,
    workerErrors: shared.workerErrors,
    lastError: shared.lastError,
  };
}

module.exports = { crawlStates, crawlUrl, crawlUrlParallel, harvestVisibleText };
