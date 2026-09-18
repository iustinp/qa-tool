/*
 * scoper/store.js — the learned block-type store (issue #65, Step 2), fully deterministic.
 *
 * A block TYPE = a SET of prototype vectors (multi-prototype, so dissimilar-but-same-type variants
 * coexist without averaging into mush) + a set of NEGATIVE vectors (context guards: "a thing like
 * this is NOT a standalone X" — from ⧉ fragment corrections). Typing = nearest prototype across all
 * types, suppressed if a negative of that type is close (the guard). Learning = add exemplars
 * (adapt if within TAU_ADAPT of an existing prototype of that type, else spawn a new prototype).
 * No AI: adapt-vs-spawn is a distance test; a "Because…" is stored as provenance, not auto-featurised.
 */

const fs = require('fs');
const { vecDist, FKEYS } = require('./features');

const TAU_ADAPT = 0.22; // within this of an existing prototype of the type -> adapt (don't spawn)
const TAU_TYPE = 0.50;  // DEFAULT per-type acceptance radius (cold start; retune() overrides from data)
const TAU_GUARD = 0.25; // a negative of the winning type within this -> guard fires (suppress)
const RADIUS_CAP = 1.20;    // a learned per-type radius never exceeds this (bounds sparse-data widening)
const MIN_POS_TO_TUNE = 2;  // widen a type's radius past TAU_TYPE only once it has >=2 positive corrections

const emptyStore = () => ({ version: 1, types: {}, corrections: [] });
const loadStore = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyStore(); } };
const saveStore = (p, s) => fs.writeFileSync(p, JSON.stringify(s, null, 2));

function ensureType(store, type) {
  if (!store.types[type]) store.types[type] = { prototypes: [], negatives: [], provenance: [] };
  return store.types[type];
}

// A type's acceptance radius: the value retune() fit from the corrections, else the cold default.
function radiusOf(store, type) {
  const t = store.types && store.types[type];
  return t && typeof t.radius === 'number' ? t.radius : TAU_TYPE;
}
function minDistToType(store, vec, type) {
  const t = store.types && store.types[type];
  if (!t || !t.prototypes || !t.prototypes.length) return Infinity;
  let m = Infinity;
  for (const p of t.prototypes) { const d = vecDist(vec, p.v); if (d < m) m = d; }
  return m;
}

// Classify a vector: nearest prototype among the types whose learned radius admits it, then apply
// that type's negative guards. `radii` overrides the stored per-type radii (retune uses this to try
// candidate boundaries); pass null to use the store's own learned radii.
function classifyWith(store, vec, radii) {
  let best = null;
  for (const type of Object.keys(store.types || {})) {
    const d = minDistToType(store, vec, type);
    const r = radii ? (radii[type] != null ? radii[type] : TAU_TYPE) : radiusOf(store, type);
    if (d <= r && (!best || d < best.d)) best = { type, d };
  }
  if (!best) return { type: null, dist: Infinity };
  for (const n of (store.types[best.type].negatives || [])) {
    if (vecDist(vec, n.v) <= TAU_GUARD) return { type: null, dist: best.d, guardedFrom: best.type };
  }
  return { type: best.type, dist: best.d };
}

// nearest admissible prototype, respecting per-type learned radii + negative guards.
function typeOf(store, vec) { return classifyWith(store, vec, null); }

function addExemplar(store, type, vec, meta = {}) {
  const t = ensureType(store, type);
  let near = null;
  for (const p of t.prototypes) { const d = vecDist(vec, p.v); if (!near || d < near.d) near = { p, d }; }
  let action;
  if (near && near.d <= TAU_ADAPT) {
    // Adapt: move the prototype toward the new example (incremental mean) so repeated corrections
    // recenter it on the true cluster centroid instead of just bumping a counter.
    const nn = (near.p.n || 1) + 1;
    for (const k of FKEYS) near.p.v[k] = near.p.v[k] + ((vec[k] || 0) - near.p.v[k]) / nn;
    near.p.n = nn;
    action = 'adapt';
  } else {
    t.prototypes.push({ v: { ...vec }, n: 1 }); action = 'spawn';
  }
  t.provenance.push({ ...meta, action });
  return action;
}

function addNegative(store, type, vec, meta = {}) {
  const t = ensureType(store, type);
  t.negatives.push({ v: vec });
  t.provenance.push({ ...meta, negative: true });
}

// Is this vector near a NEGATIVE guard of any type? i.e. the store has been told "a thing like this
// on its own is a false positive / fragment." Returns that type (the over-fired one) or null. This
// is the trigger the band-merge uses to decide which bands to try re-joining.
function nearNegative(store, vec) {
  for (const [type, t] of Object.entries(store.types || {})) {
    for (const n of (t.negatives || [])) if (vecDist(vec, n.v) <= TAU_GUARD) return type;
  }
  return null;
}

// regression guard: re-type every accumulated labeled correction and report accuracy.
// pos label correct when typeOf === its type; neg label correct when typeOf !== its guarded type.
function scoreStore(store) {
  const labels = (store.corrections || []).filter((l) => l.kind !== 'split'); // 'split' records are inert until Phase 2 (DOM-aware cutting)
  if (!labels.length) return { acc: 1, n: 0, pos: 0, neg: 0 };
  let ok = 0, pos = 0, neg = 0;
  for (const l of labels) {
    const r = typeOf(store, l.vec);
    if (l.kind === 'neg') { neg++; if (r.type !== l.srcType) ok++; }
    else { pos++; if (r.type === l.type) ok++; }
  }
  return { acc: ok / labels.length, n: labels.length, pos, neg };
}

// retune — the self-tuning step. The accumulated corrections ARE the calibration set: fit each
// type's acceptance radius to maximize accuracy over ALL of them, so the boundary is derived from
// experience, not a hand-picked constant.
//
// The fit is scored LEAVE-ONE-OUT over the correction set: a correction is classified by its distance
// to OTHER corrections (never itself), so the radius has to reflect the real SPREAD of a class — how
// far apart same-type corrections sit — which is what lets an unseen instance in that spread be caught
// at scope time. (Fitting to each example's distance to its own prototype would give ~0 and never
// generalize.) Because every trial is scored against the whole set, a new correction can only move a
// boundary in a way that doesn't regress the old ones; a genuine conflict shows up as lower accuracy
// instead of silently breaking things. A type stays at the cold default until it has
// >=MIN_POS_TO_TUNE positives (one example can't define a spread); no radius exceeds RADIUS_CAP.
function retune(store) {
  const labels = (store.corrections || []).filter((l) => l.kind !== 'split'); // ignore inert split records (Phase 2)
  const types = Object.keys(store.types || {});
  const radii = {};
  for (const T of types) radii[T] = radiusOf(store, T);

  const isPos = (l, T) => l.kind !== 'neg' && l.type === T;
  // dLOO[i][T] = distance from correction i to the NEAREST OTHER correction that is a positive of T.
  const dLOO = labels.map((li, i) => {
    const row = {};
    for (const T of types) {
      let m = Infinity;
      labels.forEach((lj, j) => { if (j !== i && isPos(lj, T)) { const d = vecDist(li.vec, lj.vec); if (d < m) m = d; } });
      row[T] = m;
    }
    return row;
  });
  const guarded = (vec, T) => (store.types[T].negatives || []).some((n) => vecDist(vec, n.v) <= TAU_GUARD);

  const score = (rd) => {
    if (!labels.length) return 1;
    let ok = 0;
    labels.forEach((l, i) => {
      let best = null;
      for (const T of types) { const d = dLOO[i][T]; if (d <= (rd[T] != null ? rd[T] : TAU_TYPE) && (!best || d < best.d)) best = { T, d }; }
      const pred = best && !guarded(l.vec, best.T) ? best.T : null;
      if (l.kind === 'neg') { if (pred !== l.srcType) ok += 1; }
      else if (pred === l.type) ok += 1;
    });
    return ok / labels.length;
  };

  const before = score(radii);
  if (labels.length) {
    for (let pass = 0; pass < 4; pass += 1) {
      let changed = false;
      for (const T of types) {
        const posCount = labels.filter((l) => isPos(l, T)).length;
        if (posCount < MIN_POS_TO_TUNE) continue; // sparse: keep the cold default, don't widen from one example
        // candidate radii: cold default + every same-type LOO neighbour distance (the class spread).
        const cuts = new Set([TAU_TYPE, radii[T]]);
        labels.forEach((l, i) => { if (isPos(l, T) && Number.isFinite(dLOO[i][T])) cuts.add(dLOO[i][T]); });
        let bestR = radii[T]; let bestA = score(radii);
        for (const c of cuts) {
          if (c <= 0 || c > RADIUS_CAP) continue;
          const a = score({ ...radii, [T]: c });
          // largest radius that keeps max accuracy -> generalize as far as the data safely allows.
          if (a > bestA + 1e-9 || (Math.abs(a - bestA) < 1e-9 && c > bestR)) { bestA = a; bestR = c; }
        }
        if (bestR !== radii[T]) { radii[T] = bestR; changed = true; }
      }
      if (!changed) break;
    }
  }
  for (const T of types) store.types[T].radius = radii[T];
  return { before, after: score(radii), radii };
}

module.exports = { emptyStore, loadStore, saveStore, typeOf, classifyWith, radiusOf, addExemplar, addNegative, nearNegative, scoreStore, retune, ensureType, TAU_ADAPT, TAU_TYPE, TAU_GUARD, RADIUS_CAP, MIN_POS_TO_TUNE };
