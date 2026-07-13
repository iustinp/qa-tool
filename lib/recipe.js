/**
 * Recipe — the per-site config that makes migration QA tractable on an arbitrary
 * source platform. It carries the site-specific knowledge that heuristics can't
 * reliably infer: what to ignore (cookie banners, chat widgets), what to mask in
 * visual diffs (autoplaying carousels, timestamps), how to normalize text
 * (rebrands, volatile formats), which profiles to run, and interaction hints.
 *
 * Every configurable field can carry **provenance** (`ai-scout | human` + a
 * confidence and a `reviewed` flag) so an AI-scouted recipe (Phase 4) stays
 * transparent and a human can override any value without it being clobbered on
 * re-scout.
 *
 * Format is YAML (comments survive, humans edit it by hand). This module loads,
 * validates, and applies a recipe; the comparators/capture consume its helpers.
 */

const fs = require('fs');
const YAML = require('yaml');

/** A recipe with everything empty — the zero-config default (current behavior). */
const DEFAULT_RECIPE = {
  site: { sourceOrigin: null, targetOrigin: null },
  profiles: ['desktop'],
  ignore: [], // [{ selector, reason }] — excluded from ALL comparison
  mask: [], //   [{ selector, reason }] — excluded from VISUAL diff only
  normalize: [], // [{ from, to } | { ignorePattern, flags }] — text rewrites
  interaction: { denylist: [], hints: [] }, // hints: [{ selector, action }]
  knownDiffs: [], // [{ source, target, accept }]
  provenance: {}, // { "<fieldPath>": { by, confidence, reviewed } }
};

const KNOWN_PROFILES = ['desktop', 'mobile', 'tablet'];

/** Deep-merge a partial recipe over the defaults (arrays/objects replaced, not concatenated). */
function withDefaults(partial) {
  const p = partial && typeof partial === 'object' ? partial : {};
  return {
    site: { ...DEFAULT_RECIPE.site, ...(p.site || {}) },
    profiles: Array.isArray(p.profiles) && p.profiles.length ? p.profiles : ['desktop'],
    ignore: Array.isArray(p.ignore) ? p.ignore : [],
    mask: Array.isArray(p.mask) ? p.mask : [],
    normalize: Array.isArray(p.normalize) ? p.normalize : [],
    interaction: {
      denylist: Array.isArray(p.interaction?.denylist) ? p.interaction.denylist : [],
      hints: Array.isArray(p.interaction?.hints) ? p.interaction.hints : [],
    },
    knownDiffs: Array.isArray(p.knownDiffs) ? p.knownDiffs : [],
    provenance: p.provenance && typeof p.provenance === 'object' ? p.provenance : {},
  };
}

/**
 * Validate a recipe. Returns collected problems rather than throwing so callers
 * can decide whether to warn or abort. `errors` are structural; `warnings` are
 * recoverable (unknown profile, precompiled regex issues, …).
 * @returns {{ errors: string[], warnings: string[] }}
 */
function validateRecipe(recipe) {
  const errors = [];
  const warnings = [];

  for (const p of recipe.profiles) {
    if (!KNOWN_PROFILES.includes(p)) {
      warnings.push(`Unknown profile "${p}" (known: ${KNOWN_PROFILES.join(', ')})`);
    }
  }
  recipe.ignore.forEach((r, i) => {
    if (!r || typeof r.selector !== 'string' || !r.selector.trim()) {
      errors.push(`ignore[${i}] needs a non-empty "selector"`);
    }
  });
  recipe.mask.forEach((r, i) => {
    if (!r || typeof r.selector !== 'string' || !r.selector.trim()) {
      errors.push(`mask[${i}] needs a non-empty "selector"`);
    }
  });
  recipe.normalize.forEach((r, i) => {
    if (!r || typeof r !== 'object') {
      errors.push(`normalize[${i}] must be an object`);
      return;
    }
    const isReplace = typeof r.from === 'string';
    const isIgnore = typeof r.ignorePattern === 'string';
    if (!isReplace && !isIgnore) {
      errors.push(`normalize[${i}] needs either "from"/"to" or "ignorePattern"`);
    }
    if (isIgnore) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(r.ignorePattern, r.flags || 'gi');
      } catch (e) {
        errors.push(`normalize[${i}].ignorePattern is not a valid regex: ${e.message}`);
      }
    }
  });
  recipe.interaction.hints.forEach((h, i) => {
    if (!h || typeof h.selector !== 'string' || !h.selector.trim()) {
      errors.push(`interaction.hints[${i}] needs a "selector"`);
    }
  });

  return { errors, warnings };
}

/**
 * Load + validate a recipe from a YAML (or JSON) file.
 * @param {string} filePath
 * @param {{ strict?: boolean }} [opts] strict → throw on validation errors
 * @returns {{ recipe: object, errors: string[], warnings: string[] }}
 */
function loadRecipe(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = YAML.parse(raw); // YAML is a JSON superset, so this also parses JSON
  } catch (e) {
    throw new Error(`Failed to parse recipe ${filePath}: ${e.message}`);
  }
  const recipe = withDefaults(parsed);
  const { errors, warnings } = validateRecipe(recipe);
  if (errors.length && opts.strict !== false) {
    throw new Error(`Invalid recipe ${filePath}:\n  - ${errors.join('\n  - ')}`);
  }
  return { recipe, errors, warnings };
}

/** Compile normalize rules once (regex construction is not free per line). */
function compileNormalizers(recipe) {
  const compiled = [];
  for (const r of recipe.normalize || []) {
    if (typeof r.from === 'string') {
      const re = new RegExp(r.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      compiled.push({ re, to: typeof r.to === 'string' ? r.to : '' });
    } else if (typeof r.ignorePattern === 'string') {
      compiled.push({ re: new RegExp(r.ignorePattern, r.flags || 'gi'), to: '' });
    }
  }
  return compiled;
}

/**
 * Apply the recipe's normalize rules to a single text line. Rewrites (`from`→`to`)
 * and volatile-content removals (`ignorePattern`) run in order; whitespace is
 * collapsed at the end. With no rules this is (aside from trim) a no-op.
 * @param {Array} normalizers output of compileNormalizers
 */
function applyNormalizers(normalizers, line) {
  let s = String(line ?? '');
  for (const n of normalizers) s = s.replace(n.re, n.to);
  return s.replace(/\s+/g, ' ').trim();
}

/** @returns {boolean} whether a selector is on the interaction denylist */
function isInteractionDenied(recipe, selector) {
  return (recipe.interaction?.denylist || []).includes(selector);
}

/**
 * Provenance for a field path (e.g. "ignore[0]"). Unknown paths default to
 * human-authored so hand-written recipes are treated as authoritative.
 */
function getProvenance(recipe, fieldPath) {
  return recipe.provenance?.[fieldPath] || { by: 'human', confidence: 1, reviewed: true };
}

module.exports = {
  DEFAULT_RECIPE,
  KNOWN_PROFILES,
  withDefaults,
  validateRecipe,
  loadRecipe,
  compileNormalizers,
  applyNormalizers,
  isInteractionDenied,
  getProvenance,
};
