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
const { randomUUID } = require('crypto');

const PORT = process.env.WEBUI_PORT ? Number(process.env.WEBUI_PORT) : 4321;
const ENGINE_MODE = (process.env.WEBUI_ENGINE || 'real').toLowerCase(); // "real" | "stub"
const MAX_CONCURRENT = process.env.WEBUI_MAX_CONCURRENT
  ? Math.max(1, Number(process.env.WEBUI_MAX_CONCURRENT))
  : 2;

const PROJECT_ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLE_RESULTS = path.join(__dirname, 'sample-results');
const RUNS_DIR = path.join(__dirname, 'runs'); // per-job workspace (gitignored)

fs.mkdirSync(RUNS_DIR, { recursive: true });

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

function createJob({ label, pairs, mode, ignoreSource, ignoreTarget }) {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    label: label || `run-${new Date(now).toISOString().slice(0, 19)}`,
    mode: RUN_MODES[mode] ? mode : 'full',
    ignoreSource: ignoreSource || [],
    ignoreTarget: ignoreTarget || [],
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
  queue.push(id);
  pump();
  return job;
}

function touch(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() });
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

    const args = ['index.js', '--csv', csvPath, '--out', outDir, ...RUN_MODES[job.mode]];

    // If the run has per-side ignore selectors, emit a recipe and pass --recipe.
    // JSON is valid YAML, so we can write the recipe without a YAML dependency.
    if (job.ignoreSource.length || job.ignoreTarget.length) {
      const recipe = {
        ignoreSource: job.ignoreSource.map((selector) => ({ selector, reason: 'ui' })),
        ignoreTarget: job.ignoreTarget.map((selector) => ({ selector, reason: 'ui' })),
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
        touch(job, {
          status: 'done',
          stage: 'done',
          progress: 100,
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
  const pairs = rows.map((r) => ({
    source: r.sourceUrl,
    target: r.targetUrl,
    status: r.captureError ? 'error' : r.missingCount > 0 ? 'review' : 'ok',
    note: r.captureError
      ? String(r.captureError).slice(0, 80)
      : `${r.missingCount ?? 0} missing · ${r.finishedReason || 'done'}`,
    reviewUrl: r.slug ? reportRelUrl(job, `pairs/${r.slug}/layout-review.html`) : null,
  }));
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
        ignoreSource: parseSelectors(body.ignoreSource),
        ignoreTarget: parseSelectors(body.ignoreTarget),
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
      const { pairs, runDir, outDir, logPath, pid, ...rest } = job;
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

server.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(
    `[webui] http://localhost:${PORT}  (engine: ${ENGINE_MODE}, maxConcurrent: ${MAX_CONCURRENT})`
  );
});
