#!/usr/bin/env node
/*
 * scoper/poc-inventory.js — the scoping deliverable on a whole corpus.
 *   node scoper/poc-inventory.js <pearsDir> [outDir]
 * Prints the distinct block types + page/instance counts; writes inventory.json.
 */
const fs = require('fs');
const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { buildInventory } = require('./inventory');

const pearsDir = process.argv[2];
if (!pearsDir) { console.error('usage: node scoper/poc-inventory.js <pearsDir> [outDir]'); process.exit(1); }
const outDir = process.argv[3] || process.cwd();

const pears = loadPears(pearsDir);
if (!pears.length) { console.error(`no pears under ${pearsDir}`); process.exit(1); }
const { keyBucket } = classifyDescriptors(pears);
const storePath = process.env.SCOPER_STORE || path.join(__dirname, 'store.json');
const store = fs.existsSync(storePath) ? require('./store').loadStore(storePath) : null;
const inv = buildInventory(pears, keyBucket, { store });

console.log(`\n${pears.length} pages · ${inv.length} distinct block types\n`);
console.log('   pp  inst  subtype                    signature');
console.log('   --  ----  -------                    ---------');
for (const b of inv) {
  console.log(`  ${String(b.pages).padStart(3)} ${String(b.instances).padStart(5)}  ${b.subtype.padEnd(24)} ${b.signature.slice(0, 62)}`);
}
// rollup by subtype family (the effort estimate)
const roll = new Map();
for (const b of inv) roll.set(b.subtype, (roll.get(b.subtype) || 0) + 1);
console.log('\n  by subtype:');
for (const [k, v] of [...roll.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(2)}  ${k}`);

fs.writeFileSync(path.join(outDir, 'inventory.json'), JSON.stringify({ pearsDir, pages: pears.length, blocks: inv }, null, 2));
console.log(`\n-> ${path.join(outDir, 'inventory.json')}\n`);
