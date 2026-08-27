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

let totBlock = 0;
for (const p of pears) totBlock += detectPageLattices(p.nodes).filter((L) => L.block).length;
console.log(`\n=== ${pears.length} pages · ${totBlock} BLOCK lattices · ${(totBlock / pears.length).toFixed(1)}/page ===`);

for (const p of pears.slice(0, nSamples)) {
  const lats = detectPageLattices(p.nodes);
  const blocks = lats.filter((L) => L.block).slice(0, 6);
  const prose = lats.filter((L) => !L.block).length;
  console.log(`\n${p.url}   (${prose} prose stacks filtered)`);
  for (const L of blocks) {
    const comp = L.tokens.join('+');
    console.log(`  [BLOCK] ${L.axis.padEnd(2)} count≈${L.count} period ${String(L.period).padStart(4)}px @[${L.bbox.x},${L.bbox.y} ${L.bbox.w}×${L.bbox.h}] :: ${comp}`);
  }
  if (!blocks.length) console.log('  (no block lattice)');
}
console.log('');
