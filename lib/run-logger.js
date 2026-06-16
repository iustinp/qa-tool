/**
 * Per-run debug logging to a single JSON Lines file under the output directory.
 * Not written to stdout — keeps verbose diagnostics out of AI/capture context unless you open the file.
 */

const fs = require('fs');
const path = require('path');

const RUN_LOG_NAME = 'run-debug.log';
const MAX_STRING = 8000;
const MAX_DEPTH = 12;

function sanitize(val, depth = 0) {
  if (depth > MAX_DEPTH) return '[MaxDepth]';
  if (val == null) return val;
  if (typeof val === 'string') {
    return val.length > MAX_STRING
      ? `${val.slice(0, MAX_STRING)}…(+${val.length - MAX_STRING} chars)`
      : val;
  }
  if (typeof val === 'number' || typeof val === 'boolean') return val;
  if (typeof val === 'bigint') return String(val);
  if (Array.isArray(val)) return val.map((v) => sanitize(v, depth + 1));
  if (typeof val === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(val)) {
      out[k] = sanitize(v, depth + 1);
    }
    return out;
  }
  return String(val);
}

/**
 * @param {string} runRootDir - e.g. output folder for this CLI invocation
 * @returns {{ path: string, event: Function, flush: Function }}
 */
function createRunLogger(runRootDir) {
  const logPath = path.join(runRootDir, RUN_LOG_NAME);
  /** @type {Promise<void>} */
  let chain = Promise.resolve();

  fs.mkdirSync(runRootDir, { recursive: true });

  function enqueue(record) {
    const line = `${JSON.stringify(record)}\n`;
    chain = chain.then(() => fs.promises.appendFile(logPath, line, 'utf8'));
    return chain;
  }

  enqueue({
    ts: new Date().toISOString(),
    event: 'log_open',
    data: {
      tool: 'page-pair-diff',
      node: process.version,
      logFile: RUN_LOG_NAME,
    },
  });

  return {
    /** Absolute path to run-debug.log */
    path: logPath,

    /**
     * @param {string | null} slug - pair slug, or null for run-level rows
     * @param {string} event
     * @param {Record<string, unknown>} [data]
     */
    event(slug, event, data = {}) {
      return enqueue({
        ts: new Date().toISOString(),
        slug,
        event,
        data: sanitize(data),
      });
    },

    /** Wait until all pending writes finish */
    flush() {
      return chain;
    },
  };
}

module.exports = {
  createRunLogger,
  RUN_LOG_NAME,
  sanitize,
};
