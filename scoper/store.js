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
const { vecDist } = require('./features');

const TAU_ADAPT = 0.22; // within this of an existing prototype of the type -> adapt (don't spawn)
const TAU_TYPE = 0.50;  // nearest prototype beyond this -> not confident (caller falls back)
const TAU_GUARD = 0.25; // a negative of the winning type within this -> guard fires (suppress)

const emptyStore = () => ({ version: 1, types: {}, corrections: [] });
const loadStore = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return emptyStore(); } };
const saveStore = (p, s) => fs.writeFileSync(p, JSON.stringify(s, null, 2));

function ensureType(store, type) {
  if (!store.types[type]) store.types[type] = { prototypes: [], negatives: [], provenance: [] };
  return store.types[type];
}

// nearest prototype across all types, respecting per-type negative guards.
function typeOf(store, vec) {
  let best = null;
  for (const [type, t] of Object.entries(store.types || {})) {
    for (const p of (t.prototypes || [])) { const d = vecDist(vec, p.v); if (!best || d < best.d) best = { type, d }; }
  }
  if (!best || best.d > TAU_TYPE) return { type: null, dist: best ? best.d : Infinity };
  for (const n of (store.types[best.type].negatives || [])) {
    if (vecDist(vec, n.v) <= TAU_GUARD) return { type: null, dist: best.d, guardedFrom: best.type };
  }
  return { type: best.type, dist: best.d };
}

function addExemplar(store, type, vec, meta = {}) {
  const t = ensureType(store, type);
  let near = null;
  for (const p of t.prototypes) { const d = vecDist(vec, p.v); if (!near || d < near.d) near = { p, d }; }
  let action;
  if (near && near.d <= TAU_ADAPT) { near.p.n = (near.p.n || 1) + 1; action = 'adapt'; }
  else { t.prototypes.push({ v: vec, n: 1 }); action = 'spawn'; }
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
  const labels = store.corrections || [];
  if (!labels.length) return { acc: 1, n: 0, pos: 0, neg: 0 };
  let ok = 0, pos = 0, neg = 0;
  for (const l of labels) {
    const r = typeOf(store, l.vec);
    if (l.kind === 'neg') { neg++; if (r.type !== l.srcType) ok++; }
    else { pos++; if (r.type === l.type) ok++; }
  }
  return { acc: ok / labels.length, n: labels.length, pos, neg };
}

module.exports = { emptyStore, loadStore, saveStore, typeOf, addExemplar, addNegative, nearNegative, scoreStore, ensureType, TAU_ADAPT, TAU_TYPE, TAU_GUARD };
