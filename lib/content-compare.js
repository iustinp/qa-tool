/**
 * content-compare — the content axis across capture profiles.
 *
 * For each profile present on both source and target, audit the source's visible
 * text union against the target's (per-profile comparison). Then roll the misses
 * up across profiles into two buckets that a reviewer needs to tell apart:
 *
 *   - missing-entirely  — the copy isn't on the target under ANY profile (a real
 *                         migration defect: content was dropped).
 *   - viewport-shifted  — missing under the profile that showed it on the source,
 *                         but present on the target under a different profile
 *                         (usually acceptable: responsive behavior differs, the
 *                         content is still there somewhere).
 *
 * AI-free: this is pure text matching (see text-audit.js). Single-profile input
 * degrades cleanly — every miss is "missing-entirely" since there's no other
 * profile to have shifted to.
 */

const { auditVisibleText } = require('./text-audit');

/** Union of visibleTextUnion across every profile of a capture. */
function unionAllProfiles(profilesObj) {
  const set = new Set();
  for (const p of Object.values(profilesObj || {})) {
    for (const line of p.visibleTextUnion || []) set.add(line);
  }
  return Array.from(set);
}

/**
 * @param {object} sourceCapture PageCapture for the source page
 * @param {object} targetCapture PageCapture for the target page
 * @param {object} [opts] passed through to auditVisibleText (match thresholds)
 */
function compareContentAcrossProfiles(sourceCapture, targetCapture, opts = {}) {
  const srcProfiles = sourceCapture.profiles || {};
  const tgtProfiles = targetCapture.profiles || {};
  const shared = Object.keys(srcProfiles).filter((n) => tgtProfiles[n]);
  const sourceOnly = Object.keys(srcProfiles).filter((n) => !tgtProfiles[n]);
  const targetAllUnion = unionAllProfiles(tgtProfiles);

  const audits = {};
  for (const name of shared) {
    audits[name] = auditVisibleText(
      srcProfiles[name].visibleTextUnion,
      tgtProfiles[name].visibleTextUnion,
      opts
    );
  }

  // Roll misses up across profiles, deduped by normalized line.
  const missingEntirely = [];
  const viewportShifted = [];
  const seen = new Set();
  for (const name of shared) {
    for (const m of audits[name].missingLines) {
      if (seen.has(m.normalizedLine)) continue;
      seen.add(m.normalizedLine);
      const anywhere = auditVisibleText([m.sourceLine], targetAllUnion, opts);
      const entry = {
        sourceLine: m.sourceLine,
        normalizedLine: m.normalizedLine,
        missingUnderProfile: name,
      };
      if (anywhere.missingLineCount === 0) viewportShifted.push(entry);
      else missingEntirely.push(entry);
    }
  }

  const perProfile = {};
  for (const name of shared) {
    const a = audits[name];
    perProfile[name] = {
      status: a.status,
      coverage: a.coverage,
      sourceLineCount: a.sourceLineCount,
      targetLineCount: a.targetLineCount,
      matchedLineCount: a.matchedLineCount,
      missingLineCount: a.missingLineCount,
    };
  }

  return {
    profiles: shared,
    sourceOnlyProfiles: sourceOnly,
    perProfile,
    rollup: {
      status: missingEntirely.length ? 'discrepancies' : 'ok',
      missingEntirelyCount: missingEntirely.length,
      viewportShiftedCount: viewportShifted.length,
      missingEntirely,
      viewportShifted,
    },
  };
}

module.exports = {
  compareContentAcrossProfiles,
  unionAllProfiles,
};
