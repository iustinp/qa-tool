/**
 * pixel-diff — block-quantized visual change detection for the crawl (issue #62).
 *
 * Ground-truth "did the user-visible page change?" from rendered pixels, instead
 * of approximating it from DOM styles (clip/opacity/occlusion). Everything is
 * BLOCK-level, not per-pixel: a frame is a grid of BxB blocks, and a block counts
 * as "changed" only when enough pixels in it differ. This quantization is what
 * tames anti-aliasing / sub-pixel non-determinism (measured ~8% raw earlier), and
 * it makes connected-component clustering into tight regions cheap.
 *
 * Page-agnostic: callers pass PNG buffers (page.screenshot). Pairs with OCR of the
 * changed regions (lib/text-geometry-ocr) for the "what appeared" content — see
 * the #62 plan. Complements the text-set signal; does not replace it.
 */

const sharp = require('sharp');

/**
 * Decode a PNG buffer to a raw RGBA frame, optionally DOWNSCALED (opts.scale in
 * (0,1)) for cheap detection — detection is coarse, so a shrunk frame diffs ~1/scale²
 * faster; OCR still crops the FULL-RES image (caller maps region bboxes back by
 * 1/scale). The scale rides on the returned frame so after/volatile frames match.
 */
async function frame(pngBuffer, opts = {}) {
  const scale = opts.scale && opts.scale > 0 && opts.scale < 1 ? opts.scale : 1;
  let img = sharp(pngBuffer).ensureAlpha();
  if (scale < 1) {
    const meta = await sharp(pngBuffer).metadata();
    img = img.resize({ width: Math.max(1, Math.round((meta.width || 0) * scale)), fastShrinkOnLoad: true });
  }
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, ch: info.channels, scale };
}

/**
 * Block-change map between two frames. A block is "changed" when the fraction of
 * its pixels whose summed RGB delta exceeds `pxThr` is at least `minFrac`. Frames
 * of differing size are compared over their COMMON region (the crawl treats a big
 * height delta — e.g. an accordion growing the page — as its own change signal).
 * @returns {{ map:Uint8Array, cols:number, rows:number, block:number, w:number, h:number, heightDelta:number, widthDelta:number }}
 */
function blockDiff(a, b, opts = {}) {
  const block = opts.block ?? 8;
  const pxThr = opts.pxThr ?? 40;
  const minFrac = opts.minFrac ?? 0.12;
  const w = Math.min(a.w, b.w);
  const h = Math.min(a.h, b.h);
  const cols = Math.ceil(w / block);
  const rows = Math.ceil(h / block);
  const map = new Uint8Array(cols * rows);
  const minCount = Math.max(1, Math.floor(block * block * minFrac));
  for (let by = 0; by < rows; by++) {
    const y0 = by * block;
    const y1 = Math.min(y0 + block, h);
    for (let bx = 0; bx < cols; bx++) {
      const x0 = bx * block;
      const x1 = Math.min(x0 + block, w);
      let cnt = 0;
      for (let y = y0; y < y1 && cnt < minCount; y++) {
        const ra = (y * a.w + x0) * a.ch;
        const rb = (y * b.w + x0) * b.ch;
        for (let x = x0, pa = ra, pb = rb; x < x1; x++, pa += a.ch, pb += b.ch) {
          const d = Math.abs(a.data[pa] - b.data[pb]) + Math.abs(a.data[pa + 1] - b.data[pb + 1]) + Math.abs(a.data[pa + 2] - b.data[pb + 2]);
          if (d > pxThr && ++cnt >= minCount) break;
        }
      }
      if (cnt >= minCount) map[by * cols + bx] = 1;
    }
  }
  return { map, cols, rows, block, w, h, heightDelta: Math.abs(a.h - b.h), widthDelta: Math.abs(a.w - b.w) };
}

/** OR two block maps of the same grid (in place into a fresh map). */
function orMap(m1, m2) {
  const out = new Uint8Array(m1.length);
  for (let i = 0; i < m1.length; i++) out[i] = m1[i] || m2[i] ? 1 : 0;
  return out;
}

/**
 * Volatile block map: blocks that change on their OWN across a few static frames
 * (clocks, tickers, carousels, video). OR of consecutive-frame block diffs. The
 * crawl subtracts this so only click-caused change registers.
 */
function volatileFromFrames(frames, opts = {}) {
  let vol = null;
  for (let i = 1; i < frames.length; i++) {
    const d = blockDiff(frames[i - 1], frames[i], opts).map;
    vol = vol ? orMap(vol, d) : d;
  }
  return vol || new Uint8Array(0);
}

/**
 * Extract the sub-window of a block `mask` that lines up with a VIEWPORT diff:
 * same width (→ same columns), rows shifted down by `rowOffset` (= the capture
 * scroll, in blocks). Used so a full-page, scroll-0 volatile mask can be applied
 * to a per-click viewport before/after diff taken at an arbitrary scroll (#62 D).
 * Rows outside the source mask read as 0 (not volatile).
 */
function windowMask(mask, cols, rowOffset, rows) {
  if (!mask || !cols) return null;
  const out = new Uint8Array(cols * rows);
  const totalRows = Math.floor(mask.length / cols);
  for (let r = 0; r < rows; r++) {
    const src = r + rowOffset;
    if (src < 0 || src >= totalRows) continue;
    const so = src * cols;
    const oo = r * cols;
    for (let c = 0; c < cols; c++) out[oo + c] = mask[so + c] || 0;
  }
  return out;
}

/** Count set blocks in a map, ignoring any that are set in `mask` (volatile). */
function countChanged(map, mask) {
  let n = 0;
  for (let i = 0; i < map.length; i++) if (map[i] && !(mask && mask[i])) n += 1;
  return n;
}

/**
 * Connected-component clustering (4-neighbour) of changed blocks (minus volatile)
 * into regions, each returned as a PIXEL bbox {left,top,width,height}. Regions
 * smaller than `minBlocks` are dropped as noise. This gives tight bands to OCR
 * instead of one coarse bounding box over all changes.
 */
function regions(map, cols, rows, block, opts = {}) {
  const mask = opts.mask || null;
  const minBlocks = opts.minBlocks ?? 4;
  const seen = new Uint8Array(cols * rows);
  const out = [];
  const stack = [];
  for (let start = 0; start < map.length; start++) {
    if (!map[start] || seen[start] || (mask && mask[start])) continue;
    // flood fill this component
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let minX = cols;
    let minY = rows;
    let maxX = -1;
    let maxY = -1;
    while (stack.length) {
      const idx = stack.pop();
      const cx = idx % cols;
      const cy = (idx / cols) | 0;
      count += 1;
      if (cx < minX) minX = cx;
      if (cx > maxX) maxX = cx;
      if (cy < minY) minY = cy;
      if (cy > maxY) maxY = cy;
      const neigh = [idx - 1, idx + 1, idx - cols, idx + cols];
      const canL = cx > 0;
      const canR = cx < cols - 1;
      for (let k = 0; k < 4; k++) {
        const ni = neigh[k];
        if (k === 0 && !canL) continue;
        if (k === 1 && !canR) continue;
        if (ni < 0 || ni >= map.length || seen[ni]) continue;
        if (!map[ni] || (mask && mask[ni])) continue;
        seen[ni] = 1;
        stack.push(ni);
      }
    }
    if (count < minBlocks) continue;
    out.push({
      left: minX * block,
      top: minY * block,
      width: (maxX - minX + 1) * block,
      height: (maxY - minY + 1) * block,
      blocks: count,
    });
  }
  // largest first — the primary reveal tends to be the biggest region
  out.sort((p, q) => q.blocks - p.blocks);
  return out;
}

/**
 * High-level: given decoded BEFORE and AFTER frames and a volatile block map,
 * return the click-caused changed-block count and the tight regions. Convenience
 * wrapper the crawl uses per (text-flat) click.
 */
function detect(before, after, volatile, opts = {}) {
  const d = blockDiff(before, after, opts);
  const changedBlocks = countChanged(d.map, volatile);
  const regs = regions(d.map, d.cols, d.rows, d.block, { mask: volatile, minBlocks: opts.minBlocks });
  return { changedBlocks, regions: regs, heightDelta: d.heightDelta, grid: { cols: d.cols, rows: d.rows, block: d.block } };
}

module.exports = { frame, blockDiff, orMap, volatileFromFrames, windowMask, countChanged, regions, detect };
