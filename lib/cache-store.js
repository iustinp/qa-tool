/**
 * cache-store — a persistent, content-addressed cache for expensive results
 * (primarily AI vision calls). At thousands of pages the same header/footer/nav
 * crop recurs across hundreds of pages and across profiles; caching the vision
 * result keyed by a hash of its inputs turns most of those calls into disk reads.
 *
 * Storage is a directory of content-addressed JSON files, sharded by the first
 * two hex chars of the key (avoids one huge directory), written atomically
 * (temp + rename) so concurrent workers don't corrupt entries. No DB dependency;
 * the cache persists across runs so incremental re-runs (Phase 5) are cheap.
 *
 * Phase 0 ships the scaffold + hashing + hit/miss stats; Phase 2 wires
 * `getOrCompute` into the vision-call path in claude.js/pair-worker.js.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Content-addressed key for a vision call. Include the images (as Buffers) and
 * the prompt text; bump `version` whenever a prompt changes so stale entries
 * are naturally invalidated (they hash to a different key).
 * @param {{ version?: string, text?: string, images?: Array<Buffer|string> }} inputs
 * @returns {string} hex sha256
 */
function hashInputs({ version = 'v1', text = '', images = [] } = {}) {
  const h = crypto.createHash('sha256');
  h.update(String(version));
  h.update('\u0000');
  h.update(String(text));
  for (const img of images) {
    h.update('\u0000');
    h.update(Buffer.isBuffer(img) ? img : String(img));
  }
  return h.digest('hex');
}

function defaultCacheDir() {
  return process.env.PPD_CACHE_DIR || path.join(process.cwd(), '.ppd-cache');
}

/** Master enable via env (default off) — callers may override per store. */
function isCacheEnabled() {
  const v = process.env.PPD_CACHE;
  return v === '1' || v === 'true';
}

/**
 * @param {object} [options]
 * @param {boolean} [options.enabled=true]
 * @param {string}  [options.dir] cache root (default PPD_CACHE_DIR or ./.ppd-cache)
 * @param {string}  [options.namespace='default'] isolates key spaces (e.g. 'segment', 'match')
 */
function createCacheStore(options = {}) {
  const enabled = options.enabled ?? true;
  const rootDir = options.dir || defaultCacheDir();
  const namespace = options.namespace || 'default';
  const baseDir = path.join(rootDir, namespace);
  const stats = { hits: 0, misses: 0, writes: 0, errors: 0 };

  function pathForKey(key) {
    const shard = key.slice(0, 2) || '00';
    return path.join(baseDir, shard, `${key}.json`);
  }

  /** @returns {*} cached value, or undefined on miss. */
  function get(key) {
    if (!enabled) return undefined;
    const file = pathForKey(key);
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      stats.misses += 1;
      return undefined;
    }
    try {
      const entry = JSON.parse(raw);
      stats.hits += 1;
      return entry.value;
    } catch {
      // Corrupt entry — drop it and treat as a miss.
      stats.errors += 1;
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      stats.misses += 1;
      return undefined;
    }
  }

  function set(key, value, meta = {}) {
    if (!enabled) return;
    const file = pathForKey(key);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const entry = { key, value, meta: { createdAt: new Date().toISOString(), ...meta } };
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(entry));
    fs.renameSync(tmp, file); // atomic publish
    stats.writes += 1;
  }

  /**
   * Return the cached value for `key`, or run `computeFn`, store, and return it.
   * Null/undefined results are not cached (don't memoize failures/empties).
   */
  async function getOrCompute(key, computeFn, meta = {}) {
    const cached = get(key);
    if (cached !== undefined) return cached;
    const value = await computeFn();
    if (value !== undefined && value !== null) {
      try {
        set(key, value, meta);
      } catch {
        stats.errors += 1;
      }
    }
    return value;
  }

  return {
    enabled,
    dir: baseDir,
    namespace,
    get,
    set,
    getOrCompute,
    stats: () => ({ ...stats }),
  };
}

module.exports = {
  createCacheStore,
  hashInputs,
  defaultCacheDir,
  isCacheEnabled,
};
