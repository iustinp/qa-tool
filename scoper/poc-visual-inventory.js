#!/usr/bin/env node
/*
 * scoper/poc-visual-inventory.js — CLI for the visual block inventory (issue #65).
 * Analyze-only (no scan): build the inventory from existing pears and render the visual + correction UI.
 *   node scoper/poc-visual-inventory.js <pearsDir> [label] [perColumn]
 * For the full scan -> inventory -> visual run, use scoper/scope.js.
 */

const path = require('path');
const { loadPears } = require('./signature');
const { classifyDescriptors } = require('./chrome');
const { buildInventory } = require('./inventory');
const { buildVisual } = require('./visual');

const pearsDir = process.argv[2];
if (!pearsDir) { console.error('usage: node scoper/poc-visual-inventory.js <pearsDir> [label] [perColumn]'); process.exit(1); }
const label = process.argv[3] || path.basename(pearsDir);
const perCol = parseInt(process.argv[4], 10) || 16;

const pears = loadPears(pearsDir);
if (!pears.length) { console.error(`no pears under ${pearsDir}`); process.exit(1); }
const { keyBucket } = classifyDescriptors(pears);
const inv = buildInventory(pears, keyBucket);

buildVisual(inv, { label, perCol, pages: pears.length }).then((r) => {
  console.log(`\nvisual inventory -> ${path.join(r.outDir, 'index.html')}`);
  console.log(`  ${r.cols} block types · ${r.cropOk} instance crops · ${pears.length} pages\n`);
}).catch((e) => { console.error(e); process.exit(1); });
