#!/usr/bin/env node
/**
 * Dev server for the page-pair-diff web UI.
 *
 * The UI talks to this server only over an async, job-shaped HTTP API
 * (submit -> jobId -> poll status -> results) so the same UI fits whichever
 * deployment path wins later (see DEPLOYMENT-ARCHITECTURE.md).
 *
 * Two backend modes, chosen by WEBUI_ENGINE:
 *   - "real" (default): spawns the actual engine (`node index.js --csv ... --out ...`)
 *     in a child process, tracks progress from its stdout, and serves the run folder.
 *   - "stub": fakes runs in-memory on a timer with canned results (no engine, no cost).
 *
 * An in-process queue caps concurrent runs (Chromium is heavy) — the "team server"
 * concurrency knob from the architecture doc. Zero dependencies (Node >= 18).
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');
const sharp = require('sharp'); // already a project dependency (used by the engine)
const YAML = require('yaml'); // already a project dependency (used by lib/recipe.js)

const CLI_PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i >= 0 && process.argv[i + 1] ? Number(process.argv[i + 1]) : null;
})();
const PORT = CLI_PORT || (process.env.WEBUI_PORT ? Number(process.env.WEBUI_PORT) : 4321);
const ENGINE_MODE = (process.env.WEBUI_ENGINE || 'real').toLowerCase(); // "real" | "stub"
const MAX_CONCURRENT = process.env.WEBUI_MAX_CONCURRENT
  ? Math.max(1, Number(process.env.WEBUI_MAX_CONCURRENT))
  : 2;

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLE_RESULTS = path.join(__dirname, 'sample-results');
const RUNS_DIR = path.join(__dirname, 'runs'); // per-job workspace (gitignored)
// Saved site recipes live at the project root (git-tracked, shareable, and
// usable directly by the engine via --recipe).
const RECIPES_DIR = path.join(PROJECT_ROOT, 'recipes');

fs.mkdirSync(RUNS_DIR, { recursive: true });
fs.mkdirSync(RECIPES_DIR, { recursive: true });

// Modes the UI can request; each maps to an engine flag (or none = full run).
const RUN_MODES = {
  full: [],
  'text-only': ['--text-only'],
  'screening-only': ['--screening-only'],
};

// ---- Job store + queue --------------------------------------------------------
/** @type {Map<string, any>} */
const jobs = new Map();
/** @type {string[]} */
const queue = [];
let runningCount = 0;

function hostOf(u) {
  try {
    return new URL(u).host;
  } catch {
    return null;
  }
}

function createJob({
  label, pairs, mode, threads, recipe, ignoreSource, ignoreTarget, clickSource, clickTarget,
}) {
  const id = randomUUID();
  const now = Date.now();
  // A run's site is intrinsic — the source host of its pairs (all pairs normally
  // share one). It's what the runs filter groups by, independent of any recipe.
  const hosts = [...new Set(pairs.map((p) => hostOf(p.source)).filter(Boolean))];
  const job = {
    id,
    label: label || `run-${new Date(now).toISOString().slice(0, 19)}`,
    mode: RUN_MODES[mode] ? mode : 'full',
    threads: Math.min(16, Math.max(1, Number(threads) || 1)),
    recipe: recipe || null, // name of the site recipe it was run with (provenance)
    site: hosts.length === 1 ? hosts[0] : hosts[0] || null, // grouping key
    sites: hosts, // all distinct source hosts (usually one)
    ignoreSource: ignoreSource || [],
    ignoreTarget: ignoreTarget || [],
    clickSource: clickSource || [],
    clickTarget: clickTarget || [],
    status: 'queued',
    stage: 'queued',
    progress: 0,
    pairCount: pairs.length,
    pairs,
    createdAt: now,
    updatedAt: now,
    error: null,
    runDir: path.join(RUNS_DIR, `${id}`),
    logTail: '',
  };
  jobs.set(id, job);
  persistJob(job);
  queue.push(id);
  pump();
  return job;
}

function touch(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
}

// --- Run persistence: survive server restarts ---------------------------------
// Runs are kept in memory for liveness but mirrored to <runDir>/job.json so the
// history (and the Load button) survive a restart. Ephemeral fields (paths, the
// child pid, the log tail) are not stored — they're recomputed on load.
const PERSIST_FIELDS = [
  'id', 'label', 'mode', 'threads', 'recipe', 'site', 'sites',
  'ignoreSource', 'ignoreTarget', 'clickSource', 'clickTarget',
  'status', 'stage', 'progress', 'pairCount', 'pairs',
  'createdAt', 'updatedAt', 'error', 'resultsUrl', 'reportUrl', 'analyzed', 'loadErrors',
];

function persistJob(job) {
  try {
    fs.mkdirSync(job.runDir, { recursive: true });
    const data = {};
    for (const k of PERSIST_FIELDS) if (job[k] !== undefined) data[k] = job[k];
    fs.writeFileSync(path.join(job.runDir, 'job.json'), JSON.stringify(data));
  } catch {
    /* persistence is best-effort — never break a run over it */
  }
}

function loadPersistedJobs() {
  let ids = [];
  try {
    ids = fs.readdirSync(RUNS_DIR);
  } catch {
    return;
  }
  let restored = 0;
  for (const id of ids) {
    const runDir = path.join(RUNS_DIR, id);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(path.join(runDir, 'job.json'), 'utf8'));
    } catch {
      continue; // no metadata (old run, or mid-write) — skip
    }
    const job = {
      ...data,
      runDir,
      outDir: path.join(runDir, 'out'),
      logPath: path.join(runDir, 'engine.log'),
      logTail: '',
    };
    // A run mid-flight when the server stopped can't resume — mark it interrupted.
    if (job.status !== 'done' && job.status !== 'error') {
      Object.assign(job, {
        status: 'error',
        stage: 'interrupted',
        error: 'Interrupted by a server restart.',
      });
    }
    jobs.set(job.id, job);
    restored += 1;
  }
  if (restored) console.log(`[webui] restored ${restored} run(s) from disk`);
}

// Start queued jobs up to the concurrency cap.
function pump() {
  while (runningCount < MAX_CONCURRENT && queue.length) {
    const id = queue.shift();
    const job = jobs.get(id);
    if (!job) continue;
    runningCount += 1;
    const runner = ENGINE_MODE === 'stub' ? runStub : runReal;
    Promise.resolve()
      .then(() => runner(job))
      .catch((err) => touch(job, { status: 'error', stage: 'error', error: String(err) }))
      .finally(() => {
        persistJob(job); // record the terminal state (done/error + analyzed/urls)
        runningCount -= 1;
        pump();
      });
  }
}

// ---- Real engine runner -------------------------------------------------------
function runReal(job) {
  return new Promise((resolve) => {
    fs.mkdirSync(job.runDir, { recursive: true });
    const csvPath = path.join(job.runDir, 'input.csv');
    const csv = ['source,target', ...job.pairs.map((p) => `${p.source},${p.target}`)].join('\n');
    fs.writeFileSync(csvPath, csv);

    const outDir = path.join(job.runDir, 'out');
    const logPath = path.join(job.runDir, 'engine.log');
    const logStream = fs.createWriteStream(logPath);

    const args = ['index.js', '--csv', csvPath, '--out', outDir, '--threads', String(job.threads), ...RUN_MODES[job.mode]];

    // If the run has per-side ignore or click selectors, emit a recipe and pass
    // --recipe. JSON is valid YAML, so we write it without a YAML dependency.
    if (
      job.ignoreSource.length ||
      job.ignoreTarget.length ||
      job.clickSource.length ||
      job.clickTarget.length
    ) {
      const asRules = (list) => list.map((selector) => ({ selector, reason: 'ui' }));
      const recipe = {
        ignoreSource: asRules(job.ignoreSource),
        ignoreTarget: asRules(job.ignoreTarget),
        clickSource: asRules(job.clickSource),
        clickTarget: asRules(job.clickTarget),
      };
      const recipePath = path.join(job.runDir, 'recipe.yaml');
      fs.writeFileSync(recipePath, JSON.stringify(recipe, null, 2));
      args.push('--recipe', recipePath);
    }
    touch(job, { status: 'running', stage: 'starting', progress: 1, outDir, logPath });

    const child = spawn(process.execPath, args, { cwd: PROJECT_ROOT });
    job.pid = child.pid;

    let buf = '';
    const onChunk = (data) => {
      const text = data.toString();
      logStream.write(text);
      buf += text;
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) parseProgress(job, line);
      job.logTail = tail(job.logTail + text, 4000);
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);

    child.on('error', (err) => {
      logStream.end();
      touch(job, { status: 'error', stage: 'error', error: `spawn failed: ${err.message}` });
      resolve();
    });
    child.on('close', (code) => {
      logStream.end();
      if (code === 0) {
        const { analyzed, loadErrors } = summarizeRun(outDir);
        touch(job, {
          status: 'done',
          stage: 'done',
          progress: 100,
          analyzed,
          loadErrors,
          resultsUrl: `/api/runs/${job.id}/results`,
          reportUrl: reportRelUrl(job, 'report.html'),
        });
      } else {
        touch(job, {
          status: 'error',
          stage: 'error',
          error: `engine exited with code ${code}. Last output:\n${tail(job.logTail, 800)}`,
        });
      }
      resolve();
    });
  });
}

// Engine prints "[i/N] source -> target" per pair; derive progress from it.
function parseProgress(job, line) {
  const m = line.match(/^\[(\d+)\/(\d+)\]/);
  if (m) {
    const i = Number(m[1]);
    const n = Number(m[2]);
    touch(job, {
      status: 'running',
      stage: `pair ${i}/${n}`,
      pairCount: n,
      progress: Math.min(99, Math.round(((i - 1) / n) * 100) + 2),
    });
  }
}

// ---- Stub runner (WEBUI_ENGINE=stub) -----------------------------------------
function runStub(job) {
  return new Promise((resolve) => {
    const STAGES = ['crawling', 'diffing', 'scoring', 'done'];
    let i = 0;
    const tick = () => {
      if (!jobs.get(job.id)) return resolve();
      if (i >= STAGES.length - 1) {
        touch(job, {
          status: 'done',
          stage: 'done',
          progress: 100,
          resultsUrl: `/api/runs/${job.id}/results`,
        });
        return resolve();
      }
      touch(job, { status: 'running', stage: STAGES[i], progress: Math.round((i / 3) * 100) });
      i += 1;
      setTimeout(tick, 1200);
    };
    setTimeout(tick, 1000);
  });
}

// ---- Results normalization (same shape for both modes) ------------------------
function buildResults(job) {
  if (ENGINE_MODE === 'stub') {
    return {
      runId: job.id,
      label: job.label,
      mode: job.mode,
      reportUrl: null,
      pairCount: job.pairCount,
      pairs: job.pairs.map((p, i) => ({
        source: p.source,
        target: p.target,
        status: i % 3 === 0 ? 'review' : 'ok',
        note: `health ${60 + ((i * 7) % 40)}`,
      })),
    };
  }

  // Real: read the engine's summary.json and normalize it.
  const summaryPath = path.join(job.outDir, 'summary.json');
  let summary = null;
  try {
    summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
  } catch {
    /* summary may be absent on a failed capture */
  }
  const rows = (summary && summary.results) || [];
  const pairs = rows.map((r) => {
    // Thumbnail (small, generated on demand) for the <img>; full PNG for the link.
    const relOf = (side) => `pairs/${r.slug}/screenshots/${side}-full.png`;
    const hasShot = (side) => r.slug && fileExists(job, relOf(side));
    const shot = (side) =>
      hasShot(side) ? `/api/runs/${job.id}/thumb/${relOf(side)}` : null;
    const shotFull = (side) => (hasShot(side) ? reportRelUrl(job, relOf(side)) : null);
    // Per-pair: report whether it loaded/analyzed. Detailed quality (missing,
    // coverage, layout) lives in the per-pair review — a single aggregate number
    // here would be misleading across a large run.
    return {
      source: r.sourceUrl,
      target: r.targetUrl,
      status: r.captureError ? 'error' : 'ok',
      note: r.captureError ? `load error: ${String(r.captureError).slice(0, 70)}` : 'analyzed',
      reviewUrl: r.slug ? reportRelUrl(job, `pairs/${r.slug}/layout-review.html`) : null,
      sourceShot: shot('source'),
      targetShot: shot('target'),
      sourceShotFull: shotFull('source'),
      targetShotFull: shotFull('target'),
    };
  });
  return {
    runId: job.id,
    label: job.label,
    mode: job.mode,
    pairCount: pairs.length || job.pairCount,
    reportUrl: fileExists(job, 'report.html') ? reportRelUrl(job, 'report.html') : null,
    customerReportUrl: fileExists(job, 'CUSTOMER-Report.html')
      ? reportRelUrl(job, 'CUSTOMER-Report.html')
      : null,
    pairs,
  };
}

// Count pairs analyzed vs. pairs that failed to load (captureError). This is the
// one run-level aggregate that's genuinely additive across a large run.
function summarizeRun(outDir) {
  try {
    const summary = JSON.parse(fs.readFileSync(path.join(outDir, 'summary.json'), 'utf8'));
    const rows = summary.results || [];
    const loadErrors = rows.filter((r) => r.captureError).length;
    return { analyzed: rows.length - loadErrors, loadErrors };
  } catch {
    return { analyzed: null, loadErrors: null };
  }
}

// Generate (once) and serve a small top-crop JPEG thumbnail of a run screenshot.
// Full-page shots are very tall; a ~360px-wide top crop is a light glance, and the
// full image is one click away. Cached under the run's thumbs/ dir.
async function serveThumb(res, job, rel) {
  const clean = decodeURIComponent(rel).replace(/^\/+/, '');
  const srcPath = path.join(job.outDir, clean);
  if (!srcPath.startsWith(job.outDir)) return void (res.writeHead(403), res.end('Forbidden'));
  const cachePath = path.join(job.runDir, 'thumbs', `${createHash('sha1').update(clean).digest('hex')}.jpg`);
  try {
    if (!fs.existsSync(cachePath)) {
      if (!fs.existsSync(srcPath)) return void (res.writeHead(404), res.end('Not found'));
      fs.mkdirSync(path.dirname(cachePath), { recursive: true });
      await sharp(srcPath)
        .resize(360, 480, { fit: 'cover', position: 'top' })
        .jpeg({ quality: 72 })
        .toFile(cachePath);
    }
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(cachePath).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String((e && e.message) || e));
  }
}

function reportRelUrl(job, rel) {
  return `/api/runs/${job.id}/files/${rel}`;
}
function fileExists(job, rel) {
  try {
    return fs.existsSync(path.join(job.outDir, rel));
  } catch {
    return false;
  }
}

// ---- Small helpers ------------------------------------------------------------
function tail(s, n) {
  return s.length > n ? s.slice(s.length - n) : s;
}
function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20 * 1024 * 1024) reject(new Error('Body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}
// Ignore selectors arrive as an array of strings or a newline-delimited string.
function parseSelectors(input) {
  const list = Array.isArray(input) ? input : String(input || '').split(/\r?\n/);
  return list.map((s) => String(s).trim()).filter(Boolean);
}

// --- Named site recipes (git-tracked YAML in RECIPES_DIR) ----------------------
function safeRecipeName(name) {
  return String(name || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, 60);
}
// Flatten a recipe's selector rules (or bare strings) to plain selector strings
// for the form, and surface the optional UI hints (mode/threads).
function recipeToForm(name, doc) {
  const sels = (list) =>
    (Array.isArray(list) ? list : [])
      .map((r) => (typeof r === 'string' ? r : r && r.selector))
      .filter((s) => typeof s === 'string' && s.trim());
  return {
    name,
    mode: doc.mode || null,
    threads: doc.threads || null,
    site: doc.site || null, // site this recipe is for (drives the runs filter)
    ignoreSource: sels(doc.ignoreSource),
    ignoreTarget: sels(doc.ignoreTarget),
    clickSource: sels(doc.clickSource),
    clickTarget: sels(doc.clickTarget),
  };
}
function listRecipes() {
  let files = [];
  try {
    files = fs.readdirSync(RECIPES_DIR).filter((f) => /\.ya?ml$/i.test(f));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    try {
      const doc = YAML.parse(fs.readFileSync(path.join(RECIPES_DIR, f), 'utf8')) || {};
      out.push(recipeToForm(f.replace(/\.ya?ml$/i, ''), doc));
    } catch {
      /* skip an unparseable recipe */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
function saveRecipe(body) {
  const name = safeRecipeName(body.name);
  if (!name) throw new Error('Invalid recipe name');
  const rules = (input) => parseSelectors(input).map((selector) => ({ selector, reason: 'ui' }));
  const doc = {
    ignoreSource: rules(body.ignoreSource),
    ignoreTarget: rules(body.ignoreTarget),
    clickSource: rules(body.clickSource),
    clickTarget: rules(body.clickTarget),
  };
  if (body.mode) doc.mode = body.mode; // UI hints — the engine ignores unknown keys
  if (body.threads) doc.threads = Math.min(16, Math.max(1, Number(body.threads) || 1));
  if (body.site) doc.site = String(body.site).slice(0, 253);
  fs.writeFileSync(path.join(RECIPES_DIR, `${name}.yaml`), YAML.stringify(doc));
  return name;
}
function deleteRecipe(name) {
  const safe = safeRecipeName(name);
  const p = path.join(RECIPES_DIR, `${safe}.yaml`);
  if (safe && p.startsWith(RECIPES_DIR) && fs.existsSync(p)) fs.unlinkSync(p);
}
// Parse a pasted/uploaded CSV of `source,target` (comma or semicolon), skip header.
function parsePairs(csvText) {
  const pairs = [];
  for (const line of String(csvText || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/[;,]/).map((c) => c.trim());
    if (cols.length < 2 || !cols[0] || !cols[1]) continue;
    if (/^source(\s*url)?$/i.test(cols[0])) continue; // header
    pairs.push({ source: cols[0], target: cols[1] });
  }
  return pairs;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};
function serveStatic(res, baseDir, urlPath, fallback) {
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  const filePath = path.join(baseDir, rel);
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      if (fallback) return serveStatic(res, baseDir, fallback, null);
      res.writeHead(404);
      return res.end('Not found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---- Router -------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  try {
    if (pathname === '/api/health') {
      return sendJson(res, 200, {
        ok: true,
        mode: ENGINE_MODE,
        maxConcurrent: MAX_CONCURRENT,
        running: runningCount,
        queued: queue.length,
      });
    }

    // --- Saved site recipes ---
    if (pathname === '/api/recipes' && req.method === 'GET') {
      return sendJson(res, 200, { recipes: listRecipes() });
    }
    if (pathname === '/api/recipes' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const name = saveRecipe(body);
        return sendJson(res, 201, { name });
      } catch (e) {
        return sendJson(res, 400, { error: String(e.message || e) });
      }
    }
    const recipeMatch = pathname.match(/^\/api\/recipes\/([^/]+)$/);
    if (recipeMatch && req.method === 'DELETE') {
      deleteRecipe(decodeURIComponent(recipeMatch[1]));
      return sendJson(res, 200, { ok: true });
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const pairs = parsePairs(body.csv);
      if (!pairs.length) {
        return sendJson(res, 400, { error: 'No valid source,target pairs found.' });
      }
      const job = createJob({
        label: body.label,
        pairs,
        mode: body.mode,
        threads: body.threads,
        recipe: body.recipe || null,
        ignoreSource: parseSelectors(body.ignoreSource),
        ignoreTarget: parseSelectors(body.ignoreTarget),
        clickSource: parseSelectors(body.clickSource),
        clickTarget: parseSelectors(body.clickTarget),
      });
      return sendJson(res, 201, { jobId: job.id, status: job.status });
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const list = [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ pairs, runDir, outDir, logPath, logTail, pid, ...rest }) => rest);
      return sendJson(res, 200, { runs: list });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === 'GET') {
      const job = jobs.get(runMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Run not found' });
      // Single-run detail includes pairs so the UI can reload the run into the form.
      const { runDir, outDir, logPath, pid, logTail, ...rest } = job;
      return sendJson(res, 200, rest);
    }

    const resultsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/results$/);
    if (resultsMatch && req.method === 'GET') {
      const job = jobs.get(resultsMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Run not found' });
      if (job.status !== 'done') {
        return sendJson(res, 409, { error: 'Run not finished', status: job.status });
      }
      return sendJson(res, 200, buildResults(job));
    }

    // Serve a small cached thumbnail of a run screenshot (keeps the results panel
    // light — the full-size PNGs are 1-2MB each and janked the page).
    const thumbMatch = pathname.match(/^\/api\/runs\/([^/]+)\/thumb\/(.*)$/);
    if (thumbMatch && req.method === 'GET') {
      const job = jobs.get(thumbMatch[1]);
      if (!job || !job.outDir) return void (res.writeHead(404), res.end('Not found'));
      return void serveThumb(res, job, thumbMatch[2]);
    }

    // Serve a real run folder's artifacts (report.html, per-pair review, screenshots).
    const filesMatch = pathname.match(/^\/api\/runs\/([^/]+)\/files\/(.*)$/);
    if (filesMatch && req.method === 'GET') {
      const job = jobs.get(filesMatch[1]);
      if (!job || !job.outDir) return void (res.writeHead(404), res.end('Not found'));
      return serveStatic(res, job.outDir, filesMatch[2], null);
    }

    // Stub artifact fallback.
    if (/^\/api\/runs\/[^/]+\/artifacts\//.test(pathname) && req.method === 'GET') {
      return serveStatic(res, SAMPLE_RESULTS, 'placeholder.svg', null);
    }

    if (req.method === 'GET') {
      const target = pathname === '/' ? '/index.html' : pathname;
      return serveStatic(res, PUBLIC_DIR, target, '/index.html');
    }

    sendJson(res, 404, { error: 'Not found' });
  } catch (err) {
    sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

loadPersistedJobs(); // restore run history from disk before accepting requests

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[webui] http://localhost:${PORT}  (engine: ${ENGINE_MODE}, maxConcurrent: ${MAX_CONCURRENT})`
  );
});
