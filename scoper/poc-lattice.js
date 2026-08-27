#!/usr/bin/env node
/*
 * Spike runner for the lattice detector (issue #65). Prints the strongest repeating lattices
 * per sample page — axis, count, period, and the peer's token composition — so we can eyeball
 * whether it cleanly finds "4 cards across / 3 columns / N-row accordion" on real pages.
 *
 *   node scoper/poc-lattice.js <pearsDir> [numSamplePages]
 */

const { loadPears } = require('./signature');
const { detectPageLattices } = require('./lattice');

const runDir = process.argv[2] || 'test-run_grace_20260820231416/pairs';
const nSamples = parseInt(process.argv[3], 10) || 6;
const pears = loadPears(runDir);

let totLat = 0;
for (const p of pears) totLat += detectPageLattices(p.nodes).filter((L) => L.count >= 3).length;
console.log(`\n=== ${pears.length} pages · ${totLat} lattices (count>=3) · ${(totLat / pears.length).toFixed(1)}/page ===`);

for (const p of pears.slice(0, nSamples)) {
  const lats = detectPageLattices(p.nodes).filter((L) => L.count >= 3).slice(0, 5);
  console.log(`\n${p.url}`);
  for (const L of lats) {
    const comp = L.tokens.slice(0, 6).map((t) => `${t.tok}×${t.n}`).join(' ');
    console.log(`  ${L.axis}  count≈${L.count}  period ${L.period}px  @[${L.bbox.x},${L.bbox.y} ${L.bbox.w}×${L.bbox.h}]  :: ${comp}`);
  }
  if (!lats.length) console.log('  (no lattice)');
}
console.log('');
