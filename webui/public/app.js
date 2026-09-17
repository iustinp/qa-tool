/* UI logic. Knows nothing about the backend beyond the API contract in api.js. */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    modeBadge: $('#modeBadge'),
    label: $('#labelInput'),
    pairs: $('#pairsInput'),
    startBtn: $('#startBtn'),
    startMsg: $('#startMsg'),
    refreshBtn: $('#refreshBtn'),
    runsList: $('#runsList'),
    results: $('#results'),
    resultsTitle: $('#resultsTitle'),
    resultsBody: $('#resultsBody'),
    closeResults: $('#closeResults'),
  };

  // Jobs we are actively polling: jobId -> intervalId
  const polling = new Map();

  function fmtTime(ts) {
    return new Date(ts).toLocaleString();
  }

  function statusClass(status) {
    if (status === 'done') return 'ok';
    if (status === 'error') return 'err';
    if (status === 'running') return 'run';
    return 'queued';
  }

  function renderRuns(runs) {
    if (!runs.length) {
      els.runsList.innerHTML = '<p class="empty">No runs yet. Start one above.</p>';
      return;
    }
    els.runsList.innerHTML = runs
      .map(
        (r) => `
      <div class="run" data-id="${r.id}">
        <div class="run-main">
          <div class="run-label">${escapeHtml(r.label)}</div>
          <div class="run-meta">${r.pairCount} pair(s) · ${fmtTime(r.createdAt)}</div>
        </div>
        <div class="run-side">
          <span class="status ${statusClass(r.status)}">${r.stage || r.status}</span>
          <div class="bar"><div class="bar-fill" style="width:${r.progress || 0}%"></div></div>
          ${
            r.status === 'done'
              ? `<button class="ghost view-btn" data-id="${r.id}">View</button>`
              : ''
          }
        </div>
      </div>`
      )
      .join('');

    // Keep polling any run that isn't finished.
    runs.forEach((r) => {
      if (r.status !== 'done' && r.status !== 'error' && !polling.has(r.id)) {
        startPolling(r.id);
      }
    });
    els.runsList.querySelectorAll('.view-btn').forEach((b) =>
      b.addEventListener('click', () => openResults(b.dataset.id))
    );
  }

  function startPolling(jobId) {
    const iv = setInterval(async () => {
      try {
        const job = await API.getRun(jobId);
        if (job.status === 'done' || job.status === 'error') {
          clearInterval(iv);
          polling.delete(jobId);
        }
        await refreshRuns(); // cheap; re-renders bars/status
      } catch (e) {
        clearInterval(iv);
        polling.delete(jobId);
      }
    }, 1200);
    polling.set(jobId, iv);
  }

  async function refreshRuns() {
    const { runs } = await API.listRuns();
    renderRuns(runs);
  }

  async function startRun() {
    els.startMsg.textContent = '';
    const csv = els.pairs.value.trim();
    if (!csv) {
      els.startMsg.textContent = 'Add at least one source,target line.';
      return;
    }
    els.startBtn.disabled = true;
    try {
      const { jobId } = await API.createRun({ label: els.label.value.trim(), csv });
      els.startMsg.textContent = `Started (${jobId.slice(0, 8)}…)`;
      els.pairs.value = '';
      els.label.value = '';
      await refreshRuns();
      startPolling(jobId);
    } catch (e) {
      els.startMsg.textContent = e.message;
    } finally {
      els.startBtn.disabled = false;
    }
  }

  async function openResults(jobId) {
    els.results.hidden = false;
    els.resultsBody.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const data = await API.getResults(jobId);
      els.resultsTitle.textContent = `Results — ${data.label || jobId.slice(0, 8)}`;
      els.resultsBody.innerHTML = data.pairs
        .map(
          (p) => `
        <div class="pair">
          <img class="thumb" src="${p.screenshot}" alt="pair ${p.index}" />
          <div class="pair-info">
            <div class="pair-urls">
              <div class="u"><span>src</span> ${escapeHtml(p.source)}</div>
              <div class="u"><span>tgt</span> ${escapeHtml(p.target)}</div>
            </div>
            <div class="pair-scores">
              <span class="health h${Math.floor(p.health / 20)}">health ${p.health}</span>
              <span class="verdict ${p.verdict}">${p.verdict}</span>
            </div>
          </div>
        </div>`
        )
        .join('');
    } catch (e) {
      els.resultsBody.innerHTML = `<p class="empty">${escapeHtml(e.message)}</p>`;
    }
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  // Wire up
  els.startBtn.addEventListener('click', startRun);
  els.refreshBtn.addEventListener('click', refreshRuns);
  els.closeResults.addEventListener('click', () => {
    els.results.hidden = true;
  });

  (async () => {
    try {
      const h = await API.health();
      els.modeBadge.textContent = `mode: ${h.mode}`;
      els.modeBadge.classList.toggle('stub', h.mode === 'stub');
    } catch {
      els.modeBadge.textContent = 'offline';
    }
    await refreshRuns();
  })();
})();
