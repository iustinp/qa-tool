/**
 * Symmetric UI state expansion: click generic tab/next/accordion controls and union visible text.
 */

const { extractVisibleText } = require('./visible-text');
const {
  getTextExpansionMode,
  discoverFullPageInteractions,
  applyInteractionRegions,
} = require('./block-interaction');

const DEFAULT_MAX_ACTIVATIONS = 30;
const DEFAULT_MAX_PER_SELECTOR = 15;
const DEFAULT_SETTLE_MS = 300;

// Generic ARIA activators (tabs / accordions) — NOT framework classes. Kept: they reveal
// display:none-until-activated panels symmetrically. Carousels are handled framework-blind
// by advanceScrollCarousels (scrollLeft), which replaced the old .swiper-*/.slick-*/
// carousel-control next-button + slide-indicator selectors (those fired only on sites using
// those class names — asymmetric, inflating "missing" — and are not global).
const ACTIVATOR_SELECTORS = [
  '[role="tab"]',
  '[role="button"][aria-controls]',
  'button[aria-controls]',
  'button[aria-expanded="false"]',
  '[aria-expanded="false"][role="button"]',
  'details:not([open]) > summary',
];

function debugProbeNeedle() {
  return (process.env.PPD_DEBUG_TEXT_PROBE || '').trim();
}

/**
 * Optional DOM probe when PPD_DEBUG_TEXT_PROBE is set (tuning / troubleshooting).
 * @param {import('playwright').Page} page
 * @param {string} needle
 */
async function probeDomForNeedle(page, needle) {
  if (!needle) return null;
  const n = needle.toLowerCase();
  return page.evaluate((substr) => {
    const body = (document.body?.innerText || '').toLowerCase();
    const inBodyInnerText = body.includes(substr);
    let inHiddenDom = false;
    let hiddenHost = null;
    document.querySelectorAll('*').forEach((el) => {
      if (!(el instanceof HTMLElement)) return;
      const t = (el.innerText || '').toLowerCase();
      if (!t.includes(substr)) return;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      const visible =
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        parseFloat(style.opacity) >= 0.05 &&
        rect.width >= 2 &&
        rect.height >= 2;
      if (!visible && !hiddenHost) {
        inHiddenDom = true;
        hiddenHost = el.tagName + (el.className ? `.${String(el.className).slice(0, 40)}` : '');
      }
    });
    const nextControls = [];
    document.querySelectorAll('button, a, [role="button"]').forEach((el) => {
      const label = (
        el.getAttribute('aria-label') ||
        el.getAttribute('title') ||
        el.textContent ||
        ''
      )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
      const cls = String(el.className || '');
      if (!/next|previous|prev|slide|carousel|swiper|slick/i.test(`${label} ${cls}`)) return;
      const rect = el.getBoundingClientRect();
      nextControls.push({
        label,
        className: cls.slice(0, 60),
        visible: rect.width >= 2 && rect.height >= 2,
      });
    });
    return { inBodyInnerText, inHiddenDom, hiddenHost, nextControls: nextControls.slice(0, 20) };
  }, n);
}

function needleInUnion(union, needle) {
  if (!needle) return false;
  const n = needle.toLowerCase();
  for (const line of union) {
    if (line.toLowerCase().includes(n)) return true;
  }
  return false;
}

function envInt(name, fallback) {
  const v = process.env[name];
  if (v == null || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function isTextExpansionEnabled() {
  const v = process.env.PPD_TEXT_EXPANSION;
  if (v === '0' || v === 'false') return false;
  return true;
}

function scopeRootLocator(page) {
  const scope = (process.env.PPD_TEXT_EXPANSION_SCOPE || 'main').trim().toLowerCase();
  if (scope === 'body' || scope === 'none' || scope === 'full') {
    return page.locator('body');
  }
  return page.locator('main, [role="main"]').first();
}

/**
 * @param {Set<string>} union
 * @param {string[]} lines
 */
function mergeLines(union, lines) {
  let added = 0;
  for (const line of lines) {
    if (!union.has(line)) {
      union.add(line);
      added += 1;
    }
  }
  return added;
}

/**
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator} root
 * @param {string} selector
 * @param {object} opts
 * @param {object} state
 */
async function clickEachInScope(page, root, selector, opts, state, clickOpts = {}) {
  const loc = root.locator(selector);
  const count = await loc.count();
  const limit = Math.min(count, opts.maxPerSelector);
  const force = clickOpts.force === true;
  const entry = state.clickLog
    ? {
        kind: clickOpts.kind || 'activator',
        selector,
        matchCount: count,
        clicked: 0,
        skippedNotVisible: 0,
        failed: 0,
        linesAdded: 0,
        force,
      }
    : null;

  for (let i = 0; i < limit; i++) {
    if (state.activations >= state.maxActivations) break;
    const item = loc.nth(i);
    try {
      if (!force && !(await item.isVisible({ timeout: 500 }))) {
        if (entry) entry.skippedNotVisible += 1;
        continue;
      }
      await item.click({ timeout: opts.clickTimeoutMs, force });
      await page.waitForTimeout(opts.settleMs);
      const { visibleText } = await extractVisibleText(page, opts.extractOpts);
      const added = mergeLines(state.union, visibleText);
      if (entry) {
        entry.linesAdded += added;
        entry.clicked += 1;
      }
      state.activations += 1;
      if (state.needle && needleInUnion(state.union, state.needle)) {
        state.needleFoundAfterClick = true;
      }
    } catch {
      if (entry) entry.failed += 1;
    }
  }
  if (entry) state.clickLog.push(entry);
}

/**
 * Framework-blind carousel text harvest — replaces the old swiper/slick/carousel
 * next-button + slide-indicator selector hacks. A carousel is any element that CLIPS
 * horizontal overflow (overflow-x auto/scroll/hidden) AND whose content is wider than its
 * box (scrollWidth > clientWidth) — the core property of "scrollable", independent of any
 * class name or language. For each, step scrollLeft across the full range and union the
 * visible text at each stop, so a slide whose text is display:none-until-scrolled is
 * captured. scrollLeft moves transform-driven swipers too (they also overflow — validated).
 * Runs the SAME on both source and target (the old class hacks fired only where those
 * classes exist, so they harvested asymmetrically and inflated "missing").
 * @param {import('playwright').Page} page
 * @param {object} opts
 * @param {object} state
 */
async function advanceScrollCarousels(page, opts, state) {
  const containers = await page.evaluate(() => {
    const out = [];
    let idx = 0;
    for (const el of document.querySelectorAll('*')) {
      if (el === document.documentElement || el === document.body) continue;
      const cs = getComputedStyle(el);
      if (!/(auto|scroll|hidden)/.test(cs.overflowX)) continue;
      if (el.clientWidth < 40) continue;
      if (el.scrollWidth <= el.clientWidth + 2) continue; // must overflow to hide slides
      el.setAttribute('data-ppd-carousel', String(idx));
      out.push({ id: idx, client: el.clientWidth, scroll: el.scrollWidth });
      idx += 1;
    }
    return out;
  });
  try {
    for (const c of containers) {
      if (state.activations >= state.maxActivations) break;
      const maxSL = c.scroll - c.client;
      const stepPx = Math.max(120, Math.round(c.client * 0.8)); // ~80% of the box per stop
      const entry = state.clickLog
        ? { kind: 'carousel_scroll', client: c.client, scroll: c.scroll, stops: 0, linesAdded: 0 }
        : null;
      for (let target = stepPx; ; target += stepPx) {
        if (state.activations >= state.maxActivations) break;
        const clamped = Math.min(maxSL, target);
        await page.evaluate(
          ({ id, t }) => { const el = document.querySelector(`[data-ppd-carousel="${id}"]`); if (el) el.scrollLeft = t; },
          { id: c.id, t: clamped }
        );
        await page.waitForTimeout(opts.settleMs);
        const { visibleText } = await extractVisibleText(page, opts.extractOpts);
        const added = mergeLines(state.union, visibleText);
        state.activations += 1;
        if (entry) { entry.stops += 1; entry.linesAdded += added; }
        if (state.needle && needleInUnion(state.union, state.needle)) state.needleFoundAfterClick = true;
        if (clamped >= maxSL) break;
      }
      if (entry) state.clickLog.push(entry);
    }
  } finally {
    // Always restore: reset scrollLeft and drop the marker attribute on every container.
    await page
      .evaluate(() => {
        for (const el of document.querySelectorAll('[data-ppd-carousel]')) {
          try { el.scrollLeft = 0; } catch { /* gone */ }
          el.removeAttribute('data-ppd-carousel');
        }
      })
      .catch(() => {});
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {{ minLineLength?: number }} [extractOpts]
 * @returns {Promise<object>}
 */
async function extractExpandedWithSelectors(page, extractOpts = {}, initialUnion = null) {
  const opts = {
    maxActivations: envInt('PPD_TEXT_EXPANSION_MAX_ACTIVATIONS', DEFAULT_MAX_ACTIVATIONS),
    maxPerSelector: envInt('PPD_TEXT_EXPANSION_MAX_PER_SELECTOR', DEFAULT_MAX_PER_SELECTOR),
    settleMs: envInt('PPD_TEXT_EXPANSION_SETTLE_MS', DEFAULT_SETTLE_MS),
    clickTimeoutMs: envInt('PPD_TEXT_EXPANSION_CLICK_TIMEOUT_MS', 1500),
    extractOpts,
  };

  const needle = debugProbeNeedle();
  const baseline = await extractVisibleText(page, extractOpts);
  const baselineLines = baseline.visibleText;
  const union = initialUnion
    ? new Set([...baselineLines, ...initialUnion])
    : new Set(baselineLines);
  const state = {
    union,
    activations: 0,
    maxActivations: opts.maxActivations,
    clickLog: needle ? [] : null,
    needle: needle || null,
    needleFoundAfterClick: needle ? needleInUnion(union, needle) : false,
  };

  const root = scopeRootLocator(page);
  const hasRoot = (await root.count()) > 0;
  const searchRoot = hasRoot ? root : page.locator('body');
  const scopeUsed = process.env.PPD_TEXT_EXPANSION_SCOPE || 'main';

  let probeBaseline = null;
  if (needle) probeBaseline = await probeDomForNeedle(page, needle);

  for (const sel of ACTIVATOR_SELECTORS) {
    await clickEachInScope(page, searchRoot, sel, opts, state);
  }

  // Carousels: framework-blind scrollLeft advance (replaces the .swiper-*/.slick-*/carousel
  // next-button + slide-indicator selector hacks). Whole page, not scope-limited — a
  // scroll-container is identified by its overflow geometry, not by living under <main>.
  await advanceScrollCarousels(page, opts, state);

  const expandedVisibleText = Array.from(state.union);
  const linesAddedByExpansion = expandedVisibleText.length - baselineLines.length;

  let probeFinal = null;
  if (needle) probeFinal = await probeDomForNeedle(page, needle);

  const expansion = {
    enabled: true,
    mode: 'selectors',
    activations: state.activations,
    baselineLineCount: baselineLines.length,
    expandedLineCount: expandedVisibleText.length,
    linesAddedByExpansion,
    scope: scopeUsed,
  };

  if (needle) {
    expansion.debug = {
      probeNeedle: needle,
      probeBaseline,
      probeFinal,
      inExpandedUnion: needleInUnion(state.union, needle),
      clickLog: state.clickLog,
    };
  }

  return {
    visibleText: baselineLines,
    expandedVisibleText,
    visibleTextCharCount: baselineLines.reduce((n, l) => n + l.length, 0),
    expandedVisibleTextCharCount: expandedVisibleText.reduce((n, l) => n + l.length, 0),
    expansion,
  };
}

async function extractExpandedWithVision(page, extractOpts = {}) {
  const screenshot = await page.screenshot({ fullPage: true, type: 'png' });
  const { regions, rawPreview } = await discoverFullPageInteractions(screenshot);
  const result = await applyInteractionRegions(page, regions, { extractOpts });
  if (rawPreview) {
    result.expansion.rawPreview = rawPreview;
  }
  return result;
}

/**
 * @param {import('playwright').Page} page
 * @param {{ minLineLength?: number }} [extractOpts]
 * @returns {Promise<object>}
 */
async function extractExpandedVisibleText(page, extractOpts = {}) {
  const mode = getTextExpansionMode();
  if (mode === 'segment') {
    const baseline = await extractVisibleText(page, extractOpts);
    return {
      visibleText: baseline.visibleText,
      expandedVisibleText: baseline.visibleText,
      visibleTextCharCount: baseline.visibleTextCharCount,
      expandedVisibleTextCharCount: baseline.visibleTextCharCount,
      expansion: {
        enabled: false,
        deferred: 'segment',
        baselineLineCount: baseline.visibleText.length,
        expandedLineCount: baseline.visibleText.length,
        linesAddedByExpansion: 0,
      },
    };
  }
  if (mode === 'vision') {
    return extractExpandedWithVision(page, extractOpts);
  }
  if (mode === 'both') {
    const vision = await extractExpandedWithVision(page, extractOpts);
    const merged = await extractExpandedWithSelectors(page, extractOpts, vision.expandedVisibleText);
    return {
      ...merged,
      expansion: {
        ...merged.expansion,
        mode: 'both',
        visionActivations: vision.expansion?.activations ?? 0,
        visionRegionCount: vision.expansion?.regionCount ?? 0,
      },
    };
  }
  return extractExpandedWithSelectors(page, extractOpts);
}

module.exports = {
  extractExpandedVisibleText,
  extractExpandedWithSelectors,
  extractExpandedWithVision,
  getTextExpansionMode,
  isTextExpansionEnabled,
  ACTIVATOR_SELECTORS,
};
