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
const TAU_ADMIT = 0.35; // a band the HEURISTICS reject is admitted only within this (tight) of a learned prototype
const RADIUS_CAP = 1.20;    // a learned per-type radius never exceeds this (bounds sparse-data widening)
const MIN_POS_TO_TUNE = 2;  // widen a type's radius past TAU_TYPE only once it has >=2 positive corrections
const TAU_ADMIT_CAP = 0.50; // the learned admission threshold never widens past the cold type radius

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
  // kind 'fragment' = an over-cut piece (drives the merge); 'default' = "not a block at all" (a ✕ Not
  // a block correction — suppresses admission but must NOT trigger a merge). Both suppress typing.
  t.negatives.push({ v: vec, kind: meta.kind || 'fragment' });
  t.provenance.push({ ...meta, negative: true });
}

// Is this vector near a NEGATIVE guard of any type? i.e. the store has been told "a thing like this
// on its own is a false positive / fragment." Returns that type (the over-fired one) or null. This
// is the trigger the band-merge uses to decide which bands to try re-joining.
function nearNegative(store, vec) {
  for (const [type, t] of Object.entries(store.types || {})) {
    for (const n of (t.negatives || [])) if ((n.kind || 'fragment') === 'fragment' && vecDist(vec, n.v) <= TAU_GUARD) return type;
  }
  return null; // only FRAGMENT guards trigger the merge; 'default' guards suppress typing but not merge
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

// tuneAdmit — the self-tuning of the LEARNED-ADMISSION threshold (band-class.js's learned-admit path),
// the counterpart to retune() for admission. TAU_ADMIT was the last hand-picked constant deciding which
// heuristically-rejected bands a learned prototype may pull back in; here it is FIT from the corrections
// instead. The calibration set: positive exemplars (a real block SHOULD be admitted) vs 'default'-kind
// negatives (a ✕ not-a-block SHOULD stay out). We sweep candidate thresholds and pick the one maximising
// F1 = 2·TP / (2·TP + FP + FN), scored LEAVE-ONE-OUT (each vec's distance is to the nearest OTHER positive
// correction, never itself, so a prototype it seeded can't give a trivially tight fit). Ties break toward
// the TIGHTER threshold — admission errs on the side of precision. It only moves with real signal on both
// sides (>=MIN_POS_TO_TUNE positives AND >=1 default negative); otherwise the conservative default holds,
// so a store with no not-a-block feedback can never widen admission to flood prose in. Bounded by
// TAU_ADMIT_CAP. Works identically for human and oracle (align.js) corrections.
function tuneAdmit(store) {
  const cur = typeof store.tauAdmit === 'number' ? store.tauAdmit : TAU_ADMIT;
  const labels = (store.corrections || []).filter((l) => l.kind !== 'split');
  const pos = labels.filter((l) => l.kind !== 'neg');
  const rej = labels.filter((l) => l.kind === 'neg' && l.reject === 'default');
  if (pos.length < MIN_POS_TO_TUNE || !rej.length) return { tau: cur, tuned: false, pos: pos.length, rej: rej.length };

  // distance from a vec to the nearest OTHER positive correction (leave-one-out; selfIdx<0 = not a positive)
  const dNear = (vec, selfIdx) => {
    let m = Infinity;
    pos.forEach((p, j) => { if (j === selfIdx) return; const d = vecDist(vec, p.vec); if (d < m) m = d; });
    return m;
  };
  const dPos = pos.map((p, i) => dNear(p.vec, i));
  const dRej = rej.map((r) => dNear(r.vec, -1));
  const f1 = (tau) => {
    let tp = 0, fp = 0, fn = 0;
    dPos.forEach((d) => { if (d <= tau) tp++; else fn++; });
    dRej.forEach((d) => { if (d <= tau) fp++; });
    const den = 2 * tp + fp + fn; return den ? (2 * tp) / den : 0;
  };
  const cuts = new Set([TAU_ADMIT, cur]);
  dPos.forEach((d) => { if (Number.isFinite(d)) cuts.add(d); });
  dRej.forEach((d) => { if (Number.isFinite(d)) cuts.add(d); });
  let best = { tau: cur, f: f1(cur) };
  for (const c of cuts) {
    if (c <= 0 || c > TAU_ADMIT_CAP) continue;
    const f = f1(c);
    if (f > best.f + 1e-9 || (Math.abs(f - best.f) < 1e-9 && c < best.tau)) best = { tau: c, f };
  }
  store.tauAdmit = best.tau;
  return { tau: best.tau, f1: best.f, tuned: best.tau !== cur, pos: pos.length, rej: rej.length };
}

module.exports = { emptyStore, loadStore, saveStore, typeOf, classifyWith, radiusOf, addExemplar, addNegative, nearNegative, scoreStore, retune, tuneAdmit, ensureType, TAU_ADAPT, TAU_TYPE, TAU_GUARD, TAU_ADMIT, TAU_ADMIT_CAP, RADIUS_CAP, MIN_POS_TO_TUNE };
