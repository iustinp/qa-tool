/* UI logic. Knows nothing about the backend beyond the API contract in api.js. */
(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    modeBadge: $('#modeBadge'),
    label: $('#labelInput'),
    pairs: $('#pairsInput'),
    modeSelect: $('#modeSelect'),
    ignoreSource: $('#ignoreSource'),
    ignoreTarget: $('#ignoreTarget'),
    clickSource: $('#clickSource'),
    clickTarget: $('#clickTarget'),
    browseBtn: $('#browseBtn'),
    csvFile: $('#csvFile'),
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
      const toLines = (v) => v.split('\n').map((s) => s.trim()).filter(Boolean);
      const { jobId } = await API.createRun({
        label: els.label.value.trim(),
        csv,
        mode: els.modeSelect.value,
        ignoreSource: toLines(els.ignoreSource.value),
        ignoreTarget: toLines(els.ignoreTarget.value),
        clickSource: toLines(els.clickSource.value),
        clickTarget: toLines(els.clickTarget.value),
      });
      els.startMsg.textContent = `Started (${jobId.slice(0, 8)}…)`;
      // Keep the pairs, label, and ignore/click selectors in place so the run can
      // be tweaked and resubmitted without re-entering everything.
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
    document.querySelector('.layout').classList.add('show-results');
    els.resultsBody.innerHTML = '<p class="empty">Loading…</p>';
    try {
      const data = await API.getResults(jobId);
      els.resultsTitle.textContent = `Results — ${data.label || jobId.slice(0, 8)}`;
      const reportLinks = [];
      if (data.reportUrl)
        reportLinks.push(`<a class="report-link" href="${data.reportUrl}" target="_blank">Open full report ↗</a>`);
      if (data.customerReportUrl)
        reportLinks.push(`<a class="report-link" href="${data.customerReportUrl}" target="_blank">Customer report ↗</a>`);
      const header = reportLinks.length
        ? `<div class="report-links">${reportLinks.join('')}</div>`
        : '';
      els.resultsBody.innerHTML =
        header +
        data.pairs
          .map(
            (p) => `
        <div class="pair">
          <div class="pair-info">
            <div class="pair-urls">
              <div class="u"><span>src</span> ${escapeHtml(p.source)}</div>
              <div class="u"><span>tgt</span> ${escapeHtml(p.target)}</div>
            </div>
            <div class="pair-scores">
              <span class="verdict ${p.status}">${p.status}</span>
              <span class="note">${escapeHtml(p.note || '')}</span>
              ${p.reviewUrl ? `<a class="report-link" href="${p.reviewUrl}" target="_blank">review ↗</a>` : ''}
            </div>
            ${
              p.sourceShot || p.targetShot
                ? `<div class="shots">
                     ${p.sourceShot ? `<a class="shot" href="${p.sourceShot}" target="_blank"><span>source</span><img loading="lazy" src="${p.sourceShot}" alt="source" /></a>` : ''}
                     ${p.targetShot ? `<a class="shot" href="${p.targetShot}" target="_blank"><span>target</span><img loading="lazy" src="${p.targetShot}" alt="target" /></a>` : ''}
                   </div>`
                : ''
            }
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

  // Browse: read chosen CSV file(s) client-side into the textarea.
  // Works in any browser and stays path-agnostic (no server upload needed).
  els.browseBtn.addEventListener('click', () => els.csvFile.click());
  els.csvFile.addEventListener('change', async () => {
    const files = [...els.csvFile.files];
    if (!files.length) return;
    try {
      const texts = await Promise.all(files.map((f) => f.text()));
      const merged = texts.join('\n').trim();
      // If the label is empty and a single file was picked, seed it from the filename.
      if (!els.label.value.trim() && files.length === 1) {
        els.label.value = files[0].name.replace(/\.csv$/i, '');
      }
      els.pairs.value = els.pairs.value.trim()
        ? `${els.pairs.value.trim()}\n${merged}`
        : merged;
      els.startMsg.textContent = `Loaded ${files.length} file(s).`;
    } catch (e) {
      els.startMsg.textContent = `Could not read file: ${e.message}`;
    } finally {
      els.csvFile.value = ''; // allow re-selecting the same file
    }
  });

  // Wire up
  els.startBtn.addEventListener('click', startRun);
  els.refreshBtn.addEventListener('click', refreshRuns);
  els.closeResults.addEventListener('click', () => {
    els.results.hidden = true;
    document.querySelector('.layout').classList.remove('show-results');
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
