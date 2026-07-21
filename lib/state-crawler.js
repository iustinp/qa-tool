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
const { captureFullPageBuffer } = require('./capture');
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

  await installNavBlocker(page);
  let count = await tagTriggers(page, TRIGGER_SEL, ITEM_SEL);
  const seen = new Set((await harvestVisibleText(page)).map(norm));
  const revealed = [];
  const states = [];
  const stateSigs = new Set();
  let clicked = 0;
  let navigations = 0;

  for (let i = 0; i < Math.min(count, maxTriggers); i++) {
    const h = await page.$(`[data-ppd-idx="${i}"]`);
    if (!h) continue;
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

module.exports = { crawlStates, crawlUrl, harvestVisibleText };
