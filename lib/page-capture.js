/**
 * PageCapture — the capture-layer data model the rest of the pipeline builds on.
 *
 * A page (source or target) is captured across one or more **profiles**
 * (desktop/mobile/…), and within each profile across one or more **states**
 * (interaction paths — a single "base" state today; click-everything adds more
 * in Phase 3). Comparison then works off `visibleTextUnion` (content axis) and
 * per-state screenshots (visual axis) without caring how they were produced.
 *
 *   PageCapture { url, role, profiles: { [name]: {
 *       profileName, metadata, buffer (primary-state screenshot),
 *       states: [{ id, interactionPath, buffer, domSignature, visibleText, textExpansion }],
 *       visibleTextUnion: string[],
 *   }}}
 *
 * Phase 0 populates exactly one profile (desktop) with one state (base), which
 * keeps behavior identical to the previous single-capture flow.
 */

const crypto = require('crypto');
const { captureFullPageBuffer } = require('./capture');
const { resolveProfile } = require('./profiles');
const { summarizeEdsStructure } = require('./eds-structure');

/** Stable short hash of a page's visible-text lines — cheap state/dedup key. */
function domSignatureForLines(lines) {
  return crypto
    .createHash('sha256')
    .update((lines || []).join('\n'))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Union of a profile's states' text. Expanded text is already a union across
 * interaction clicks, so a single base state's expanded text is its union.
 */
function visibleTextUnionFromStates(states) {
  const union = new Set();
  for (const s of states) {
    for (const line of s.unionLines || s.visibleText || []) union.add(line);
  }
  return Array.from(union);
}

/**
 * Capture one page across the requested profiles.
 * @param {string} url
 * @param {object} options
 * @param {'source'|'target'|'page'} [options.role]
 * @param {string[]} [options.profiles] profile names (default ['desktop'])
 * @param {object} [options.captureOptions] passed through to captureFullPageBuffer
 * @param {Function} [options.logCaptureStep]
 * @returns {Promise<object>} PageCapture
 */
async function capturePage(url, options = {}) {
  const {
    role = 'page',
    profiles = ['desktop'],
    captureOptions = {},
    logCaptureStep,
  } = options;

  const pageCapture = { url, role, profiles: {} };

  for (const profName of profiles) {
    const profile = resolveProfile(profName);
    const cap = await captureFullPageBuffer(url, {
      ...captureOptions,
      profile,
      captureRole: role,
      captureUrl: url,
      logCaptureStep,
      // The target is always EDS — parse its block structure (no AI) so later
      // matching can use it instead of vision-locating each block.
      collectEdsStructure: role === 'target',
    });
    const meta = cap.metadata || {};
    const expanded = Array.isArray(meta.expandedVisibleText) ? meta.expandedVisibleText : [];
    const visible = Array.isArray(meta.visibleText) ? meta.visibleText : [];
    const state = {
      id: 'base',
      interactionPath: [],
      buffer: cap.buffer,
      domSignature: domSignatureForLines(visible),
      visibleText: visible,
      unionLines: expanded.length ? expanded : visible,
      textExpansion: meta.textExpansion || null,
    };
    pageCapture.profiles[profile.name] = {
      profileName: profile.name,
      metadata: meta,
      buffer: cap.buffer,
      states: [state],
      visibleTextUnion: visibleTextUnionFromStates([state]),
      edsStructure: meta.edsStructure || null,
      onPageReadyResult: cap.onPageReadyResult || null,
    };
  }

  return pageCapture;
}

/** @returns {string} name of the first (primary) profile in a PageCapture */
function primaryProfileName(pageCapture) {
  return Object.keys(pageCapture.profiles)[0];
}

/** @returns {object} the primary profile's capture entry */
function primaryProfile(pageCapture) {
  return pageCapture.profiles[primaryProfileName(pageCapture)];
}

/** Buffer-free, JSON-serializable summary for pair-report.json. */
function summarizePageCapture(pageCapture) {
  const profiles = {};
  for (const [name, p] of Object.entries(pageCapture.profiles)) {
    profiles[name] = {
      profileName: name,
      viewportWidth: p.metadata?.viewportWidth ?? null,
      viewportHeight: p.metadata?.viewportHeight ?? null,
      pageHeight: p.metadata?.pageHeight ?? null,
      title: p.metadata?.title ?? '',
      visibleTextUnionCount: p.visibleTextUnion.length,
      edsStructure: summarizeEdsStructure(p.edsStructure),
      states: p.states.map((s) => ({
        id: s.id,
        interactionPath: s.interactionPath,
        domSignature: s.domSignature,
        lineCount: s.visibleText.length,
      })),
    };
  }
  return { url: pageCapture.url, role: pageCapture.role, profiles };
}

module.exports = {
  capturePage,
  primaryProfile,
  primaryProfileName,
  summarizePageCapture,
  domSignatureForLines,
};
