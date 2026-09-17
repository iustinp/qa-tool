#!/usr/bin/env node
/**
 * Temporary dev server for the page-pair-diff web UI.
 *
 * Purpose: let us build the web UI now, against a STUBBED job-shaped API, while
 * the deployment path (self-hosted vs. cloud) is still undecided. The UI talks to
 * this server only over HTTP and treats runs as async jobs, so the same UI drops
 * onto whichever backend wins later (see DEPLOYMENT-ARCHITECTURE.md).
 *
 * Zero dependencies (Node >= 18, built-in http/fs/path) so it runs anywhere.
 *
 * The API is a STUB: runs are faked in-memory and progress on a timer. Nothing
 * here calls the real engine yet — swapping the stub for a real `runJob(config)`
 * is the only backend change needed, with no UI changes.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');

const PORT = process.env.WEBUI_PORT ? Number(process.env.WEBUI_PORT) : 4321;
const PUBLIC_DIR = path.join(__dirname, 'public');
const SAMPLE_RESULTS = path.join(__dirname, 'sample-results');

// ---- In-memory fake job store -------------------------------------------------
/** @type {Map<string, any>} */
const jobs = new Map();

const STAGES = ['queued', 'crawling', 'diffing', 'scoring', 'done'];

function createJob({ label, pairs }) {
  const id = randomUUID();
  const now = Date.now();
  const job = {
    id,
    label: label || `run-${new Date(now).toISOString().slice(0, 19)}`,
    status: 'queued',
    stage: 'queued',
    progress: 0,
    pairCount: pairs.length,
    pairs,
    createdAt: now,
    updatedAt: now,
    error: null,
  };
  jobs.set(id, job);
  driveFakeProgress(job); // simulate async work so the UI's polling has something to watch
  return job;
}

// Advance a fake job through stages over a few seconds, so the async
// submit -> poll -> results flow is exercised end to end.
function driveFakeProgress(job) {
  let stageIdx = 0;
  const tick = () => {
    const current = jobs.get(job.id);
    if (!current) return; // deleted
    stageIdx += 1;
    if (stageIdx >= STAGES.length - 1) {
      current.stage = 'done';
      current.status = 'done';
      current.progress = 100;
      current.updatedAt = Date.now();
      current.resultsUrl = `/api/runs/${current.id}/results`;
      return;
    }
    current.stage = STAGES[stageIdx];
    current.status = 'running';
    current.progress = Math.round((stageIdx / (STAGES.length - 1)) * 100);
    current.updatedAt = Date.now();
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 1200);
}

// ---- Tiny helpers -------------------------------------------------------------
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
    req.on('data', (c) => chunks.push(c));
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

// Parse a pasted CSV of `source,target` (comma or semicolon), skipping a header.
function parsePairs(csvText) {
  const pairs = [];
  const lines = String(csvText || '').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const cols = trimmed.split(/[;,]/).map((c) => c.trim());
    if (cols.length < 2) continue;
    if (/^source$/i.test(cols[0]) || cols[0].toLowerCase() === 'source url') continue; // header
    pairs.push({ source: cols[0], target: cols[1] });
  }
  return pairs;
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

function serveStatic(res, baseDir, urlPath, fallback) {
  // Prevent path traversal; resolve within baseDir only.
  const rel = decodeURIComponent(urlPath).replace(/^\/+/, '');
  let filePath = path.join(baseDir, rel);
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
    // --- Job API (the contract the UI depends on) ---
    if (pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, mode: 'stub' });
    }

    if (pathname === '/api/runs' && req.method === 'POST') {
      const body = await readBody(req);
      const pairs = parsePairs(body.csv);
      if (!pairs.length) {
        return sendJson(res, 400, { error: 'No valid source,target pairs found.' });
      }
      const job = createJob({ label: body.label, pairs });
      return sendJson(res, 201, { jobId: job.id, status: job.status });
    }

    if (pathname === '/api/runs' && req.method === 'GET') {
      const list = [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(({ pairs, ...rest }) => rest);
      return sendJson(res, 200, { runs: list });
    }

    const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && req.method === 'GET') {
      const job = jobs.get(runMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Run not found' });
      const { pairs, ...rest } = job;
      return sendJson(res, 200, rest);
    }

    const resultsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/results$/);
    if (resultsMatch && req.method === 'GET') {
      const job = jobs.get(resultsMatch[1]);
      if (!job) return sendJson(res, 404, { error: 'Run not found' });
      if (job.status !== 'done') {
        return sendJson(res, 409, { error: 'Run not finished', status: job.status });
      }
      // STUB: return canned results shaped like a real run summary.
      const results = {
        runId: job.id,
        label: job.label,
        pairCount: job.pairCount,
        pairs: job.pairs.map((p, i) => ({
          index: i,
          source: p.source,
          target: p.target,
          health: 60 + ((i * 7) % 40), // fake 0-100 health score
          verdict: i % 3 === 0 ? 'review' : 'ok',
          // artifacts addressed by URL, not local path (disk today, S3 tomorrow):
          screenshot: `/api/runs/${job.id}/artifacts/pair-${i}.png`,
        })),
      };
      return sendJson(res, 200, results);
    }

    // Artifact serving stub — canned sample image for every request.
    const artMatch = pathname.match(/^\/api\/runs\/[^/]+\/artifacts\/(.+)$/);
    if (artMatch && req.method === 'GET') {
      return serveStatic(res, SAMPLE_RESULTS, 'placeholder.svg', null);
    }

    // --- Static UI ---
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
  console.log(`[webui] stub server on http://localhost:${PORT}  (API mode: stub)`);
});
